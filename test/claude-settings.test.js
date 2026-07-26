import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeSettingsSources, readAvailableModels } from '../src/claude-settings.js';
import * as claudeSettings from '../src/claude-settings.js';

// Covers src/claude-settings.js: the READ-ONLY reader for Claude Code's own
// `availableModels` allowlist.
//
// Every path is injected, so nothing here touches the real ~/.claude — the
// module takes {home, cwd, configDir, policyDir} precisely so it can be pointed
// at a tmpdir. The last test is the one that matters most: a settings file is
// full of credentials, and the reader must be incapable of leaking them.

async function withDirs(fn) {
  const root = await mkdtemp(join(tmpdir(), 'tc-claude-settings-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  const policyDir = join(root, 'policy');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(cwd, '.claude'), { recursive: true });
  await mkdir(policyDir, { recursive: true });
  try {
    await fn({ root, home, cwd, policyDir, opts: { home, cwd, configDir: null, policyDir } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function settings(obj) {
  return JSON.stringify(obj, null, 2);
}

// ── source resolution ─────────────────────────────────────────

test('the tiers are enumerated highest-precedence first, and CLAUDE_CONFIG_DIR relocates the user tier', async () => {
  await withDirs(async ({ home, cwd, policyDir }) => {
    const tiers = claudeSettingsSources({ home, cwd, configDir: null, policyDir }).map(s => s.tier);
    assert.equal(tiers[0], 'policy', 'managed policy is read first because it replaces rather than unions');
    assert.ok(tiers.includes('user') && tiers.includes('project') && tiers.includes('local'));

    const relocated = claudeSettingsSources({ home, cwd, configDir: '/elsewhere/cfg', policyDir });
    assert.ok(relocated.some(s => s.path === '/elsewhere/cfg/settings.json'),
      'CLAUDE_CONFIG_DIR moves the user settings file, so the reader has to follow it');
    assert.ok(!relocated.some(s => s.path === join(home, '.claude', 'settings.json')));
  });
});

// ── merge semantics ───────────────────────────────────────────

test('no settings file anywhere means no allowlist at all — null, not an empty list', async () => {
  await withDirs(async ({ opts }) => {
    const r = readAvailableModels(opts);
    assert.equal(r.availableModels, null,
      'null means the client gate admits everything; [] would mean it admits only the default');
    assert.deepEqual(r.sources, []);
    assert.deepEqual(r.errors, []);
  });
});

test('a settings file with no availableModels key contributes nothing', async () => {
  await withDirs(async ({ home, opts }) => {
    await writeFile(join(home, '.claude', 'settings.json'), settings({ model: 'opus', env: {} }));
    const r = readAvailableModels(opts);
    assert.equal(r.availableModels, null);
    assert.deepEqual(r.sources, []);
  });
});

test('user, project and local tiers UNION — a lower tier can only ever add entries', async () => {
  await withDirs(async ({ home, cwd, opts }) => {
    await writeFile(join(home, '.claude', 'settings.json'), settings({ availableModels: ['claude-opus-4-8', 'claude-sonnet-5'] }));
    await writeFile(join(cwd, '.claude', 'settings.json'), settings({ availableModels: ['claude-fable-5'] }));
    await writeFile(join(cwd, '.claude', 'settings.local.json'), settings({ availableModels: ['claude-sonnet-5', 'claude-haiku-4-5'] }));

    const r = readAvailableModels(opts);
    assert.deepEqual(r.availableModels, ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'],
      'union, de-duplicated, first-seen order preserved');
    assert.equal(r.sources.length, 3);
    assert.equal(r.policyOverride, false);
  });
});

test('a managed-policy array REPLACES the union instead of joining it', async () => {
  await withDirs(async ({ home, policyDir, opts }) => {
    await writeFile(join(home, '.claude', 'settings.json'), settings({ availableModels: ['claude-opus-4-8'] }));
    await writeFile(join(policyDir, 'managed-settings.json'), settings({ availableModels: ['claude-sonnet-5'] }));

    const r = readAvailableModels(opts);
    assert.deepEqual(r.availableModels, ['claude-sonnet-5'],
      'policy is the one tier that wins wholesale; unioning it would let a user widen an admin list');
    assert.equal(r.policyOverride, true);
  });
});

test('managed-settings.d drop-ins are merged in sorted order, under the main policy file', async () => {
  await withDirs(async ({ policyDir, opts }) => {
    await mkdir(join(policyDir, 'managed-settings.d'), { recursive: true });
    await writeFile(join(policyDir, 'managed-settings.d', '20-late.json'), settings({ availableModels: ['late'] }));
    await writeFile(join(policyDir, 'managed-settings.d', '10-early.json'), settings({ availableModels: ['early'] }));

    const r = readAvailableModels(opts);
    assert.deepEqual(r.availableModels, ['early'], 'the first policy tier that defines the key settles it');
    assert.equal(r.policyOverride, true);
  });
});

test('an unparseable settings file is reported and skipped, never thrown', async () => {
  await withDirs(async ({ home, cwd, opts }) => {
    await writeFile(join(home, '.claude', 'settings.json'), '{ this is not json');
    await writeFile(join(cwd, '.claude', 'settings.json'), settings({ availableModels: ['claude-fable-5'] }));

    const r = readAvailableModels(opts);
    assert.deepEqual(r.availableModels, ['claude-fable-5'],
      'a broken file in one tier must not stop a launch — the client skips it too');
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].path, /settings\.json$/);
    assert.ok(r.errors[0].message, 'the parse failure is described so the operator can fix it');
  });
});

test('a non-array or non-string availableModels is ignored rather than trusted', async () => {
  await withDirs(async ({ home, cwd, opts }) => {
    await writeFile(join(home, '.claude', 'settings.json'), settings({ availableModels: 'claude-opus-4-8' }));
    await writeFile(join(cwd, '.claude', 'settings.json'), settings({ availableModels: ['claude-fable-5', 42, null] }));

    const r = readAvailableModels(opts);
    assert.deepEqual(r.availableModels, ['claude-fable-5'], 'garbage entries are dropped, not stringified');
  });
});

// ── the security invariant ────────────────────────────────────

test('nothing but availableModels crosses the boundary, and the module exports no writer', async () => {
  await withDirs(async ({ home, opts }) => {
    const path = join(home, '.claude', 'settings.json');
    const before = settings({
      availableModels: ['claude-opus-4-8'],
      apiKeyHelper: '/usr/local/bin/print-my-secret',
      env: { SOME_TOKEN: 'sk-test-not-a-real-secret-0000' },
      mcpServers: { x: { command: 'x', env: { KEY: 'sk-test-not-a-real-secret-1111' } } },
    });
    await writeFile(path, before);

    const r = readAvailableModels(opts);
    assert.deepEqual(r.availableModels, ['claude-opus-4-8']);
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes('sk-test-not-a-real-secret'),
      'a settings file is full of credentials; the reader must be structurally incapable of returning them');
    assert.ok(!serialized.includes('apiKeyHelper'));
    assert.deepEqual(Object.keys(r).sort(), ['availableModels', 'errors', 'policyOverride', 'sources']);

    // Reading is the whole contract: the file must be byte-identical afterwards,
    // and there must be no exported function that could have changed it.
    assert.equal(await readFile(path, 'utf8'), before, 'read-only means the bytes do not move');
    const writers = Object.keys(claudeSettings)
      .filter(k => /^(write|save|install|uninstall|set|update|patch|add|remove|delete|ensure)/i.test(k));
    assert.deepEqual(writers, [], 'the restraint is structural, not a policy note in a comment');
  });
});
