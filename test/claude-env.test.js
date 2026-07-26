import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeEnvLines, accountPinBaseUrl, directLaunchEnvPlan } from '../src/claude-env.js';

test('MITM mode (default) emits proxy vars + CA cert, and clears ANTHROPIC_BASE_URL', () => {
  const lines = buildClaudeEnvLines({ port: 3456, caPath: '/home/u/.config/teamclaude-ca.pem' });
  assert.deepEqual(lines, [
    'export HTTPS_PROXY=http://127.0.0.1:3456',
    'export HTTP_PROXY=http://127.0.0.1:3456',
    'export https_proxy=http://127.0.0.1:3456',
    'export http_proxy=http://127.0.0.1:3456',
    'export NO_PROXY=localhost,127.0.0.1,::1',
    'export no_proxy=localhost,127.0.0.1,::1',
    'export NODE_EXTRA_CA_CERTS=/home/u/.config/teamclaude-ca.pem',
    'unset ANTHROPIC_BASE_URL',
  ]);
});

test('MITM mode without a caPath omits NODE_EXTRA_CA_CERTS (never emits an empty value)', () => {
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: true, caPath: null });
  assert.ok(!lines.some((l) => l.startsWith('export NODE_EXTRA_CA_CERTS')));
  assert.ok(lines.includes('export HTTPS_PROXY=http://127.0.0.1:3456'));
});

test('--no-mitm (base-URL) mode emits only ANTHROPIC_BASE_URL, no proxy/cert vars', () => {
  const lines = buildClaudeEnvLines({ port: 8080, useMitm: false });
  assert.deepEqual(lines, ['export ANTHROPIC_BASE_URL=http://localhost:8080']);
});

test('no ANTHROPIC_API_KEY is ever emitted (loopback is auth-exempt; keeps subscription mode)', () => {
  const mitm = buildClaudeEnvLines({ port: 3456, useMitm: true, caPath: '/x' });
  const base = buildClaudeEnvLines({ port: 3456, useMitm: false });
  for (const l of [...mitm, ...base]) assert.ok(!l.includes('ANTHROPIC_API_KEY'), l);
});

test('holdSeconds > 0 adds API_TIMEOUT_MS = holdSeconds + 60s, in both modes', () => {
  const mitm = buildClaudeEnvLines({ port: 3456, caPath: '/x', holdSeconds: 3600 });
  assert.ok(mitm.includes('export API_TIMEOUT_MS=3660000'));
  const base = buildClaudeEnvLines({ port: 3456, useMitm: false, holdSeconds: 120 });
  assert.ok(base.includes('export API_TIMEOUT_MS=180000'));
});

test('holdSeconds 0 / unset adds no API_TIMEOUT_MS', () => {
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: false });
  assert.ok(!lines.some((l) => l.startsWith('export API_TIMEOUT_MS')));
});

// ── account pinning (/tc-acct/<name-or-index>) ──────────────

test('an account pin in MITM mode keeps the proxy vars and replaces the unset with the pinned base URL', () => {
  const lines = buildClaudeEnvLines({ port: 3456, caPath: '/ca.pem', accountPin: 'work' });
  assert.deepEqual(lines, [
    'export HTTPS_PROXY=http://127.0.0.1:3456',
    'export HTTP_PROXY=http://127.0.0.1:3456',
    'export https_proxy=http://127.0.0.1:3456',
    'export http_proxy=http://127.0.0.1:3456',
    'export NO_PROXY=localhost,127.0.0.1,::1',
    'export no_proxy=localhost,127.0.0.1,::1',
    'export NODE_EXTRA_CA_CERTS=/ca.pem',
    "export ANTHROPIC_BASE_URL='http://127.0.0.1:3456/tc-acct/work'",
  ]);
  // The pin would be undone by the unset, so the unset must be gone; the MITM
  // lines stay so non-claude callers of api.anthropic.com are still intercepted.
  assert.ok(!lines.includes('unset ANTHROPIC_BASE_URL'), 'unset would clear the pin');
});

test('an account pin in --no-mitm mode replaces the plain base URL, adding no proxy/cert vars', () => {
  const lines = buildClaudeEnvLines({ port: 8080, useMitm: false, accountPin: 'work' });
  assert.deepEqual(lines, ["export ANTHROPIC_BASE_URL='http://127.0.0.1:8080/tc-acct/work'"]);
});

test('no account pin leaves both modes exactly as they were (unset in MITM, plain base URL otherwise)', () => {
  for (const pin of [null, undefined, '']) {
    const mitm = buildClaudeEnvLines({ port: 3456, caPath: '/ca.pem', accountPin: pin });
    assert.ok(mitm.includes('unset ANTHROPIC_BASE_URL'), `unset missing for pin=${JSON.stringify(pin)}`);
    assert.ok(!mitm.some((l) => l.includes('/tc-acct/')), 'no pin must not emit a /tc-acct URL');

    const base = buildClaudeEnvLines({ port: 3456, useMitm: false, accountPin: pin });
    assert.deepEqual(base, ['export ANTHROPIC_BASE_URL=http://localhost:3456']);
  }
});

test('an account name with spaces, parens and quotes is percent-encoded down to shell-inert characters', () => {
  // encodeURIComponent alone leaves !'()* — all shell-special, and real account
  // names carry them (the README's own example is "work (Acme)").
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: false, accountPin: "work (Acme)'s a/b!*" });
  const url = lines[0].slice("export ANTHROPIC_BASE_URL='".length, -1);
  assert.equal(url, 'http://127.0.0.1:3456/tc-acct/work%20%28Acme%29%27s%20a%2Fb%21%2A');
  const token = url.split('/tc-acct/')[1];
  assert.match(token, /^[A-Za-z0-9\-_.~%]+$/, 'token must reduce to unreserved chars + %');
  assert.ok(!token.includes('/'), 'an encoded token can never split the /tc-acct path segment');
  // The server round-trips it with decodeURIComponent.
  assert.equal(decodeURIComponent(token), "work (Acme)'s a/b!*");
});

test('the pinned base URL is single-quoted so an eval of the env output cannot break out', () => {
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: false, accountPin: "a';rm -rf /;'" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^export ANTHROPIC_BASE_URL='[^']*'$/, 'exactly one quoted value, no embedded quote');
  assert.ok(!lines[0].includes('rm -rf /'), 'metacharacters must not survive encoding');
});

test('a pin composes with holdSeconds and still never emits ANTHROPIC_API_KEY', () => {
  const lines = buildClaudeEnvLines({ port: 3456, caPath: '/ca.pem', holdSeconds: 3600, accountPin: 'work' });
  assert.ok(lines.includes('export API_TIMEOUT_MS=3660000'));
  assert.ok(lines.some((l) => l.includes('/tc-acct/work')));
  for (const l of lines) assert.ok(!l.includes('ANTHROPIC_API_KEY'), l);
});

test('accountPinBaseUrl builds the /tc-acct URL on 127.0.0.1, and returns null when there is no pin', () => {
  assert.equal(accountPinBaseUrl(3456, 'work'), 'http://127.0.0.1:3456/tc-acct/work');
  assert.equal(accountPinBaseUrl(8080, 'work (Acme)'), 'http://127.0.0.1:8080/tc-acct/work%20%28Acme%29');
  for (const pin of [null, undefined, '']) assert.equal(accountPinBaseUrl(3456, pin), null, JSON.stringify(pin));
});

test('a numeric account index pins like keep-warm does — index 0 is a pin, not a missing one', () => {
  assert.equal(accountPinBaseUrl(3456, 0), 'http://127.0.0.1:3456/tc-acct/0');
  assert.equal(accountPinBaseUrl(3456, '0'), 'http://127.0.0.1:3456/tc-acct/0');
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: false, accountPin: 0 });
  assert.deepEqual(lines, ["export ANTHROPIC_BASE_URL='http://127.0.0.1:3456/tc-acct/0'"]);
});

test('a whitespace-only pin is kept, not silently dropped — the server answers it with a loud 404', () => {
  assert.equal(accountPinBaseUrl(3456, ' '), 'http://127.0.0.1:3456/tc-acct/%20');
});

// ── directLaunchEnvPlan ───────────────────────────────────────
//
// `--auto-fallback` promises a launch that bypasses the proxy. The child
// inherits its parent's environment, and a teamclaude session's parent shell is
// usually one teamclaude set up, so without this the promise is silently false.

test('a proxy var pointing at the dead port is cleared', () => {
  const env = {
    HTTPS_PROXY: 'http://127.0.0.1:3456', HTTP_PROXY: 'http://127.0.0.1:3456',
    https_proxy: 'http://127.0.0.1:3456', http_proxy: 'http://127.0.0.1:3456',
  };
  const plan = directLaunchEnvPlan(env, 3456);
  assert.deepEqual(plan.clear.sort(), ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].sort());
  assert.deepEqual(plan.remaining, []);
});

test('localhost and ::1 spellings of our own port are recognized too', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const plan = directLaunchEnvPlan({ HTTPS_PROXY: `http://${host}:3456` }, 3456);
    assert.deepEqual(plan.clear, ['HTTPS_PROXY'], host);
  }
});

test('a proxy var pointing somewhere ELSE is left alone and reported', () => {
  // The nested case: another live teamclaude, or a corporate egress proxy.
  // Deleting it behind the operator's back would break deliberate configuration.
  const plan = directLaunchEnvPlan({ HTTPS_PROXY: 'http://127.0.0.1:3456' }, 41999);
  assert.deepEqual(plan.clear, [], 'not ours — not deleted');
  assert.equal(plan.remaining.length, 1);
  assert.equal(plan.remaining[0].value, 'http://127.0.0.1:3456');
  assert.deepEqual(plan.remaining[0].names, ['HTTPS_PROXY']);
});

test('remaining vars are grouped by value, so one destination is one row', () => {
  const env = {
    HTTPS_PROXY: 'http://corp:8080', HTTP_PROXY: 'http://corp:8080',
    https_proxy: 'http://corp:8080', http_proxy: 'http://corp:8080',
  };
  const plan = directLaunchEnvPlan(env, 3456);
  assert.equal(plan.remaining.length, 1, 'four variables, one destination, one row');
  assert.equal(plan.remaining[0].names.length, 4);
});

test('a port that is a prefix of another does not match by accident', () => {
  // :34560 must not be mistaken for :3456.
  const plan = directLaunchEnvPlan({ HTTPS_PROXY: 'http://127.0.0.1:34560' }, 3456);
  assert.deepEqual(plan.clear, []);
  assert.equal(plan.remaining.length, 1);
});

test('ANTHROPIC_BASE_URL pointing at the dead port is cleared, including a /tc-acct pin', () => {
  const plan = directLaunchEnvPlan({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456/tc-acct/fugu' }, 3456);
  assert.ok(plan.clear.includes('ANTHROPIC_BASE_URL'));
});

test('a base URL pointing at a real upstream is NOT cleared', () => {
  const plan = directLaunchEnvPlan({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 3456);
  assert.deepEqual(plan.clear, []);
});

test('NODE_EXTRA_CA_CERTS is dropped with the proxy it belonged to, but not on its own', () => {
  const withProxy = directLaunchEnvPlan(
    { HTTPS_PROXY: 'http://127.0.0.1:3456', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }, 3456);
  assert.ok(withProxy.clear.includes('NODE_EXTRA_CA_CERTS'), 'our MITM leaf is useless without our proxy');

  const alone = directLaunchEnvPlan({ NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }, 3456);
  assert.deepEqual(alone.clear, [], 'nothing of ours was cleared, so the trust anchor is not ours to drop');
});

test('directLaunchEnvPlan mutates nothing and tolerates junk', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:3456' };
  const before = JSON.stringify(env);
  directLaunchEnvPlan(env, 3456);
  assert.equal(JSON.stringify(env), before, 'pure: the caller deletes, not us');
  for (const junk of [null, undefined, {}, { HTTPS_PROXY: 7 }, { HTTPS_PROXY: '' }]) {
    assert.doesNotThrow(() => directLaunchEnvPlan(junk, 3456));
  }
});
