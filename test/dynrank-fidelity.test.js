import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const SONNET = 'claude-sonnet-5';

// Dynamic mode is the subject — priority-first/shadow serve legacy semantics.
function dynmgr(accounts, extra = {}) {
  return new AccountManager(accounts, 0.98, { routingPolicy: { mode: 'dynamic' }, ...extra });
}

test('_fidelityRank detects faithful vs translated', () => {
  const am = new AccountManager([], 0.98);
  // oauth, no modelMap → native Anthropic → faithful
  assert.equal(am._fidelityRank({ type: 'oauth' }, SONNET), 0);
  // apikey, no modelMap → opaque adapter (codex/antigravity) → translated
  assert.equal(am._fidelityRank({ type: 'apikey' }, SONNET), 1);
  // identity modelMap → faithful
  assert.equal(am._fidelityRank({ type: 'apikey', modelMap: { [SONNET]: SONNET } }, SONNET), 0);
  // remap → translated
  assert.equal(am._fidelityRank({ type: 'apikey', modelMap: { [SONNET]: 'gpt-5.6' } }, SONNET), 1);
  // explicit hint overrides detection
  assert.equal(am._fidelityRank({ type: 'apikey', fidelity: 'faithful' }, SONNET), 0);
  assert.equal(am._fidelityRank({ type: 'oauth', fidelity: 'translated' }, SONNET), 1);
  // model absent from modelMap → falls through to type detection
  assert.equal(am._fidelityRank({ type: 'apikey', modelMap: { 'claude-opus-5': 'x' } }, SONNET), 1);
  assert.equal(am._fidelityRank({ type: 'oauth', modelMap: { 'claude-opus-5': 'x' } }, SONNET), 0);
  // no model → no fidelity distinction (rank 0)
  assert.equal(am._fidelityRank({ type: 'apikey' }, null), 0);
});

test('dynamicCompare prefers faithful over translated within a tier', () => {
  const am = dynmgr([
    { name: 'yongbing', type: 'oauth', accessToken: 'x', expiresAt: Date.now() + 3600_000, priority: 10 },
    { name: 'codex', type: 'apikey', apiKey: 'k', priority: 5 },
  ]);
  const [faithful, translated] = am.accounts;
  assert.ok(am.dynamicCompare(faithful, translated, SONNET) < 0);   // faithful first
  assert.ok(am.dynamicCompare(translated, faithful, SONNET) > 0);   // translated loses
});

test('_pickBestAvailable honors the requested model: faithful wins even at higher utilization', () => {
  const am = dynmgr([
    { name: 'yongbing', type: 'oauth', accessToken: 'x', expiresAt: Date.now() + 3600_000 },
    { name: 'codex', type: 'apikey', apiKey: 'k' },
  ]);
  // Faithful is nearly spent (0.90 weekly), translated is fresh (0.05) — fidelity
  // outranks use-it-or-lose-it, so the user's model pick still wins.
  am.accounts[0].quota.unified7dSonnet = 0.90;
  am.accounts[0].quota.unified7dSonnetReset = Date.now() + 3600_000;
  am.accounts[1].quota.unified7dSonnet = 0.05;
  am.accounts[1].quota.unified7dSonnetReset = Date.now() + 3600_000;
  const pick = am._pickBestAvailable(null, SONNET);
  assert.equal(pick.name, 'yongbing');
});

test('_pickBestAvailable falls back to translated only when faithful is exhausted', () => {
  const am = dynmgr([
    { name: 'yongbing', type: 'oauth', accessToken: 'x', expiresAt: Date.now() + 3600_000 },
    { name: 'codex', type: 'apikey', apiKey: 'k' },
  ]);
  am.accounts[0].quota.unified7dSonnet = 0.99;   // ≥ switchThreshold 0.98 → near-quota → unavailable
  am.accounts[0].quota.unified7dSonnetReset = Date.now() + 3600_000;
  const pick = am._pickBestAvailable(null, SONNET);
  assert.equal(pick.name, 'codex');
});

test('_shadowDiffReason reports the fidelity stage', () => {
  const am = dynmgr([
    { name: 'yongbing', type: 'oauth', accessToken: 'x', expiresAt: Date.now() + 3600_000, priority: 10 },
    { name: 'codex', type: 'apikey', apiKey: 'k', priority: 5 },
  ]);
  const [faithful, translated] = am.accounts;
  // legacy (priority-first) picks codex (priority 5 < 10); dynamic (fidelity-first) picks yongbing.
  const reason = am._shadowDiffReason(translated, faithful, SONNET);
  assert.equal(reason, 'fidelity');
});

test('_rankEvidence exposes the fidelity label', () => {
  const am = dynmgr([
    { name: 'yongbing', type: 'oauth', accessToken: 'x', expiresAt: Date.now() + 3600_000 },
    { name: 'codex', type: 'apikey', apiKey: 'k' },
  ]);
  assert.equal(am._rankEvidence(am.accounts[0], SONNET).fidelity, 'faithful');
  assert.equal(am._rankEvidence(am.accounts[1], SONNET).fidelity, 'translated');
});
