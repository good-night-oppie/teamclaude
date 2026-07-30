// D2: shadow decision evidence ring + GET /teamclaude/shadow-decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  AccountManager,
  SHADOW_DECISION_RING_SIZE,
  SHADOW_DECISION_SAFE_FIELDS,
  SHADOW_EVIDENCE_SAFE_FIELDS,
} from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function oauth(name, extra = {}) {
  return {
    name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r',
    expiresAt: Date.now() + 3600_000, ...extra,
  };
}

function api(name, extra = {}) {
  return {
    name, type: 'apikey', apiKey: `k-${name}`,
    upstream: `http://127.0.0.1:${extra.port || 9000}`, ...extra,
  };
}

const H = 60 * 60 * 1000;

function measured(am, idx, { u5 = 0.1, r5, u7 = 0.1, r7 } = {}) {
  const q = am.accounts[idx].quota;
  if (u5 != null) q.unified5h = u5;
  if (r5 != null) q.unified5hReset = r5;
  if (u7 != null) q.unified7d = u7;
  if (r7 != null) q.unified7dReset = r7;
}

function assertAllowlisted(rec) {
  for (const k of Object.keys(rec)) {
    assert.ok(SHADOW_DECISION_SAFE_FIELDS.includes(k), `unexpected decision field: ${k}`);
  }
  for (const side of ['legacyEvidence', 'dynamicEvidence']) {
    const e = rec[side];
    if (!e) continue;
    for (const k of Object.keys(e)) {
      assert.ok(SHADOW_EVIDENCE_SAFE_FIELDS.includes(k), `unexpected evidence field: ${k}`);
    }
    assert.equal(e.apiKey, undefined);
    assert.equal(e.accessToken, undefined);
    assert.equal(e.tokens, undefined);
  }
}

test('D2: ring capacity 512 with rollover (oldest dropped)', () => {
  const am = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dyn', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  const now = Date.now();
  measured(am, 0, { r7: now + 96 * H });
  measured(am, 1, { r7: now + H });

  for (let i = 0; i < SHADOW_DECISION_RING_SIZE + 10; i++) {
    am.getActiveAccount(null, `m-${i}`);
  }
  const snap = am.getShadowDecisions();
  assert.equal(snap.capacity, 512);
  assert.equal(snap.size, 512);
  assert.equal(snap.decisions.length, 512);
  // After 522 pushes, retained window is models m-10 … m-521.
  assert.equal(snap.decisions[0].model, 'm-10');
  assert.equal(snap.decisions[511].model, 'm-521');
  assert.equal(am._shadowDecisions.total, SHADOW_DECISION_RING_SIZE + 10);
});

test('D2: reason attribution per comparator stage', () => {
  const now = Date.now();

  // weekly
  {
    const am = new AccountManager([
      oauth('a', { priority: 0, costTier: 0 }),
      oauth('b', { priority: 20, costTier: 0 }),
    ], 0.98, { routingPolicy: { mode: 'shadow' } });
    measured(am, 0, { r7: now + 96 * H });
    measured(am, 1, { r7: now + H });
    am.getActiveAccount(null, 'claude-opus-4-8');
    assert.equal(am.getShadowDecisions().decisions[0].reason, 'weekly');
  }

  // session (weekly tied)
  {
    const am = new AccountManager([
      oauth('a', { priority: 0, costTier: 0 }),
      oauth('b', { priority: 20, costTier: 0 }),
    ], 0.98, { routingPolicy: { mode: 'shadow' } });
    measured(am, 0, { r7: now + 48 * H, r5: now + 5 * H, u5: 0.2 });
    measured(am, 1, { r7: now + 48 * H, r5: now + H, u5: 0.2 });
    am.getActiveAccount(null, 'claude-opus-4-8');
    assert.equal(am.getShadowDecisions().decisions[0].reason, 'session');
  }

  // utilization (weekly + session tied)
  {
    const am = new AccountManager([
      oauth('a', { priority: 0, costTier: 0 }),
      oauth('b', { priority: 20, costTier: 0 }),
    ], 0.98, { routingPolicy: { mode: 'shadow' } });
    measured(am, 0, { r7: now + 48 * H, r5: now + 3 * H, u5: 0.9, u7: 0.1 });
    measured(am, 1, { r7: now + 48 * H, r5: now + 3 * H, u5: 0.1, u7: 0.1 });
    am.getActiveAccount(null, 'claude-opus-4-8');
    assert.equal(am.getShadowDecisions().decisions[0].reason, 'utilization');
  }

  // priority (all signals tied — dynamic still prefers lower priority via tie)
  {
    const am = new AccountManager([
      oauth('high-prio-num', { priority: 0, costTier: 0 }),
      oauth('low-prio-num', { priority: 20, costTier: 0 }),
    ], 0.98, { routingPolicy: { mode: 'shadow' } });
    measured(am, 0, { r7: now + 48 * H, r5: now + 3 * H, u5: 0.2, u7: 0.1 });
    measured(am, 1, { r7: now + 48 * H, r5: now + 3 * H, u5: 0.2, u7: 0.1 });
    am.getActiveAccount(null, 'claude-opus-4-8');
    const rec = am.getShadowDecisions().decisions[0];
    // Same signals → same pick under both orders (stable) → equal.
    assert.equal(rec.changed, false);
    assert.equal(rec.reason, 'equal');
  }

  // tier
  {
    const am = new AccountManager([
      api('payg', { priority: 0, costTier: 10 }),
      oauth('sub', { priority: 50, costTier: 0 }),
    ], 0.98, { routingPolicy: { mode: 'shadow' } });
    measured(am, 1, { r7: now + 48 * H, r5: now + 3 * H });
    // legacy prefers payg (priority 0); dynamic prefers sub (tier 0).
    am.getActiveAccount(null, 'claude-opus-4-8');
    const rec = am.getShadowDecisions().decisions[0];
    assert.equal(rec.changed, true);
    assert.equal(rec.reason, 'tier');
    assert.equal(rec.legacy, 'payg');
    assert.equal(rec.dynamic, 'sub');
  }
});

test('D2: dynamicPickServeable is honest vs _isAvailable', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dyn', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  measured(am, 0, { r7: now + 96 * H });
  measured(am, 1, { r7: now + H });
  am.getActiveAccount(null, 'claude-opus-4-8');
  const rec = am.getShadowDecisions().decisions[0];
  const dyn = am.accounts.find(a => a.name === rec.dynamic);
  assert.equal(rec.dynamicPickServeable, am._isAvailable(dyn, 'claude-opus-4-8'));
  assert.equal(rec.dynamicPickServeable, true);
});

test('D2: status gains ringSize/changedRate/reasonHistogram; counters preserved', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dyn', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  measured(am, 0, { r7: now + 96 * H });
  measured(am, 1, { r7: now + H });
  am.getActiveAccount(null, 'claude-opus-4-8');
  am.getActiveAccount(null, 'claude-opus-4-8');
  const sd = am.getStatus().shadowDecisions;
  assert.equal(sd.total, 2);
  assert.equal(sd.changed, 2);
  assert.ok(sd.last);
  assert.equal(sd.ringSize, 2);
  assert.equal(sd.changedRate, 1);
  assert.equal(sd.reasonHistogram.weekly, 2);
  assert.equal(sd.reasonHistogram.equal, 0);
});

test('D2: ring is ephemeral — export/restore does not carry decisions', () => {
  const now = Date.now();
  const am1 = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dyn', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  measured(am1, 0, { r7: now + 96 * H });
  measured(am1, 1, { r7: now + H });
  am1.getActiveAccount(null, 'claude-opus-4-8');
  const snap = am1.exportShadowDecisions();
  assert.deepEqual(Object.keys(snap).sort(), ['changed', 'last', 'total']);
  assert.equal(am1.getShadowDecisions().size, 1);

  const am2 = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dyn', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  am2.restoreShadowDecisions(snap);
  assert.equal(am2._shadowDecisions.total, 1);
  assert.equal(am2.getShadowDecisions().size, 0, 'ring must not survive restore');
  assert.equal(am2.getStatus().shadowDecisions.ringSize, 0);
});

test('D2: shadow mode records without affecting selection (serves legacy)', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dyn', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  measured(am, 0, { r7: now + 96 * H });
  measured(am, 1, { r7: now + H });
  assert.equal(am.routingPolicy.mode, 'shadow');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'legacy');
  const rec = am.getShadowDecisions().decisions[0];
  assert.equal(rec.legacy, 'legacy');
  assert.equal(rec.dynamic, 'dyn');
  assert.equal(rec.changed, true);
  // priority-first semantic: served name === legacy pick
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'legacy');
});

test('D2: endpoint field allowlist + naked GET returns full ring (R0 class)', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
      content: [], usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const upPort = await listen(upstream);
  const now = Date.now();
  const am = new AccountManager([
    oauth('legacy', { priority: 0 }),
    oauth('dyn', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  measured(am, 0, { r7: now + 96 * H });
  measured(am, 1, { r7: now + H });

  // Fill past the old provenance footgun threshold (256) via direct observation.
  for (let i = 0; i < 300; i++) {
    am.getActiveAccount(null, `fill-${i}`);
  }
  // One more identifiable decision after the fill storm.
  am.getActiveAccount(null, 'claude-opus-4-8');

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const naked = await (await fetch(
      `http://127.0.0.1:${port}/teamclaude/shadow-decisions`,
    )).json();
    assert.equal(naked.capacity, 512);
    assert.ok(naked.decisions.length > 256, 'default must exceed old 256 footgun');
    assert.equal(naked.decisions.length, naked.size);
    assert.equal(naked.decisions.at(-1).model, 'claude-opus-4-8');
    for (const rec of naked.decisions) assertAllowlisted(rec);

    const capped = await (await fetch(
      `http://127.0.0.1:${port}/teamclaude/shadow-decisions?limit=256`,
    )).json();
    assert.equal(capped.decisions.length, 256);
    assert.ok(
      capped.decisions.at(-1).model !== 'claude-opus-4-8',
      'explicit small limit still returns oldest half (R0 illusion class)',
    );

    // Status summary present.
    const st = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
    assert.equal(st.shadowDecisions.ringSize, 301);
    assert.ok(st.shadowDecisions.reasonHistogram.weekly >= 1);
    assert.ok(typeof st.shadowDecisions.changedRate === 'number');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
