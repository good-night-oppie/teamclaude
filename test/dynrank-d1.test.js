// D1: tokenBudget feeds dynamic comparator as synthetic session expiry + utilization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

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

test('D1: accounts without tokenBudget stay on pre-D1 signal formulas (zero-config-inert)', () => {
  const am = new AccountManager([
    oauth('measured', { priority: 0, costTier: 0 }),
    api('opaque', { priority: 0, costTier: 0 }),
    oauth('partial', { priority: 10, costTier: 0 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  const now = Date.now();
  am.accounts[0].quota.unified7d = 0.2;
  am.accounts[0].quota.unified7dReset = now + 48 * H;
  am.accounts[0].quota.unified5h = 0.4;
  am.accounts[0].quota.unified5hReset = now + 3 * H;
  // partial: reset without utilization — incomplete (pre-D1 stale-probe defense)
  am.accounts[2].quota.unified5hReset = now + H;

  for (const a of am.accounts) {
    assert.equal(a.tokenBudget, null, 'no account carries tokenBudget');
  }

  // Pre-D1 formulas, verbatim:
  assert.equal(am._completeSessionReset(am.accounts[0], now), now + 3 * H);
  assert.equal(am._completeSessionReset(am.accounts[1], now), Infinity);
  assert.equal(am._completeSessionReset(am.accounts[2], now), Infinity,
    'reset-without-utilization still incomplete');
  assert.equal(am._dynamicUtilization(am.accounts[0], 'claude-opus-4-8'), 0.4);
  assert.equal(am._dynamicUtilization(am.accounts[1], 'claude-opus-4-8'), Infinity);
  assert.equal(am._dynamicUtilization(am.accounts[2], 'claude-opus-4-8'), Infinity);

  // Pairwise dynamicCompare must prefer measured over opaque (unknown cannot masquerade).
  assert.ok(am.dynamicCompare(am.accounts[0], am.accounts[1], 'claude-opus-4-8', now) < 0);
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'measured');
});

test('D1: empty-window budgeted account stays Infinity (honesty rule)', () => {
  const now = Date.now();
  const am = new AccountManager([
    api('budgeted', {
      tokenBudget: { windowSec: 3600, maxTokens: 1_000_000 },
      priority: 0, costTier: 0,
    }),
    oauth('measured', { priority: 50, costTier: 0 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  am.accounts[1].quota.unified7d = 0.1;
  am.accounts[1].quota.unified7dReset = now + 72 * H;
  am.accounts[1].quota.unified5h = 0.2;
  am.accounts[1].quota.unified5hReset = now + 4 * H;

  assert.deepEqual(am.accounts[0].tokenWindow, []);
  assert.equal(am._completeSessionReset(am.accounts[0], now), Infinity);
  assert.equal(am._dynamicUtilization(am.accounts[0], 'claude-opus-4-8'), Infinity);
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'measured',
    'empty budget window must not outrank honest oauth evidence');
});

test('D1: budgeted account with traffic ranks by roll-off vs oauth session reset', () => {
  const now = Date.now();
  const windowSec = 3600;
  const am = new AccountManager([
    api('budgeted', {
      tokenBudget: { windowSec, maxTokens: 5_000_000 },
      priority: 50, costTier: 0,
      // Tie fidelity with the oauth account so the session-reset stage decides:
      // fidelity precedes session in dynamicCompare (see dynrank-fidelity.test.js).
      fidelity: 'faithful',
    }),
    oauth('oauth', { priority: 0, costTier: 0 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });

  // Tie weekly so the session stage decides.
  am.accounts[0].quota.unified7d = 0.1;
  am.accounts[0].quota.unified7dReset = now + 48 * H;
  am.accounts[1].quota.unified7d = 0.1;
  am.accounts[1].quota.unified7dReset = now + 48 * H;
  am.accounts[1].quota.unified5h = 0.3;
  am.accounts[1].quota.unified5hReset = now + 5 * H; // later than budget roll-off

  const oldest = now - 10 * 60 * 1000;
  am.accounts[0].tokenWindow.push({ ts: oldest, tokens: 1000 });
  const rollOff = oldest + windowSec * 1000;
  assert.equal(am._completeSessionReset(am.accounts[0], now), rollOff);
  assert.ok(rollOff < am.accounts[1].quota.unified5hReset);
  assert.equal(am._pickBestAvailable(null, 'claude-opus-4-8').name, 'budgeted');
});

test('D1: utilization blends windowSum/maxTokens into max-of-signals', () => {
  const now = Date.now();
  const am = new AccountManager([
    api('budgeted', {
      tokenBudget: { windowSec: 3600, maxTokens: 1000 },
      priority: 0, costTier: 0,
    }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  am.accounts[0].quota.unified5h = 0.25;
  am.accounts[0].tokenWindow.push({ ts: now - 1000, tokens: 600 });
  // max(0.25, 0.6) = 0.6
  assert.equal(am._dynamicUtilization(am.accounts[0], 'claude-opus-4-8'), 0.6);

  am.accounts[0].tokenWindow[0].tokens = 100;
  am.accounts[0].quota.unified5h = 0.8;
  assert.equal(am._dynamicUtilization(am.accounts[0], 'claude-opus-4-8'), 0.8);
});

test('D1: budget-tripped account is excluded by _isAvailable before ranking', () => {
  const now = Date.now();
  const am = new AccountManager([
    api('tripped', {
      tokenBudget: { windowSec: 3600, maxTokens: 100 },
      priority: 0, costTier: 0,
    }),
    api('spare', { priority: 10, costTier: 0 }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  am.accounts[0].tokenWindow.push({ ts: now - 1000, tokens: 200 });
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), true);
  assert.equal(am._isAvailable(am.accounts[0], 'm'), false);
  assert.equal(am._pickBestAvailable(null, 'm').name, 'spare');
  // Synthetic session signal exists, but selection never consults a tripped account.
  assert.notEqual(am._completeSessionReset(am.accounts[0], now), Infinity);
});

test('D1: header-derived session signal still beats tokenBudget when both present', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('both', {
      tokenBudget: { windowSec: 3600, maxTokens: 1_000_000 },
      priority: 0,
    }),
  ], 0.98, { routingPolicy: { mode: 'dynamic' } });
  am.accounts[0].quota.unified5h = 0.1;
  am.accounts[0].quota.unified5hReset = now + 2 * H;
  am.accounts[0].tokenWindow.push({ ts: now - 1000, tokens: 50 });
  assert.equal(am._completeSessionReset(am.accounts[0], now), now + 2 * H,
    'oauth 5h reset remains authoritative when complete');
});
