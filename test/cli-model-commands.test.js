import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Covers the CLI wiring of `models`, `explain` and `doctor` in src/index.js:
// dispatch, flag parsing, stdout/stderr split, and the exit codes automation
// depends on. The command bodies are thin — the logic is unit-tested in
// model-namespace / route-explain / config-doctor — so what is asserted here is
// exactly what those unit tests cannot see.
//
// Every run gets TEAMCLAUDE_CONFIG pointed at a fixture in a tmpdir, and a cwd
// inside that tmpdir, so no real config and no real settings file is read. None
// of these commands opens a socket: they are answered entirely from the config
// file, which is the property that makes them usable while a server is running.

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

const FIXTURE = {
  proxy: { port: 39999, apiKey: 'fixture' },
  accounts: [
    {
      name: 'primary', type: 'oauth', priority: 0,
      accountUuid: 'acct-primary', orgUuid: 'org-primary',
    },
    {
      name: 'deepseek-v4-pro', type: 'apikey', apiKey: 'k', priority: 80,
      accountUuid: 'acct-deepseek', orgUuid: 'org-deepseek',
      upstream: 'http://127.0.0.1:8084',
      modelMap: { 'claude-opus-4-8': 'deepseek-v4-pro', 'claude-fable-5': 'deepseek-v4-pro' },
    },
  ],
  routes: [
    { name: 'opus', match: ['*opus*'], accounts: ['primary'] },
    { name: 'default', match: ['*'], accounts: ['primary'] },
  ],
};

async function withCli(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cli-models-'));
  const configPath = join(dir, 'teamclaude.json');
  const settingsPath = join(dir, 'settings.json');
  await mkdir(join(dir, 'work'), { recursive: true });
  await writeFile(configPath, JSON.stringify(FIXTURE, null, 2));
  await writeFile(settingsPath, JSON.stringify({ availableModels: ['claude-opus-4-8'] }));

  // cwd inside the tmpdir and CLAUDE_CONFIG_DIR pointed at it: no tier of the
  // real ~/.claude is reachable from here.
  const spawnCli = (argv, envPatch = {}) => spawnSync(process.execPath, [CLI, ...argv], {
    cwd: join(dir, 'work'),
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAMCLAUDE_CONFIG: configPath,
      CLAUDE_CONFIG_DIR: join(dir, 'work'),
      ...envPatch,
    },
  });
  const run = (...argv) => spawnCli(argv);
  const runWithEnv = (envPatch, ...argv) => spawnCli(argv, envPatch);

  try {
    await fn({ dir, configPath, settingsPath, run, runWithEnv });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── models ────────────────────────────────────────────────────

test('`models` puts the ids on stdout and every caveat on stderr, so it stays pipeable', async () => {
  await withCli(async ({ run }) => {
    const r = run('models');
    assert.equal(r.status, 0);
    const ids = r.stdout.trim().split('\n');
    assert.deepEqual(ids, ['claude-fable-5', 'claude-opus-4-8']);
    assert.ok(!r.stdout.includes('#'), 'commentary must not poison a pipe');
    assert.match(r.stderr, /never as "all available models"/,
      'the list is a subset by construction and has to say so');
  });
});

test('`models --json` emits the whole namespace object, notes included', async () => {
  await withCli(async ({ run }) => {
    const r = run('models', '--json');
    assert.equal(r.status, 0);
    const ns = JSON.parse(r.stdout);
    assert.deepEqual(ns.concrete, ['claude-fable-5', 'claude-opus-4-8']);
    assert.deepEqual(ns.patterns, ['*opus*', '*']);
    assert.ok(ns.notes.length > 0);
  });
});

// ── explain ───────────────────────────────────────────────────

test('`explain` with no model prints usage and exits 1', async () => {
  await withCli(async ({ run }) => {
    const r = run('explain');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: teamclaude explain <model>/);
    assert.equal(r.stdout, '');
  });
});

test('`explain <model>` prints the decision trace, and --json round-trips it', async () => {
  await withCli(async ({ run }) => {
    const text = run('explain', 'claude-opus-4-8');
    assert.equal(text.status, 0);
    assert.match(text.stdout, /^model: claude-opus-4-8$/m);
    assert.match(text.stdout, /verdict {5}: ROUTABLE/);
    assert.match(text.stdout, /route {7}: "opus"/);

    const json = run('explain', 'claude-opus-4-8', '--json');
    assert.equal(json.status, 0);
    const trace = JSON.parse(json.stdout);
    assert.equal(trace.model, 'claude-opus-4-8');
    assert.equal(trace.route.matched.name, 'opus');
    assert.equal(trace.verdict.routable, true);
  });
});

test('`explain` on an account name reports NOT ROUTABLE and points at --account', async () => {
  await withCli(async ({ run }) => {
    const r = run('explain', 'deepseek-v4-pro');
    assert.equal(r.status, 0, 'explain reports; it is doctor and run that fail');
    assert.match(r.stdout, /verdict {5}: NOT ROUTABLE/);
    assert.match(r.stdout, /teamclaude run --account deepseek-v4-pro/);
  });
});

test('`explain --account` shows the pinned path: one account, no failover', async () => {
  await withCli(async ({ run }) => {
    const r = run('explain', 'claude-opus-4-8', '--account', 'deepseek-v4-pro', '--json');
    const trace = JSON.parse(r.stdout);
    assert.equal(trace.pin.resolved, true);
    assert.equal(trace.pin.name, 'deepseek-v4-pro');
    assert.deepEqual(trace.candidates.map(c => c.name), ['deepseek-v4-pro']);
    assert.equal(trace.fallback.pinned, true);
    assert.ok(trace.warnings.some(w => w.code === 'pin-outside-routing'),
      'the pin reaches an account the routing rules would never pick — that is the point of it');
  });
});

// ── doctor ────────────────────────────────────────────────────

test('`doctor` exits 3 on errors and names the defects, without touching the settings file', async () => {
  await withCli(async ({ run, settingsPath }) => {
    const before = await readFile(settingsPath, 'utf8');
    const r = run('doctor', '--claude-settings', settingsPath);
    assert.equal(r.status, 3, '3 = errors found; documented in help for cron');
    assert.match(r.stdout, /modelmap-key-unreachable/);
    assert.match(r.stdout, /account-name-not-routable/);
    assert.match(r.stdout, /exit 3/);
    assert.equal(await readFile(settingsPath, 'utf8'), before, 'read-only, always');
  });
});

test('`doctor --json` puts machine output on stdout and keeps the exit code', async () => {
  await withCli(async ({ run, settingsPath }) => {
    const r = run('doctor', '--json', '--claude-settings', settingsPath);
    assert.equal(r.status, 3);
    const out = JSON.parse(r.stdout);
    assert.equal(out.exitCode, 3);
    assert.ok(out.findings.some(f => f.code === 'modelmap-key-unreachable'));
    assert.equal(out.clientAllowlist.entries, 1);
    assert.equal(out.clientAllowlist.sources[0].path, settingsPath);
  });
});

test('`doctor` on a clean config exits 0', async () => {
  await withCli(async ({ run, configPath }) => {
    await writeFile(configPath, JSON.stringify({
      proxy: { port: 39999, apiKey: 'fixture' },
      accounts: [{ name: 'primary', type: 'oauth', priority: 0 }],
      routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
    }));
    const r = run('doctor');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No problems found/);
  });
});

test('`doctor --strict` turns warnings into a failing exit code', async () => {
  await withCli(async ({ run, configPath }) => {
    await writeFile(configPath, JSON.stringify({
      proxy: { port: 39999, apiKey: 'fixture' },
      accounts: [
        { name: 'primary', type: 'oauth', priority: 0 },
        { name: 'kimi', type: 'apikey', apiKey: 'k', priority: 50, models: ['claude-haiku-4-5'] },
      ],
      routes: [{ name: 'default', match: ['*'], accounts: ['primary', 'kimi'] }],
    }));
    assert.equal(run('doctor').status, 2, 'warnings alone are exit 2');
    assert.equal(run('doctor', '--strict').status, 3);
  });
});

test('a missing config is exit 1 — "could not run", not "config is bad"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cli-noconfig-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TEAMCLAUDE_CONFIG: join(dir, 'absent.json'), CLAUDE_CONFIG_DIR: dir },
    });
    assert.equal(r.status, 1, 'automation must be able to tell a broken invocation from a broken config');
    assert.match(r.stderr, /No config found/);
    for (const cmd of ['models', 'explain']) {
      const q = spawnSync(process.execPath, [CLI, cmd, 'claude-opus-4-8'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, TEAMCLAUDE_CONFIG: join(dir, 'absent.json'), CLAUDE_CONFIG_DIR: dir },
      });
      assert.equal(q.status, 1, `${cmd} must not create a config as a side effect of being asked a question`);
    }
    const after = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(after.status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── run: the launch path the whole fleet goes through ─────────
//
// These exercise the real dispatch in runCommand with the proxy DOWN and no
// --auto-fallback, so the process always stops at "Proxy not running" and claude
// is never spawned. What is being asserted is everything that happens BEFORE
// that point: whether the preflight refused the launch, and whether it refused
// it for a reason that governs the launch.

const RUN_PORT = 45291;               // deliberately not the 39999 the other fixtures use

function runFixture(port) {
  return { ...FIXTURE, proxy: { port, apiKey: 'fixture' } };
}

async function withRun(fn, configPatch = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cli-run-'));
  const configPath = join(dir, 'teamclaude.json');
  await mkdir(join(dir, 'work'), { recursive: true });
  await writeFile(configPath, JSON.stringify({ ...runFixture(RUN_PORT), ...configPatch }, null, 2));
  await writeFile(join(dir, 'work', 'settings.json'), JSON.stringify({ availableModels: ['claude-opus-4-8'] }));

  // PATH holds nothing, so even an unexpected spawn cannot reach a real claude.
  // TC_ACCT cleared so a dirty parent env cannot pin these launches by accident.
  const baseEnv = {
    ...process.env,
    PATH: join(dir, 'nothing'),
    TEAMCLAUDE_CONFIG: configPath,
    CLAUDE_CONFIG_DIR: join(dir, 'work'),
    TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
    ANTHROPIC_MODEL: '',
    TC_ACCT: '',
  };
  const spawnRun = (argv, envPatch = {}) => spawnSync(process.execPath, [CLI, 'run', ...argv], {
    cwd: join(dir, 'work'),
    encoding: 'utf8',
    env: { ...baseEnv, ...envPatch },
  });
  const run = (...argv) => spawnRun(argv);
  const runWithEnv = (envPatch, ...argv) => spawnRun(argv, envPatch);
  try {
    await fn({ dir, configPath, run, runWithEnv });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('THE regression this branch exists to prevent: a wrapper\'s two-flag argv is NOT refused', async () => {
  await withRun(async ({ run }) => {
    // Byte-for-byte the shape a real wrapper template emits for
    // a routine model override: the template appends `--model opus` to
    // every new session and the caller's args land after it.
    const r = run('--', '--dangerously-skip-permissions', '--model', 'opus', '-n', 'sess',
      '--model', 'claude-opus-4-8');
    assert.ok(!r.stderr.includes('Refusing to launch'),
      'a wrapper-appended second --model must never fail a launch — the fleet respawns these automatically');
    assert.match(r.stderr, /WARNING: 2 --model flags/, 'but it IS reported');
    assert.match(r.stderr, /Proxy not running/, 'the run got all the way past the preflight');
  });
});

test('a --auto-fallback direct launch is not refused on routing rules it will never consult', async () => {
  await withRun(async ({ run }) => {
    // The proxy is down, so --auto-fallback runs claude straight at the upstream
    // on the user's own credential: blockedModels, routes and models[] govern
    // nothing. (PATH is empty, so the spawn fails with ENOENT — which is proof
    // enough that the launch was ATTEMPTED rather than refused.)
    const r = run('--auto-fallback', '--', '--model', 'claude-fable-5');
    assert.ok(!r.stderr.includes('Refusing to launch'));
    assert.match(r.stderr, /launching claude directly/);
    assert.match(r.stderr, /Claude Code not found in PATH/, 'it got as far as spawning');
    assert.match(r.stderr, /govern nothing here/, 'and said why routing was not checked');
  }, { blockedModels: ['*fable*'] });
});

test('a model that provably cannot route still blocks, and the refusal is a working instruction', async () => {
  await withRun(async ({ run }) => {
    const r = run('--', '--model', 'deepseek-v4-pro');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR: --model "deepseek-v4-pro" cannot be served/);
    assert.match(r.stderr, /Refusing to launch/);
    assert.match(r.stderr, /teamclaude run --force -- /);
    assert.match(r.stderr, /BEFORE the `--`/);
    assert.ok(!r.stderr.includes('Proxy not running'), 'it stopped at the preflight');

    const forced = run('--force', '--', '--model', 'deepseek-v4-pro');
    assert.ok(!forced.stderr.includes('Refusing to launch'));
    assert.match(forced.stderr, /--force was passed/, 'the override is recorded, not hidden');
  });
});

test('run --account is judged against the pinned account, not the routing table it bypasses', async () => {
  await withRun(async ({ run }) => {
    // route "opus" excludes deepseek-v4-pro, and the catch-all excludes it too,
    // so the UNPINNED verdict for claude-opus-4-8 never selects it. The pin does,
    // and the proxy would serve it — so the launch must not be refused.
    const r = run('--account', 'deepseek-v4-pro', '--', '--model', 'claude-opus-4-8');
    assert.ok(!r.stderr.includes('Refusing to launch'));
    assert.match(r.stderr, /WARNING: account "deepseek-v4-pro" is pinned/);
    assert.match(r.stderr, /Proxy not running/);
  });
});

// ── D12: bare TC_ACCT preflight pin parity with --account ─────
//
// TC_ACCT is the sole pin mechanism; --account is sugar. Preflight must treat
// them identically. Before D12, bare TC_ACCT left accountPin=null and judged
// the unpinned routing table — wrong in both directions.

test('D12: bare TC_ACCT allows a model the pinned account can serve that routing candidates cannot', async () => {
  // primary is the only routing candidate and is disabled → unpinned refuses.
  // Pinning deepseek-v4-pro (has modelMap for opus) must allow — the defect was
  // bare TC_ACCT judging the unpinned table and refusing here.
  await withRun(async ({ run, runWithEnv }) => {
    const unpinned = run('--', '--model', 'claude-opus-4-8');
    assert.equal(unpinned.status, 1);
    assert.match(unpinned.stderr, /Refusing to launch/);

    const r = runWithEnv({ TC_ACCT: 'deepseek-v4-pro' }, '--', '--model', 'claude-opus-4-8');
    assert.ok(!r.stderr.includes('Refusing to launch'),
      `bare TC_ACCT must pin preflight; got:\n${r.stderr}`);
    assert.match(r.stderr, /WARNING: account "deepseek-v4-pro" is pinned/);
    assert.match(r.stderr, /Proxy not running/);
  }, {
    accounts: [
      {
        name: 'primary', type: 'oauth', priority: 0, disabled: true,
        accountUuid: 'acct-primary', orgUuid: 'org-primary',
      },
      {
        name: 'deepseek-v4-pro', type: 'apikey', apiKey: 'k', priority: 80,
        accountUuid: 'acct-deepseek', orgUuid: 'org-deepseek',
        upstream: 'http://127.0.0.1:8084',
        modelMap: { 'claude-opus-4-8': 'deepseek-v4-pro', 'claude-fable-5': 'deepseek-v4-pro' },
      },
    ],
  });
});

test('D12: bare TC_ACCT refuses a model the pinned account cannot serve that candidates can', async () => {
  // Closed adapter pin: primary (oauth) serves claude-opus-4-8 via routes;
  // deepseek is strictModelMap and cannot translate that id.
  await withRun(async ({ run, runWithEnv }) => {
    const unpinned = run('--', '--model', 'claude-opus-4-8');
    assert.ok(!unpinned.stderr.includes('Refusing to launch'),
      'unpinned candidates must be able to serve so the refuse is pin-specific');

    const r = runWithEnv({ TC_ACCT: 'deepseek-v4-pro' }, '--', '--model', 'claude-opus-4-8');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Refusing to launch/);
    assert.match(r.stderr, /cannot be served by the pinned account|closed adapter/);
  }, {
    accounts: [
      {
        name: 'primary', type: 'oauth', priority: 0,
        accountUuid: 'acct-primary', orgUuid: 'org-primary',
      },
      {
        name: 'deepseek-v4-pro', type: 'apikey', apiKey: 'k', priority: 80,
        accountUuid: 'acct-deepseek', orgUuid: 'org-deepseek',
        upstream: 'http://127.0.0.1:8084',
        strictModelMap: true,
        acceptsModels: ['deepseek-v4-pro'],
        modelMap: { 'other-model': 'deepseek-v4-pro' },
      },
    ],
    routes: [
      { name: 'opus', match: ['*opus*'], accounts: ['primary'] },
      { name: 'default', match: ['*'], accounts: ['primary'] },
    ],
  });
});

test('D12: --account and bare TC_ACCT produce byte-identical preflight decisions', async () => {
  await withRun(async ({ run, runWithEnv }) => {
    const viaFlag = run('--account', 'deepseek-v4-pro', '--', '--model', 'claude-opus-4-8');
    const viaEnv = runWithEnv({ TC_ACCT: 'deepseek-v4-pro' }, '--', '--model', 'claude-opus-4-8');
    assert.equal(viaFlag.status, viaEnv.status, 'exit parity');
    // Strip the pin-origin narration ("--account X → TC_ACCT" vs bare "TC_ACCT")
    // and the proxy-down line — preflight findings must match exactly.
    const preflightOnly = (stderr) => stderr
      .split('\n')
      .filter((l) => /\[TeamClaude\] (ERROR|WARNING|INFO):/.test(l)
        || l.includes('Refusing to launch')
        || l.includes('--force was passed'))
      .join('\n');
    assert.equal(preflightOnly(viaFlag.stderr), preflightOnly(viaEnv.stderr),
      `preflight parity failed.\n--account:\n${viaFlag.stderr}\nTC_ACCT:\n${viaEnv.stderr}`);
  });
});

test('D12: unresolvable bare TC_ACCT fails loud at launch (never preflight-as-unpinned)', async () => {
  await withRun(async ({ runWithEnv }) => {
    const r = runWithEnv({ TC_ACCT: 'not-a-real-pin' }, '--', '--model', 'claude-opus-4-8');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown account pin "not-a-real-pin"/);
    assert.doesNotMatch(r.stderr, /Refusing to launch|model-not-routable|Proxy not running/,
      'must die at pin resolution, before unpinned preflight can mis-judge');
  });
});

test('run --account accepts every stable TC_ACCT identity form', async () => {
  await withRun(async ({ run }) => {
    const cases = [
      ['acct-deepseek', 'accountUuid'],
      ['org-deepseek', 'orgUuid'],
      ['acct-deepseek/org-deepseek', 'qualified accountUuid/orgUuid'],
      ['DEEPSEEK-V4-PRO', 'case-insensitive display name'],
    ];
    for (const [pin, form] of cases) {
      const r = run('--account', pin, '--', '--model', 'claude-opus-4-8');
      assert.ok(!r.stderr.includes('No account named'), `${form} must resolve: ${r.stderr}`);
      assert.ok(!r.stderr.includes('Refusing to launch'), `${form} must reach pinned preflight: ${r.stderr}`);
      assert.match(r.stderr, /WARNING: account "deepseek-v4-pro" is pinned/, form);
      assert.match(r.stderr, /Proxy not running/, `${form} passed validation without touching a daemon`);
    }
  });
});

test('run --account rejects numeric rotation indexes because TC_ACCT does', async () => {
  await withRun(async ({ run }) => {
    const r = run('--account', '1', '--', '--model', 'claude-opus-4-8');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown account pin "1"/);
    assert.doesNotMatch(r.stderr, /index out of range|address one by index/,
      'array position is unstable identity; deleting account 0 must not silently repoint pin 1');
  });
});

test('env TC_ACCT validation uses the same UUID/qualified resolver as the server', async () => {
  await withCli(async ({ runWithEnv }) => {
    for (const pin of ['acct-deepseek', 'org-deepseek', 'acct-deepseek/org-deepseek']) {
      const r = runWithEnv({ TC_ACCT: pin }, 'env', '--no-mitm');
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /warning: unknown account pin/,
        `valid TC_ACCT pin ${pin} must not emit a false warning`);
      assert.match(r.stderr, new RegExp(`pinned to account "${pin.replace('/', '\\/')}"`));
    }
  });
});

test('env TC_ACCT still warns on a genuinely unknown pin', async () => {
  await withCli(async ({ runWithEnv }) => {
    const r = runWithEnv({ TC_ACCT: 'not-a-real-pin' }, 'env', '--no-mitm');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning: unknown account pin "not-a-real-pin"/,
      'the eval-safe warn-not-fail path must still fire for a pin that resolves to nothing');
  });
});

test('run --account=<name> pins, and an unknown flag before the -- is refused instead of dropped', async () => {
  await withRun(async ({ run }) => {
    const eq = run('--account=nope', '--', '-p', 'hi');
    assert.equal(eq.status, 1);
    assert.match(eq.stderr, /Unknown account pin "nope"/,
      'the equals form used to parse as "no pin", launching an UNPINNED session in silence');

    const typo = run('--acount', 'primary', '--', '-p', 'hi');
    assert.equal(typo.status, 1);
    assert.match(typo.stderr, /Unknown flag\(s\) for 'teamclaude run': --acount/);
    assert.match(typo.stderr, /Valid flags before the --/);
  });
});

test('help lists the three commands and documents the doctor exit codes', async () => {
  await withCli(async ({ run }) => {
    const r = run('help');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ {2}models \[--json] {5}List the model ids/m,
      'help columns are aligned at 23, like every other entry');
    assert.match(r.stdout, /^ {2}explain <model> {5}Show how a request/m);
    assert.match(r.stdout, /^ {2}doctor \[--json] {5}Check routes/m);
    assert.match(r.stdout, /exits 0 clean, 2 warnings, 3 errors, and 1 when it could not run/);
    assert.match(r.stdout, /--account NAME/);
  });
});

// ── env: stable pin emission + shell-safe eval hint (D4e) ─────

test('D4e: `env --account` emits the uuid pin form, not the mutable display name', async () => {
  await withCli(async ({ run }) => {
    const r = run('env', '--account', 'primary');
    assert.equal(r.status, 0);
    // Qualified accountUuid/orgUuid is what a rename cannot silently repoint.
    assert.match(r.stdout, /acct-primary%2Forg-primary/,
      'emitted proxy URL must carry the stable uuid pin (/-encoded in userinfo)');
    assert.ok(!r.stdout.includes('primary@') && !/proxy=http:\/\/primary[:@]/.test(r.stdout),
      'display name must not be the emitted pin when uuids exist');
    assert.match(r.stderr, /--account 'acct-primary\/org-primary'/,
      'suggested eval must re-pin with the same stable form');
  });
});

test('D4e: `env --account` falls back to the display name only when no uuid exists', async () => {
  await withCli(async ({ configPath, run }) => {
    const cfg = {
      ...FIXTURE,
      accounts: [
        { name: "work's desk", type: 'apikey', apiKey: 'k', priority: 0 },
        ...FIXTURE.accounts,
      ],
    };
    await writeFile(configPath, JSON.stringify(cfg, null, 2));
    const r = run('env', '--account', "work's desk");
    assert.equal(r.status, 0);
    // Name is the only identity; it must still appear (percent-encoded) in the URL.
    assert.match(r.stdout, /work%27s%20desk/);
    // Single-quote wrap with internal-quote escaping: 'work'\''s desk'
    assert.match(r.stderr, /--account 'work'\\''s desk'/,
      'spaces/metacharacters in the suggested eval must be shell-quoted');
  });
});

// ── run: stable pin emission parity with env (D4f) ────────────
//
// envCommand already emits stableAccountPin(); runCommand must too. A stub
// listener makes isProxyUp true so the pin is written into the child env, and
// a fake `claude` on PATH echoes ANTHROPIC_BASE_URL so we observe the emission
// without a real daemon or Claude Code.

async function withRunEmission(fn, configPatch = {}) {
  const stub = createServer((_req, res) => { res.writeHead(204); res.end(); });
  const port = await new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => resolve(stub.address().port));
  });

  const dir = await mkdtemp(join(tmpdir(), 'tc-cli-run-emit-'));
  const binDir = join(dir, 'bin');
  const workDir = join(dir, 'work');
  const configPath = join(dir, 'teamclaude.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    ...runFixture(port),
    ...configPatch,
  }, null, 2));
  await writeFile(join(workDir, 'settings.json'), JSON.stringify({ availableModels: ['claude-opus-4-8'] }));
  const claudeShim = join(binDir, 'claude');
  // Shebang uses this process's node: PATH is only binDir (so `claude` resolves
  // to the shim), which would make `#!/usr/bin/env node` miss the real binary.
  await writeFile(claudeShim,
    `#!${process.execPath}\n`
    + 'process.stdout.write(`ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL || ""}\\n`);\n');
  await chmod(claudeShim, 0o755);

  const run = (...argv) => spawnSync(process.execPath, [CLI, 'run', ...argv], {
    cwd: workDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: binDir,
      TEAMCLAUDE_CONFIG: configPath,
      CLAUDE_CONFIG_DIR: workDir,
      TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
      ANTHROPIC_MODEL: '',
      TC_ACCT: '',
    },
  });

  try {
    await fn({ dir, configPath, run, port });
  } finally {
    stub.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('D4f: `run --account` emits the uuid pin form, not the mutable display name', async () => {
  await withRunEmission(async ({ run }) => {
    const r = run('--no-mitm', '--account', 'primary', '--', '-p', 'hi');
    assert.equal(r.status, 0, r.stderr);
    // Same stable form env emits: accountUuid/orgUuid, percent-encoded in the path.
    assert.match(r.stdout, /ANTHROPIC_BASE_URL=.*\/tc-acct\/acct-primary%2Forg-primary/,
      'run must put the stable uuid pin into ANTHROPIC_BASE_URL for the child');
    assert.match(r.stderr, /Pinned to account "acct-primary\/org-primary"/,
      'stderr narration must report the emitted pin, not the display name');
    assert.doesNotMatch(r.stderr, /Pinned to account "primary"/,
      'display name must not be the emitted TC_ACCT when uuids exist');
  });
});

test('D4f: `run --account` falls back to the display name only when no uuid exists', async () => {
  await withRunEmission(async ({ run }) => {
    const r = run('--no-mitm', '--account', "work's desk", '--', '-p', 'hi');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ANTHROPIC_BASE_URL=.*\/tc-acct\/work%27s%20desk/,
      'name is the only identity; it must still appear (percent-encoded) in the child URL');
    assert.match(r.stderr, /Pinned to account "work's desk"/);
  }, {
    accounts: [
      { name: "work's desk", type: 'apikey', apiKey: 'k', priority: 0 },
      ...FIXTURE.accounts,
    ],
  });
});
