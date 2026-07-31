// D4: hot-reload contract — operator intent over ranking inputs must apply
// without restart (tokenBudget, routingPolicy preserve-current, account prune,
// systemd health state dir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/config-reload.js';

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
