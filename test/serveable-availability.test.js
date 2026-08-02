import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function oauth(name, extra = {}) {
  return {
    name,
    type: 'oauth',
    accessToken: 't',
    refreshToken: 'r',
    expiresAt: Date.now() + 3600_000,
    ...extra,
  };
}

function snapshotBreaker(a) {
  return {
    circuitOpenUntil: a.circuitOpenUntil,
    circuitProbeInFlightAt: a.circuitProbeInFlightAt,
    consecutiveFailures: a.consecutiveFailures,
    status: a.status,
    rateLimitedUntil: a.rateLimitedUntil,
    quota: { ...a.quota },
  };
}

test('quota-exhausted account reports serveableNow:false and correct quotaResetAt on status', async () => {
  const resetAt = Date.now() + 3_600_000;
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].quota.unified7d = 0.99;
  am.accounts[0].quota.unified7dReset = resetAt;

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    assert.equal(res.status, 200);
    const status = await res.json();
    const acct = status.accounts.find(a => a.name === 'a');
    assert.ok(acct, 'account present');
    assert.equal(acct.serveableNow, false);
    assert.equal(acct.quotaResetAt, new Date(resetAt).toISOString());
  } finally {
    await close(proxy);
  }
});

test('circuit-open account reports reason circuit-open on serveable', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ]);
  const openUntil = Date.now() + 30_000;
  am.accounts[0].circuitOpenUntil = openUntil;

  const view = am.getServeable('any-model');
  assert.equal(view.serveable, false);
  assert.equal(view.accounts[0].serveableNow, false);
  assert.equal(view.accounts[0].reason, 'circuit-open');
});

test('status and serveable reads mutate nothing (breaker, probe claim, quota)', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ], 0.98);
  const a = am.accounts[0];
  a.circuitOpenUntil = Date.now() + 60_000;
  a.consecutiveFailures = 3;
  a.circuitProbeInFlightAt = Date.now();
  a.quota.unified7d = 0.99;
  a.quota.unified7dReset = Date.now() + 3_600_000;
  const before = snapshotBreaker(a);

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const statusRes = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    assert.equal(statusRes.status, 200);
    await statusRes.json();
    assert.deepEqual(snapshotBreaker(a), before, 'status must not mutate breaker/quota');

    const serveRes = await fetch(`http://127.0.0.1:${port}/teamclaude/serveable?model=claude-opus-4`);
    assert.equal(serveRes.status, 200);
    await serveRes.json();
    assert.deepEqual(snapshotBreaker(a), before, 'serveable must not mutate breaker/quota');
    assert.equal(a.circuitProbeInFlightAt, before.circuitProbeInFlightAt, 'no probe claim');
  } finally {
    await close(proxy);
  }
});

test('serveable?model respects modelMap/acceptsModels (closed adapter → not-accepted)', async () => {
  const am = new AccountManager([
    {
      name: 'ds',
      type: 'apikey',
      apiKey: 'k',
      upstream: 'http://127.0.0.1:9',
      acceptsModels: ['deepseek-chat', 'deepseek-reasoner'],
      strictModelMap: true,
      modelMap: { 'claude-sonnet-4-6': 'deepseek-chat' },
    },
  ]);

  const ok = am.getServeable('claude-sonnet-4-6');
  assert.equal(ok.serveable, true);
  assert.equal(ok.accounts[0].serveableNow, true);
  assert.equal(ok.accounts[0].reason, undefined);

  const bad = am.getServeable('claude-fugu-ultra');
  assert.equal(bad.serveable, false);
  assert.equal(bad.accounts[0].serveableNow, false);
  assert.equal(bad.accounts[0].reason, 'not-accepted');
  assert.equal(bad.model, 'claude-fugu-ultra');
});

test('GET /teamclaude/serveable returns fleet shape with soonestResetAt', async () => {
  const resetA = Date.now() + 2_000_000;
  const resetB = Date.now() + 1_000_000;
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.accounts[0].quota.unified7d = 0.99;
  am.accounts[0].quota.unified7dReset = resetA;
  am.accounts[1].quota.unified7d = 0.99;
  am.accounts[1].quota.unified7dReset = resetB;

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/serveable?model=claude-opus-4`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, 'claude-opus-4');
    assert.equal(body.serveable, false);
    assert.ok(Array.isArray(body.accounts));
    assert.equal(body.accounts.length, 2);
    assert.ok(body.accounts.every(a => a.serveableNow === false));
    assert.ok(body.accounts.every(a => a.reason === 'quota-exhausted'));
    assert.equal(body.soonestResetAt, new Date(resetB).toISOString());
  } finally {
    await close(proxy);
  }
});

test('bare status serveableNow is general (model=null) — not per-model truth', async () => {
  // Fable weekly spent: account is unserveable for Fable but still serveable in general.
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].quota.unified7dFable = 0.99;
  am.accounts[0].quota.unified7dFableReset = Date.now() + 3_600_000;
  // Shared weekly healthy so model=null availability is true.
  am.accounts[0].quota.unified7d = 0.10;
  am.accounts[0].quota.unified7dReset = Date.now() + 3_600_000;

  assert.equal(am._isAvailable(am.accounts[0], null), true, 'general availability');
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fable-5'), false, 'fable-scoped');

  const status = am.getStatus();
  assert.equal(status.accounts[0].serveableNow, true,
    'status.serveableNow must use model=null (general), not imply per-model truth');

  const fable = am.getServeable('claude-fable-5');
  assert.equal(fable.serveable, false);
  assert.equal(fable.accounts[0].reason, 'quota-exhausted');
});
