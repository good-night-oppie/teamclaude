import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig, doctorExitCode, summarize, formatFindings } from '../src/config-doctor.js';
import { AccountManager } from '../src/account-manager.js';

// Covers src/config-doctor.js: the read-only config consistency check behind
// `teamclaude doctor`.
//
// Every case is an inline config literal, so nothing here reads
// ~/.config/teamclaude.json or ~/.claude/settings.json — the allowlist is passed
// in as data, which is also how the command itself is structured (index.js does
// the IO, this module only decides).
//
// Each defect below is one that produces NO error at runtime today: the request
// simply goes somewhere else, or upstream, and comes back wrong.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', priority: 0, ...extra };
}
function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k', priority: 50, ...extra };
}
function codes(findings) {
  return findings.map(f => f.code);
}
function find(findings, code) {
  return findings.find(f => f.code === code);
}

// ── the clean case ────────────────────────────────────────────

test('a coherent config produces no problems, only notes, and exits 0', () => {
  const config = {
    accounts: [oauth('primary'), apikey('fugu', { upstream: 'http://127.0.0.1:8081', modelMap: { 'claude-fable-5': 'fugu-2' } })],
    routes: [
      { name: 'fable', match: ['*fable*'], accounts: ['fugu', 'primary'] },
      { name: 'default', match: ['*'], accounts: ['primary'] },
    ],
  };
  const findings = checkConfig(config);
  assert.ok(findings.every(f => f.severity === 'info'), 'nothing here is broken');
  assert.deepEqual(codes(findings).sort(), ['catchall-shadows-ownership', 'no-client-allowlist']);
  assert.equal(doctorExitCode(findings), 0, 'info-only never fails a cron job');
  assert.match(formatFindings(findings).join('\n'), /No problems found/);
});

test('an empty config is a single error, and nothing downstream throws on it', () => {
  const findings = checkConfig({ accounts: [], routes: [] });
  assert.deepEqual(codes(findings), ['no-accounts']);
  assert.equal(doctorExitCode(findings), 3);
  assert.ok(formatFindings(findings).length > 0);
});

// ── (a) F7(b): a terminal catch-all with accounts kills models[] ──

test('a catch-all route WITH an accounts list makes every models[] claim unreachable', () => {
  const config = {
    accounts: [oauth('primary'), apikey('kimi', { models: ['claude-haiku-4-5'] })],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary', 'kimi'] }],
  };
  const f = find(checkConfig(config), 'catchall-shadows-ownership');
  assert.ok(f, 'the documented models[] mechanism is inert here and must be reported');
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /EVERY model id/);
  assert.match(f.message, /kimi/, 'the affected accounts are named');
});

test('the same config without any models[] claim is a NOTE, not a warning — the trap is reported before it is sprung', () => {
  // F7(b) is exactly the state where nobody has written a claim yet: the README
  // documents models[] as the mechanism, the operator follows it, and it does
  // nothing. Reporting that only once a claim exists means reporting it after
  // the edit, the restart, and the confusion. Reporting it as a WARNING on every
  // config shaped like this would teach operators to skim, so it is a note: it
  // never fails a cron job and never changes the exit code.
  const config = {
    accounts: [oauth('primary'), apikey('kimi')],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary', 'kimi'] }],
  };
  const f = find(checkConfig(config), 'catchall-shadows-ownership');
  assert.ok(f);
  assert.equal(f.severity, 'info');
  assert.match(f.message, /nothing is broken yet/);
  assert.equal(doctorExitCode(checkConfig(config)), 0);

  // …and a config with no catch-all account list is not flagged at all.
  const open = {
    accounts: [oauth('primary'), apikey('kimi')],
    routes: [{ name: 'default', match: ['*'] }],
  };
  assert.ok(!find(checkConfig(open), 'catchall-shadows-ownership'),
    'a catch-all that lists no accounts is not exclusive, so ownership still works');
});

test('a models[] claim its own account can never serve is an error, not a warning', () => {
  const config = {
    accounts: [oauth('primary'), apikey('kimi', { models: ['claude-haiku-4-5'] })],
    routes: [
      { name: 'haiku', match: ['*haiku*'], accounts: ['primary'] },   // excludes kimi
      { name: 'default', match: ['*'] },
    ],
  };
  const f = find(checkConfig(config), 'models-claim-unreachable');
  assert.ok(f);
  assert.equal(f.severity, 'error');
  assert.match(f.message, /route "haiku"/);
});

test('a [Nm]-tagged claim is checked in both its tagged and bare forms', () => {
  const config = {
    accounts: [oauth('primary'), apikey('deep', { models: ['deepseek-v4-pro[1m]'] })],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
  };
  const hits = checkConfig(config).filter(f => f.code === 'models-claim-unreachable');
  assert.deepEqual(hits.map(f => f.subject).sort(), ['deep:deepseek-v4-pro', 'deep:deepseek-v4-pro[1m]'],
    'the claim answers the bare id too, so the bare id is checked too');
});

test('the README\'s own [1m]+bare example yields ONE finding per (account, id), not two', () => {
  // README.md's example is "models": ["deepseek-v4-pro[1m]","deepseek-v4-pro",…];
  // the two declarations expand to overlapping id sets, and emitting the bare id
  // twice makes the summary count disagree with the number of real problems —
  // the fastest way to teach an operator to skim past the output.
  const config = {
    accounts: [oauth('primary'), apikey('deep', { models: ['deepseek-v4-pro[1m]', 'deepseek-v4-pro', 'deepseek-v4-flash'] })],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
  };
  const hits = checkConfig(config).filter(f => f.code === 'models-claim-unreachable');
  assert.deepEqual(hits.map(f => f.subject).sort(),
    ['deep:deepseek-v4-flash', 'deep:deepseek-v4-pro', 'deep:deepseek-v4-pro[1m]']);
  assert.equal(new Set(hits.map(f => f.subject)).size, hits.length, 'no (account, id) pair is reported twice');
});

// ── malformed declarations: a total outage, not a routing subtlety ────────────

test('models written as a string is an ERROR — the real router throws on it and the proxy 502s', () => {
  // A plausible hand-edit: the README documents an array of strings, and the
  // singular case is easy to write bare. `_accountOwnsModel` then calls
  // `.some()` on a string (account-manager.js:622) and every request that
  // reaches the ownership fallback dies with a TypeError → 502. The oracle's own
  // normalizer coerces the bad value away, which is exactly why doctor used to
  // certify this config as clean.
  const config = {
    accounts: [oauth('a', { models: 'claude-opus-5' }), oauth('b')],
    routes: [],
  };
  const f = find(checkConfig(config), 'malformed-models-declaration');
  assert.equal(f.severity, 'error');
  assert.match(f.message, /the string "claude-opus-5"/);
  assert.match(f.message, /502/, 'the consequence is an outage and must be stated as one');
  assert.match(f.fix.join(' '), /"models": \["claude-opus-5"\]/);
  assert.equal(doctorExitCode(checkConfig(config)), 3);

  // …and the router really does throw, which is what makes this an error.
  assert.throws(() => new AccountManager(config.accounts, 0.98, { routes: [] })
    .getActiveAccount(null, 'claude-opus-5'), TypeError);
});

test('a non-string entry inside models[] is caught too', () => {
  const config = { accounts: [oauth('a', { models: ['claude-opus-5', 7] })], routes: [] };
  const f = find(checkConfig(config), 'malformed-models-declaration');
  assert.equal(f.severity, 'error');
  assert.match(f.message, /non-string entry/);
});

test('a well-formed models[] is not flagged as malformed', () => {
  const config = { accounts: [oauth('a', { models: ['claude-opus-5'] }), oauth('b')], routes: [] };
  assert.ok(!find(checkConfig(config), 'malformed-models-declaration'));
});

// ── dead modelMap translations ────────────────────────────────

test('a modelMap key on an account the winning route excludes is dead code', () => {
  const config = {
    accounts: [
      oauth('primary'),
      apikey('deepseek-v4-pro', { upstream: 'http://127.0.0.1:8084', modelMap: { 'claude-opus-4-8': 'deepseek-v4-pro', opus: 'deepseek-v4-pro' } }),
    ],
    routes: [
      { name: 'opus', match: ['*opus*'], accounts: ['primary'] },
      { name: 'default', match: ['*'], accounts: ['primary'] },
    ],
  };
  const f = find(checkConfig(config), 'modelmap-key-unreachable');
  assert.equal(f.severity, 'error');
  assert.match(f.message, /claude-opus-4-8, opus/);
  assert.match(f.message, /never makes an account eligible/,
    'the explanation has to say WHY a modelMap cannot fix eligibility');
});

test('a blocked id is subtracted before the reachability checks', () => {
  const config = {
    accounts: [oauth('primary'), apikey('deep', { models: ['claude-preview-1'] })],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
    blockedModels: ['*preview*'],
  };
  const found = codes(checkConfig(config));
  assert.ok(found.includes('declared-id-blocked'));
  assert.ok(!found.includes('models-claim-unreachable'),
    'a blocked id never reaches account selection, so unreachability is not the story');
});

// ── (d) route ordering ────────────────────────────────────────

test('every route after a catch-all is dead, and they are named', () => {
  const config = {
    accounts: [oauth('primary')],
    routes: [
      { name: 'default', match: ['*'], accounts: ['primary'] },
      { name: 'fable', match: ['*fable*'], accounts: ['primary'] },
      { name: 'opus', match: ['*opus*'], accounts: ['primary'] },
    ],
  };
  const f = find(checkConfig(config), 'route-after-catchall');
  assert.equal(f.severity, 'error');
  assert.match(f.message, /"fable", "opus"/);
});

test('a catch-all in last position is correct and is not flagged', () => {
  const config = {
    accounts: [oauth('primary')],
    routes: [
      { name: 'fable', match: ['*fable*'], accounts: ['primary'] },
      { name: 'default', match: ['*'], accounts: ['primary'] },
    ],
  };
  assert.ok(!find(checkConfig(config), 'route-after-catchall'));
});

test('a route naming an account that does not exist is an error', () => {
  const config = {
    accounts: [oauth('primary')],
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['primary', 'typo', '7'] }],
  };
  const hits = checkConfig(config).filter(f => f.code === 'route-unknown-account');
  assert.equal(hits.length, 2, 'both the bad name and the out-of-range index are reported');
  assert.match(hits[0].message, /"typo"/);
});

test('a route whose every listed account is disabled has no eligible account', () => {
  const config = {
    accounts: [oauth('primary'), apikey('fugu', { disabled: true })],
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['fugu'] }],
  };
  const f = find(checkConfig(config), 'route-accounts-all-disabled');
  assert.equal(f.severity, 'error');
  assert.match(f.fix.join(' '), /teamclaude enable fugu/);
});

// ── (b) an account name used as a model id ────────────────────

test('an account name that is also an upstream model id is flagged with the pin remedy', () => {
  const config = {
    accounts: [
      oauth('primary'),
      apikey('deepseek-v4-pro', { upstream: 'http://127.0.0.1:8084', modelMap: { 'claude-opus-4-8': 'deepseek-v4-pro' } }),
    ],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
  };
  const f = find(checkConfig(config), 'account-name-not-routable');
  assert.ok(f, 'this is the incident, detected from config alone');
  assert.equal(f.severity, 'warn');
  assert.match(f.fix.join(' '), /teamclaude run --account deepseek-v4-pro/);
});

test('a NOMINALLY routable account name is still flagged: the first choice 404s and a 404 never fails over', () => {
  // The sibling of the incident. deepseek-v4-flash IS in the catch-all's account
  // list, so the id "routes" and the old check skipped it in silence — but the
  // rules pick the priority-0 oauth account first, which has no modelMap entry
  // and no custom upstream, so the id egresses verbatim and 404s. server.js
  // relays any non-429 verbatim with no retry, so the account that bears the
  // name is never reached.
  const config = {
    accounts: [
      oauth('primary'),
      apikey('deepseek-v4-flash', { upstream: 'http://127.0.0.1:8085', modelMap: { 'claude-sonnet-5': 'deepseek-v4-flash' } }),
    ],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary', 'deepseek-v4-flash'] }],
  };
  const f = find(checkConfig(config), 'account-name-first-choice-404');
  assert.ok(f, 'nominally routable is not the same as reaching the account you named');
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /the rules pick "primary" first/);
  assert.match(f.message, /a 404 never fails over/);
  assert.match(f.fix.join(' '), /teamclaude run --account deepseek-v4-flash/);
});

test('…but not when the first choice has an opaque upstream, where nothing is provable', () => {
  const config = {
    accounts: [
      apikey('fugu', { priority: 0, upstream: 'http://127.0.0.1:8081' }),
      apikey('deepseek-v4-flash', { priority: 5, upstream: 'http://127.0.0.1:8085', modelMap: { 'claude-sonnet-5': 'deepseek-v4-flash' } }),
    ],
    routes: [{ name: 'default', match: ['*'], accounts: ['fugu', 'deepseek-v4-flash'] }],
  };
  assert.ok(!find(checkConfig(config), 'account-name-first-choice-404'),
    'the id reaches a backend teamclaude cannot see past — do not claim a 404 you cannot prove');
});

test('an ordinary account name is not flagged just for being unroutable as a model', () => {
  const config = {
    accounts: [oauth('primary'), oauth('work')],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
  };
  assert.ok(!find(checkConfig(config), 'account-name-not-routable'),
    'without evidence the operator treats the name as a model id, this would fire on every config');
});

test('an account name listed in the client allowlist is evidence enough on its own', () => {
  const config = {
    accounts: [oauth('primary'), apikey('deepseek-v4-pro')],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
  };
  assert.ok(!find(checkConfig(config), 'account-name-not-routable'));
  const withAllowlist = checkConfig(config, { availableModels: ['deepseek-v4-pro'] });
  assert.ok(find(withAllowlist, 'account-name-not-routable'),
    'someone put it in availableModels, so someone expects it to be a model id');
});

// ── (c) drift against Claude Code's allowlist ─────────────────

test('an allowlisted id this proxy cannot serve is a warning naming the settings file', () => {
  const config = {
    accounts: [oauth('primary'), apikey('deepseek-v4-pro')],
    routes: [{ name: 'default', match: ['*'], accounts: ['primary'] }],
  };
  const findings = checkConfig(config, {
    availableModels: ['claude-opus-4-8', 'deepseek-v4-pro'],
    settingsSources: [{ tier: 'user', path: '/tmp/fixture/settings.json', count: 2 }],
  });
  const f = find(findings, 'allowlist-id-not-routable');
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /deepseek-v4-pro/);
  assert.match(f.fix.join(' '), /\/tmp\/fixture\/settings\.json/, 'name the file to edit, do not guess');
});

test('a routable id the client would veto is INFO only and never fails the exit code', () => {
  const config = {
    accounts: [oauth('primary'), apikey('fugu', { upstream: 'http://127.0.0.1:8081', modelMap: { 'claude-fable-5': 'fugu-2' } })],
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['fugu'] }, { name: 'default', match: ['*'] }],
  };
  const findings = checkConfig(config, { availableModels: ['claude-opus-4-8'] });
  const f = find(findings, 'routable-id-client-vetoed');
  assert.equal(f.severity, 'info');
  assert.match(f.message, /claude-fable-5/);
  assert.match(f.message, /Advisory only/, 'it mirrors a foreign build and must say so');
  assert.equal(doctorExitCode(findings.filter(x => x.severity === 'info')), 0);
});

test('with no allowlist configured the drift checks are skipped, not faked', () => {
  const config = { accounts: [oauth('primary')], routes: [] };
  const f = find(checkConfig(config, { availableModels: null }), 'no-client-allowlist');
  assert.equal(f.severity, 'info');
  assert.match(f.message, /never writes them/);
});

// ── exit codes ────────────────────────────────────────────────

test('exit codes are 0 clean / 2 warnings / 3 errors, and --strict promotes warnings', () => {
  const info = [{ severity: 'info', code: 'i', subject: 's', message: 'm', fix: [] }];
  const warn = [{ severity: 'warn', code: 'w', subject: 's', message: 'm', fix: [] }];
  const error = [{ severity: 'error', code: 'e', subject: 's', message: 'm', fix: [] }];

  assert.equal(doctorExitCode([]), 0);
  assert.equal(doctorExitCode(info), 0, 'notes never fail a build');
  assert.equal(doctorExitCode(warn), 2);
  assert.equal(doctorExitCode(error), 3);
  assert.equal(doctorExitCode(warn, { strict: true }), 3);
  assert.equal(doctorExitCode([...warn, ...error]), 3);
  assert.notEqual(doctorExitCode(error), 1, '1 is reserved for "the doctor could not run at all"');
  assert.deepEqual(summarize([...info, ...warn, ...error]), { info: 1, warn: 1, error: 1 });
});

test('findings are ordered most severe first and render with their remedies', () => {
  const config = {
    accounts: [oauth('primary'), apikey('kimi', { models: ['claude-haiku-4-5'] })],
    routes: [
      { name: 'haiku', match: ['*haiku*'], accounts: ['primary'] },
      { name: 'default', match: ['*'], accounts: ['primary', 'kimi'] },
    ],
  };
  const findings = checkConfig(config);
  assert.equal(findings[0].severity, 'error');
  const out = formatFindings(findings).join('\n');
  assert.match(out, /^ERROR /m);
  assert.match(out, /→ /, 'every finding carries a next step');
  assert.match(out, /exit 3/);
  assert.ok(!out.includes('\u001b'), 'plain text, no ANSI — the output is meant to be pasted');
});
