import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function api(name, extra = {}) {
  return { name, type: 'apikey', apiKey: `k-${name}`, upstream: `http://127.0.0.1:${extra.port || 9000}`, ...extra };
}

function measured(am, idx, { u5 = 0.1, r5, u7 = 0.1, r7, f7, rf7 } = {}) {
  const q = am.accounts[idx].quota;
  if (u5 != null) q.unified5h = u5;
  if (r5 != null) q.unified5hReset = r5;
  if (u7 != null) q.unified7d = u7;
  if (r7 != null) q.unified7dReset = r7;
  if (f7 != null) q.unified7dFable = f7;
  if (rf7 != null) q.unified7dFableReset = rf7;
}

const NOW = Date.now();
const H = 60 * 60 * 1000;

// ── the production bug: seven priorities made auto rank unreachable ─────────

test('dynamic mode uses the quota that expires first even when every priority differs', () => {
  const am = new AccountManager([
    oauth('static-first', { priority: 0, costTier: 0 }),
    oauth('expires-first', { priority: 20, costTier: 0 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  measured(am, 0, { r7: NOW + 96 * H });
  measured(am, 1, { r7: NOW + 12 * H });
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'expires-first');
});

test('priority-first stays exactly legacy: priority dominates reset time', () => {
  const am = new AccountManager([
    oauth('static-first', { priority: 0, costTier: 0 }),
    oauth('expires-first', { priority: 20, costTier: 0 }),
  ], 0.98, { routingPolicy: { mode: 'priority-first' } });
  measured(am, 0, { r7: NOW + 96 * H });
  measured(am, 1, { r7: NOW + 12 * H });
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'static-first');
});

// ── hard economics boundary ────────────────────────────────────────────────

test('cost tier is a hard boundary: paid API cannot outrank sunk-cost quota', () => {
  const am = new AccountManager([
    oauth('subscription', { priority: 50, costTier: 0 }),
    api('payg', { priority: 0, costTier: 10 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  measured(am, 0, { r7: NOW + 7 * 24 * H, u7: 0.01 });
  // PAYG is opaque/unmeasured and statically preferred. Neither can cross tier 0.
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'subscription');
});

test('next cost tier becomes eligible after the cheaper tier is exhausted', () => {
  const am = new AccountManager([
    oauth('subscription', { priority: 50, costTier: 0 }),
    api('payg', { priority: 0, costTier: 10 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  measured(am, 0, { r7: NOW + H, u7: 0.99 });
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'payg');
});

// ── incomplete and stale evidence ──────────────────────────────────────────

test('reset without utilization is incomplete and cannot outrank a measured account', () => {
  const am = new AccountManager([
    oauth('partial', { priority: 0 }),
    oauth('complete', { priority: 50 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  am.accounts[0].quota.unified7dReset = NOW + H; // no utilization: corrupt/partial pair
  measured(am, 1, { r7: NOW + 48 * H });
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'complete');
});

test('expired reset does not pin an account at the top of dynamic order', () => {
  const am = new AccountManager([
    oauth('expired', { priority: 0 }),
    oauth('future', { priority: 50 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  measured(am, 0, { r7: NOW - H });
  measured(am, 1, { r7: NOW + H });
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'future');
});

test('unknown quota ranks after measured quota, never as zero-percent used', () => {
  const am = new AccountManager([
    api('opaque', { priority: 0 }),
    oauth('measured', { priority: 50 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  measured(am, 1, { r7: NOW + 72 * H });
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'measured');
});

// ── per-model windows ──────────────────────────────────────────────────────

test('dynamic ranking is model-specific: Fable and Opus can choose different accounts', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }), oauth('b', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  measured(am, 0, { r7: NOW + 8 * H, rf7: NOW + 80 * H, f7: 0.1 });
  measured(am, 1, { r7: NOW + 80 * H, rf7: NOW + 8 * H, f7: 0.1 });
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'a');
  assert.equal(am._pickBestAvailable(null, 'claude-fable-5').name, 'b');
});

// ── strict provider capability gate ────────────────────────────────────────

test('strictModelMap excludes an untranslated id before it can hard-400', () => {
  const am = new AccountManager([
    api('deepseek', {
      strictModelMap: true,
      acceptsModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      modelMap: { 'claude-sonnet-5': 'deepseek-v4-flash' },
    }),
    oauth('safe', { priority: 50 }),
  ], 0.98, {
    routes: [{ name: 'fugu', match: ['*fugu*'], accounts: ['deepseek', 'safe'] }],
    routingPolicy: { mode: 'dynamic' },
  });
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fugu-ultra'), false,
    'the exact live outage is prevented before account selection');
  assert.equal(am._pickBestAvailable(null, 'claude-fugu-ultra').name, 'safe');
});

test('strictModelMap admits a mapped id only when its TARGET is accepted', () => {
  const am = new AccountManager([api('deepseek', {
    strictModelMap: true,
    acceptsModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    modelMap: {
      good: 'deepseek-v4-pro',
      bad: 'not-a-deepseek-model',
    },
  })]);
  assert.equal(am._acceptsModel(am.accounts[0], 'good'), true);
  assert.equal(am._acceptsModel(am.accounts[0], 'bad'), false);
  assert.equal(am._acceptsModel(am.accounts[0], 'missing'), false);
});

test('open/opaque adapters remain permissive when no capability contract is declared', () => {
  const am = new AccountManager([api('sakana', { modelMap: null })]);
  assert.equal(am._acceptsModel(am.accounts[0], 'future-fugu-model'), true);
});

// ── shadow mode and cache stickiness ───────────────────────────────────────

test('shadow mode records a disagreement but serves the legacy account', () => {
  const am = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dynamic', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  measured(am, 0, { r7: NOW + 96 * H });
  measured(am, 1, { r7: NOW + H });
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'legacy');
  assert.equal(am._shadowDecisions.total, 1);
  assert.equal(am._shadowDecisions.changed, 1);
  assert.match(am._shadowDecisions.last, /legacy->dynamic/);
});

test('a healthy existing session remains pinned under dynamic mode', () => {
  const am = new AccountManager([
    oauth('home', { priority: 0 }), oauth('new-best', { priority: 20 }),
  ], 0.98, { distributeSessions: true, routingPolicy: { mode: 'dynamic' } });
  measured(am, 0, { r7: NOW + 96 * H });
  measured(am, 1, { r7: NOW + H });
  am.recordSession('s1', 0);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home',
    'reranking new work must not destroy this session prompt cache');
});

test('an exhausted pinned session reroutes by dynamic order and re-pins naturally', () => {
  const am = new AccountManager([
    oauth('home', { priority: 0 }), oauth('soon', { priority: 20 }), oauth('later', { priority: 40 }),
  ], 0.98, { distributeSessions: true, routingPolicy: { mode: 'dynamic' } });
  measured(am, 0, { r7: NOW + 96 * H, u7: 0.99 });
  measured(am, 1, { r7: NOW + H });
  measured(am, 2, { r7: NOW + 10 * H });
  am.recordSession('s1', 0);
  const next = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(next.name, 'soon');
  am.recordSession('s1', next.index);
  assert.equal(am.sessionTracker.pinnedAccount('s1'), next.index);
});

// ── passive custom-provider circuit breaker ────────────────────────────────

test('custom provider failure opens a bounded circuit; success heals it', () => {
  const am = new AccountManager([api('adapter')]);
  const a = am.accounts[0];
  const d1 = am.noteProviderResult(0, { ok: false, status: 503, latencyMs: 20 });
  assert.equal(d1, 2000);
  assert.equal(a.consecutiveFailures, 1);
  assert.ok(a.circuitOpenUntil > Date.now());
  assert.equal(am._isAvailable(a, 'x'), false, 'open circuit leaves selection');

  // Simulate half-open after the deadline, then a successful request.
  a.circuitOpenUntil = Date.now() - 1;
  assert.equal(am._isAvailable(a, 'x'), true);
  am.noteProviderResult(0, { ok: true, latencyMs: 10 });
  assert.equal(a.consecutiveFailures, 0);
  assert.equal(a.circuitOpenUntil, null);
  assert.equal(a.lastFailure, null);
  assert.ok(a.lastSuccessAt);
  assert.ok(a.latencyEwmaMs > 0);
});

test('real Anthropic accounts do not get a custom-adapter circuit', () => {
  const am = new AccountManager([oauth('real')]);
  assert.equal(am.noteProviderResult(0, { ok: false, status: 503 }), 0);
  assert.equal(am.accounts[0].consecutiveFailures, 0);
});

test('circuit backoff is exponential and capped at 60 seconds', () => {
  const am = new AccountManager([api('adapter')]);
  const delays = [];
  for (let i = 0; i < 10; i++) delays.push(am.noteProviderResult(0, { ok: false, status: 503 }));
  assert.deepEqual(delays.slice(0, 5), [2000, 4000, 8000, 16000, 32000]);
  assert.equal(delays.at(-1), 60000);
});

// ── hot policy reload ──────────────────────────────────────────────────────

test('updateAccountPolicy activates modelMap and capability changes in memory', () => {
  const am = new AccountManager([api('deepseek', { modelMap: null })]);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fugu-ultra'), true,
    'open adapter before the capability contract');
  const changed = am.updateAccountPolicy(0, {
    priority: 80,
    costTier: 10,
    upstream: 'http://127.0.0.1:8085',
    modelMap: { 'claude-fugu-ultra': 'deepseek-v4-pro' },
    acceptsModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    strictModelMap: true,
  });
  assert.ok(changed.includes('modelMap'));
  assert.ok(changed.includes('acceptsModels'));
  assert.equal(am.accounts[0].modelMap['claude-fugu-ultra'], 'deepseek-v4-pro');
  assert.equal(am._isAvailable(am.accounts[0], 'claude-fugu-ultra'), true);
  assert.equal(am._isAvailable(am.accounts[0], 'unknown-model'), false);
});

test('setRoutingPolicy hot-switches shadow to dynamic without rebuilding accounts', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }), oauth('b', { priority: 20 }),
  ], 0.98, {
    routingPolicy: { mode: 'shadow' },
  });
  measured(am, 0, { r7: NOW + 50 * H });
  measured(am, 1, { r7: NOW + H });
  assert.equal(am._pickBestAvailable().name, 'a');
  am.setRoutingPolicy({ mode: 'dynamic', reevaluateMs: 0 });
  assert.equal(am._pickBestAvailable().name, 'b');
});

test('dynamic winner stays sticky between reevaluations instead of bouncing to static priority', () => {
  const am = new AccountManager([
    oauth('static', { priority: 0 }), oauth('expires', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic', reevaluateMs: 300000 } });
  measured(am, 0, { r7: NOW + 96 * H });
  measured(am, 1, { r7: NOW + H });
  am.currentIndex = 0;
  am._dynamicEvalAtByKey.clear();
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'expires');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'expires',
    'the next request is inside the 5m window and must not static-preempt back');
});

// ── per-route economic/quality tiers ───────────────────────────────────────

test('route tiers override account costTier and preserve model-specific fallback quality', () => {
  const accounts = [
    oauth('claude-a', { costTier: 0, priority: 0 }),
    oauth('claude-b', { costTier: 0, priority: 20 }),
    api('fugu', { costTier: 0, priority: 30 }),
    api('codex', { costTier: 0, priority: 40 }),
    api('deepseek', { costTier: 0, priority: 80 }),
  ];
  const am = new AccountManager(accounts, 0.98, {
    routes: [{
      name: 'fable', match: ['*fable*'],
      tiers: [
        { name: 'claude', accounts: ['claude-a', 'claude-b'] },
        { name: 'fugu', accounts: ['fugu'] },
        { name: 'codex', accounts: ['codex'] },
        { name: 'payg', accounts: ['deepseek'] },
      ],
    }],
    routingPolicy: { mode: 'dynamic' },
  });
  measured(am, 0, { r7: NOW + 80 * H });
  measured(am, 1, { r7: NOW + H });
  // fugu has account costTier 0 too, but route tier 1: it cannot jump ahead of
  // either Claude account. Inside route tier 0, reset time picks claude-b.
  assert.equal(am._pickBestAvailable(null, 'claude-fable-5').name, 'claude-b');
  am.accounts[0].status = 'exhausted';
  am.accounts[1].status = 'exhausted';
  assert.equal(am._pickBestAvailable(null, 'claude-fable-5').name, 'fugu');
  am.accounts[2].status = 'exhausted';
  assert.equal(am._pickBestAvailable(null, 'claude-fable-5').name, 'codex');
});

test('per-request failover exhausts peers in one route tier before advancing', () => {
  const am = new AccountManager([
    oauth('a'), oauth('b'), api('fallback'),
  ], 0.98, {
    routes: [{ name: 'x', match: ['*'], tiers: [
      { name: 'subscription', accounts: ['a', 'b'] },
      { name: 'fallback', accounts: ['fallback'] },
    ] }],
    routingPolicy: { mode: 'dynamic' },
  });
  measured(am, 0, { r7: NOW + 5 * H });
  measured(am, 1, { r7: NOW + H });
  const first = am._pickBestAvailable(null, 'x');
  assert.equal(first.name, 'b');
  const second = am._pickBestAvailable(new Set([first.index]), 'x');
  assert.equal(second.name, 'a', 'same tier peer before later fallback tier');
  const third = am._pickBestAvailable(new Set([first.index, second.index]), 'x');
  assert.equal(third.name, 'fallback');
});

test('shadow mode is zero-impact: session ids do not enable affinity when distribution is off', () => {
  const am = new AccountManager([
    oauth('legacy-current', { priority: 0 }), oauth('dynamic-best', { priority: 20 }),
  ], 0.98, { distributeSessions: false, routingPolicy: { mode: 'shadow', reevaluateMs: 0 } });
  measured(am, 0, { r7: NOW + 90 * H });
  measured(am, 1, { r7: NOW + H });
  am.recordSession('s', 1); // if shadow accidentally honors affinity it returns dynamic-best
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's').name, 'legacy-current');
  assert.ok(am._shadowDecisions.changed > 0, 'dynamic disagreement is still observed');
});

test('last-resort probe respects capability and route tier before priority', () => {
  const am = new AccountManager([
    api('bad-cheap', { priority: 0, strictModelMap: true, acceptsModels: ['native'], modelMap: {} }),
    oauth('tier0', { priority: 50 }),
    api('tier1', { priority: 0 }),
  ], 0.98, {
    routes: [{ name: 'x', match: ['*'], tiers: [
      { name: 'first', accounts: ['bad-cheap', 'tier0'] },
      { name: 'second', accounts: ['tier1'] },
    ] }],
  });
  // Make normal selection unavailable via quota, but keep them probeable.
  for (const a of am.accounts) { a.quota.unified5h = 1; a.quota.unified5hReset = NOW + H; }
  const p = am._selectProbe(null, 'wire');
  assert.equal(p.name, 'tier0', 'bad capability excluded; later tier cannot jump ahead by priority');
});

test('no-session dynamic stickiness is per model; Fable cannot overwrite Opus home', () => {
  const am = new AccountManager([
    oauth('a'), oauth('b'),
  ], 0.98, { routingPolicy: { mode: 'dynamic', reevaluateMs: 300000 } });
  // Opus prefers a; Fable prefers b.
  measured(am, 0, { r7: NOW + H, rf7: NOW + 80 * H, f7: 0.1 });
  measured(am, 1, { r7: NOW + 80 * H, rf7: NOW + H, f7: 0.1 });
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'a');
  assert.equal(am.getActiveAccount(null, 'claude-fable-5').name, 'b');
  assert.equal(am.currentIndex, 1, 'last-served marker follows Fable');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'a',
    'Opus uses its own cached dynamic home, not global currentIndex');
});

// ── B5: shadow neutrality + evidential counters ────────────────────────────

test('shadow+distributeSessions is request-path neutral vs priority-first', () => {
  const mk = (mode) => {
    const am = new AccountManager([
      oauth('high', { priority: 0 }), oauth('low', { priority: 20 }),
    ], 0.98, { distributeSessions: true, routingPolicy: { mode } });
    measured(am, 0, { r7: NOW + 96 * H });
    measured(am, 1, { r7: NOW + H });
    // Session pinned to the lower-priority account — priority-first preempts;
    // a non-neutral shadow would keep the pin (dynamic affinity).
    am.recordSession('s1', 1);
    return am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name;
  };
  assert.equal(mk('priority-first'), 'high');
  assert.equal(mk('shadow'), 'high', 'shadow must not change routing when distributeSessions is on');
  assert.equal(mk('dynamic'), 'low', 'dynamic keeps the session home');
});

test('shadowDecisions counts per request, including the session path', () => {
  const am = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dynamic', { priority: 20 }),
  ], 0.98, {
    distributeSessions: true,
    routingPolicy: { mode: 'shadow', reevaluateMs: 60 * 60 * 1000 }, // long tick
  });
  measured(am, 0, { r7: NOW + 96 * H });
  measured(am, 1, { r7: NOW + H });
  am.recordSession('s', 0);
  for (let i = 0; i < 10; i++) {
    assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's').name, 'legacy');
  }
  assert.equal(am._shadowDecisions.total, 10,
    '1000 requests must not collapse to total=1 via reevaluate ticks');
  assert.equal(am._shadowDecisions.changed, 10, 'session path must observe dynamic disagreement');
});

test('shadowDecisions survive export → restore (restart persistence)', () => {
  const am1 = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dynamic', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  measured(am1, 0, { r7: NOW + 96 * H });
  measured(am1, 1, { r7: NOW + H });
  am1.getActiveAccount(null, 'claude-opus-4-8');
  am1.getActiveAccount(null, 'claude-opus-4-8');
  const snap = am1.exportShadowDecisions();
  assert.equal(snap.total, 2);
  assert.equal(snap.changed, 2);

  const am2 = new AccountManager([
    oauth('legacy', { priority: 0 }), oauth('dynamic', { priority: 20 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  am2.restoreShadowDecisions(snap);
  assert.deepEqual(am2.exportShadowDecisions(), snap);
  assert.equal(am2.getStatus().shadowDecisions.total, 2);
});

// RF-3: when the half-open probe slot is held, getActiveAccount recurses with
// the account excluded. Observation must happen exactly once per external call
// — not again on the recursive hop.
test('probe-held recursion records exactly one shadow decision', () => {
  const am = new AccountManager([
    api('probe', { priority: 0, port: 9 }),
    api('fallback', { priority: 1, port: 9 }),
  ], 0.98, { routingPolicy: { mode: 'shadow' } });
  // Half-open on the preferred account so it is selected first.
  am.accounts[0].circuitOpenUntil = Date.now() - 1;
  am.accounts[0].consecutiveFailures = 1;

  // Simulate the TOCTOU race: another request already claimed between select
  // and acquire. Force the first acquire to fail so we recurse once.
  const realAcquire = am._acquireCircuitProbe.bind(am);
  let acquires = 0;
  am._acquireCircuitProbe = (account) => {
    acquires += 1;
    if (acquires === 1) return false;
    return realAcquire(account);
  };

  const chosen = am.getActiveAccount(null, 'claude-sonnet-5');
  assert.equal(chosen.name, 'fallback');
  assert.equal(am._shadowDecisions.total, 1,
    'probe-held recursion must not double-count shadow evidence');
});

// ── T9: dynamic-only correctness ───────────────────────────────────────────

test('T9-1: removeAccount reindexes dynamic maps so stickiness still names the same account', () => {
  const am = new AccountManager([
    oauth('a'), oauth('b'), oauth('c'),
  ], 0.98, { routingPolicy: { mode: 'dynamic', reevaluateMs: 300000 } });
  measured(am, 0, { r7: NOW + 90 * H });
  measured(am, 1, { r7: NOW + H });
  measured(am, 2, { r7: NOW + 50 * H });
  const model = 'claude-opus-4-8';
  const key = am._dynamicKey(model);
  // Stick the no-session key on B (index 1).
  am._dynamicCurrentByKey.set(key, 1);
  am._dynamicEvalAtByKey.set(key, Date.now());
  am.currentIndex = 1;
  am.removeAccount(0); // drop A; B must remain B, not shift onto former C
  assert.equal(am.accounts[0].name, 'b');
  assert.equal(am.getActiveAccount(null, model).name, 'b',
    'dynamic stickiness must follow B after the index shift, not land on C or undefined');
});
