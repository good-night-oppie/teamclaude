// D4: hot-reload contract — operator intent over ranking inputs must apply
// without restart (tokenBudget, routingPolicy preserve-current, account prune,
// systemd health state dir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk, applyTopLevelReload } from '../src/config-reload.js';

function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k-' + name, ...extra };
}

// ── (a) tokenBudget reload-updatable ───────────────────────────────────────

test('D4a: reload with tighter tokenBudget governs admission; window not cleared', async () => {
  const mem = {
    accounts: [apikey('budgeted', {
      tokenBudget: { windowSec: 3600, maxTokens: 10_000 },
    })],
  };
  const am = new AccountManager(mem.accounts, 0.98);
  // Ephemeral window already has spend under the old budget.
  am.accounts[0].tokenWindow.push({ ts: Date.now(), tokens: 500 });
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), false);

  const disk = {
    accounts: [apikey('budgeted', {
      tokenBudget: { windowSec: 3600, maxTokens: 400 },
    })],
  };
  await syncAccountsFromDisk(disk, mem, am);

  assert.deepEqual(am.accounts[0].tokenBudget, { windowSec: 3600, maxTokens: 400 },
    'reload must update tokenBudget config without restart');
  assert.equal(am.accounts[0].tokenWindow.length, 1, 'window counters stay ephemeral in-memory');
  assert.equal(am.accounts[0].tokenWindow[0].tokens, 500, 'reload must NOT persist/reset window');
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), true,
    'new budget must govern admission against existing window sum');
  assert.equal(am._isAvailable(am.accounts[0], 'm'), false);
  assert.equal(am.getServeable('m').accounts[0].reason, 'token-budget');

  // exportQuotaState still omits the ephemeral window (R2 discipline).
  const exported = am.exportQuotaState();
  assert.equal(exported[0].tokenWindow, undefined);
  assert.equal(exported[0].tokenBudget, undefined);
});

test('D4a: reload removing tokenBudget restores zero-config-inert', async () => {
  const mem = {
    accounts: [apikey('budgeted', {
      tokenBudget: { windowSec: 3600, maxTokens: 100 },
    })],
  };
  const am = new AccountManager(mem.accounts, 0.98);
  am.accounts[0].tokenWindow.push({ ts: Date.now(), tokens: 100 });
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), true);

  await syncAccountsFromDisk({ accounts: [apikey('budgeted')] }, mem, am);
  assert.equal(am.accounts[0].tokenBudget, null);
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), false,
    'absent budget is inert even if a stale window array remains');
  assert.equal(am._isAvailable(am.accounts[0], 'm'), true);
});

// ── (b) routingPolicy preserve-current on reload ───────────────────────────

test('D4b: routingPolicy ABSENT on reload preserves running mode/affinity/reevaluateMs', () => {
  const mem = {
    accounts: [apikey('a')],
    routes: [{ name: 'all', match: ['*'], accounts: ['a'] }],
    routingPolicy: {
      mode: 'dynamic',
      preserveSessionAffinity: false,
      reevaluateMs: 12_345,
    },
    rotationGate: { mode: 'shadow' },
  };
  const am = new AccountManager(mem.accounts, 0.98, {
    routes: mem.routes,
    routingPolicy: mem.routingPolicy,
    rotationGate: mem.rotationGate,
  });
  const before = structuredClone(am.routingPolicy);
  const beforeGate = structuredClone(am.rotationGate);
  const beforeRoutes = structuredClone(am.getRoutes());

  // Disk omits routingPolicy / rotationGate / routes entirely (partial reload).
  applyTopLevelReload({ accounts: [apikey('a')] }, mem, am);

  assert.deepEqual(am.routingPolicy, before, 'byte-identical running policy');
  assert.deepEqual(mem.routingPolicy, before);
  assert.deepEqual(am.rotationGate, beforeGate, 'co-located rotationGate also preserve-current');
  assert.deepEqual(am.getRoutes(), beforeRoutes, 'co-located routes also preserve-current');
});

test('D4b: routingPolicy PRESENT with different mode applies; absent sibling keys preserved', () => {
  const mem = {
    accounts: [apikey('a')],
    routingPolicy: {
      mode: 'dynamic',
      preserveSessionAffinity: false,
      reevaluateMs: 12_345,
    },
  };
  const am = new AccountManager(mem.accounts, 0.98, { routingPolicy: mem.routingPolicy });

  applyTopLevelReload({
    accounts: [apikey('a')],
    routingPolicy: { mode: 'shadow' }, // explicit mode; affinity/reevaluateMs omitted
  }, mem, am);

  assert.equal(am.routingPolicy.mode, 'shadow', 'explicit present mode is operator intent');
  assert.equal(am.routingPolicy.preserveSessionAffinity, false, 'absent key preserves running');
  assert.equal(am.routingPolicy.reevaluateMs, 12_345, 'absent key preserves running');
});
