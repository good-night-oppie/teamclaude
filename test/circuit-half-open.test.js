import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('_isAvailable does not mutate circuitOpenUntil on an open or expired circuit', () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ]);
  const a = am.accounts[0];
  const openUntil = Date.now() + 30_000;
  a.circuitOpenUntil = openUntil;
  a.consecutiveFailures = 2;

  assert.equal(am._isAvailable(a), false);
  assert.equal(a.circuitOpenUntil, openUntil, 'open circuit must stay open across availability reads');

  // Status / TUI path: getStatus and eligible maps call _isAvailable.
  am.getStatus();
  assert.equal(a.circuitOpenUntil, openUntil);

  // Expired half-open: still must not clear as a filter side effect.
  const expired = Date.now() - 1000;
  a.circuitOpenUntil = expired;
  assert.equal(am._isAvailable(a), true, 'expired circuit is half-open eligible');
  assert.equal(a.circuitOpenUntil, expired, 'status/filter must not close the breaker');
  am.getStatus();
  assert.equal(a.circuitOpenUntil, expired);
});

test('half-open allows exactly one concurrent trial request', async () => {
  let hits = 0;
  let releaseUpstream;
  const gate = new Promise(r => { releaseUpstream = r; });
  const upstream = http.createServer((_req, res) => {
    hits++;
    gate.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'solo', type: 'apikey', apiKey: 'k', upstream: `http://127.0.0.1:${upPort}` },
    { name: 'other', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${upPort}`, priority: 1 },
  ]);
  // Expire the circuit so the next selection enters half-open.
  am.accounts[0].circuitOpenUntil = Date.now() - 1;
  am.accounts[0].consecutiveFailures = 1;
  // Make "other" unavailable so the only eligible account is the half-open one.
  am.accounts[1].disabled = true;

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const port = await listen(proxy);
  try {
    const p1 = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'a' }] }),
    });
    // Let the first request select and acquire the probe before the second starts.
    await new Promise(r => setTimeout(r, 30));
    assert.equal(am.accounts[0].circuitProbeInFlight, true);

    const p2 = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'b' }] }),
    });
    await new Promise(r => setTimeout(r, 30));
    // Second request must not stampede the half-open account.
    assert.equal(hits, 1, 'only one trial may reach the half-open upstream');

    releaseUpstream();
    const r1 = await p1;
    await r1.text();
    const r2 = await p2;
    await r2.text();
    // After success the probe slot is free; the second request may have been
    // refused or served after — either way the in-flight stampede did not happen.
    assert.equal(am.accounts[0].circuitProbeInFlight, false);
  } finally {
    releaseUpstream();
    await close(proxy); await close(upstream);
  }
});
