// B19: route-tier structure on HTTP evidence surfaces (/status, /serveable).
// Evidence only — no selection/routing change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function api(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9', ...extra };
}

/** fugu-shaped 0/1/1 tier structure from live config. */
function fuguAm() {
  return new AccountManager([
    api('sakana-fugu'),
    api('codex-gpt56'),
    api('deepseek-v4-flash'),
    oauth('other-acct'),
  ], 0.98, {
    routes: [{
      name: 'fugu',
      match: ['*fugu*'],
      tiers: [
        { accounts: ['sakana-fugu'] },
        { accounts: ['codex-gpt56', 'deepseek-v4-flash'] },
      ],
    }],
  });
}

test('status routes[] exposes tiers verbatim for tiered route; absent when untiered', () => {
  const am = new AccountManager([
    oauth('a'), oauth('b'), api('c'),
  ], 0.98, {
    routes: [
      {
        name: 'fugu',
        match: ['*fugu*'],
        tiers: [
          { accounts: ['a'] },
          { accounts: ['b', 'c'] },
        ],
      },
      {
        name: 'flat',
        match: ['*opus*'],
        accounts: ['a', 'b'],
      },
    ],
  });

  const routes = am.getRoutes();
  const fugu = routes.find(r => r.name === 'fugu');
  const flat = routes.find(r => r.name === 'flat');
  assert.ok(fugu && flat);

  assert.deepEqual(fugu.tiers, [
    { accounts: ['a'] },
    { accounts: ['b', 'c'] },
  ]);
  assert.equal(Object.hasOwn(flat, 'tiers'), false,
    'untiered route must omit tiers (not null, not [])');
  assert.equal(flat.tiers, undefined);
});

test('serveable?model on tiered route: routeTier 0/1/1 fugu shape via _costTierFor', () => {
  const am = fuguAm();
  const view = am.getServeable('claude-fugu');
  const byName = Object.fromEntries(view.accounts.map(a => [a.name, a]));

  assert.equal(byName['sakana-fugu'].routeTier, 0);
  assert.equal(byName['codex-gpt56'].routeTier, 1);
  assert.equal(byName['deepseek-v4-flash'].routeTier, 1);
  assert.equal(byName['sakana-fugu'].routeTierNote, undefined);
  assert.equal(byName['codex-gpt56'].routeTierNote, undefined);

  // Same numbers the ranker / _costTierFor produces.
  for (const a of am.accounts) {
    const tier = am._costTierFor(a, 'claude-fugu');
    const row = byName[a.name];
    if (Number.isFinite(tier)) {
      assert.equal(row.routeTier, tier);
    } else {
      assert.equal(row.routeTier, null);
      assert.equal(row.routeTierNote, 'untiered-on-tiered-route');
    }
  }
});

test('serveable: untiered-account-on-tiered-route → routeTier null + note', () => {
  const am = fuguAm();
  const view = am.getServeable('claude-fugu');
  const other = view.accounts.find(a => a.name === 'other-acct');
  assert.ok(other);
  assert.equal(other.routeTier, null);
  assert.equal(other.routeTierNote, 'untiered-on-tiered-route');
  assert.equal(am._costTierFor(am.accounts.find(a => a.name === 'other-acct'), 'claude-fugu'), Infinity);
});

test('serveable: untiered route omits routeTier entirely', () => {
  const am = new AccountManager([
    oauth('a'), oauth('b'),
  ], 0.98, {
    routes: [{ name: 'opus', match: ['*opus*'], accounts: ['a', 'b'] }],
  });
  const view = am.getServeable('claude-opus-4');
  for (const row of view.accounts) {
    assert.equal(Object.hasOwn(row, 'routeTier'), false, `${row.name} must omit routeTier`);
    assert.equal(Object.hasOwn(row, 'routeTierNote'), false);
  }
});

test('zero-config-inert: no tiers → status/serveable shapes omit tier fields', () => {
  const am = new AccountManager([
    oauth('a'), oauth('b'),
  ], 0.98, {
    routes: [{ name: 'all', match: ['*'], accounts: ['a', 'b'] }],
  });

  for (const r of am.getRoutes()) {
    assert.equal(Object.hasOwn(r, 'tiers'), false, `route ${r.name} must omit tiers`);
  }
  const view = am.getServeable('claude-opus-4');
  for (const row of view.accounts) {
    assert.equal(Object.hasOwn(row, 'routeTier'), false);
    assert.equal(Object.hasOwn(row, 'routeTierNote'), false);
  }
  // Baseline shape keys unchanged.
  assert.deepEqual(Object.keys(view).sort(), ['accounts', 'model', 'serveable', 'soonestResetAt'].sort());
  assert.deepEqual(Object.keys(view.accounts[0]).sort(),
    ['name', 'quotaResetAt', 'serveableNow'].sort());
});

test('GET /teamclaude/status and /serveable expose B19 fields over HTTP', async () => {
  const am = fuguAm();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const status = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
    const fugu = status.routes.find(r => r.name === 'fugu');
    assert.deepEqual(fugu.tiers, [
      { accounts: ['sakana-fugu'] },
      { accounts: ['codex-gpt56', 'deepseek-v4-flash'] },
    ]);

    const body = await (await fetch(`http://127.0.0.1:${port}/teamclaude/serveable?model=claude-fugu`)).json();
    const byName = Object.fromEntries(body.accounts.map(a => [a.name, a]));
    assert.equal(byName['sakana-fugu'].routeTier, 0);
    assert.equal(byName['codex-gpt56'].routeTier, 1);
    assert.equal(byName['deepseek-v4-flash'].routeTier, 1);
    assert.equal(byName['other-acct'].routeTier, null);
    assert.equal(byName['other-acct'].routeTierNote, 'untiered-on-tiered-route');
  } finally {
    await close(proxy);
  }
});

test('grep-proof: serveable tier resolution calls _costTierFor, not a duplicate', () => {
  const src = readFileSync(new URL('../src/account-manager.js', import.meta.url), 'utf8');
  assert.match(src, /_routeTierEvidence[\s\S]*_costTierFor/,
    '_routeTierEvidence must call _costTierFor');
  assert.match(src, /Object\.assign\(row, this\._routeTierEvidence/);
  // No parallel findIndex tier walk outside _costTierFor.
  const evidenceFn = src.match(/_routeTierEvidence\(account, model\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.ok(evidenceFn.includes('_costTierFor'));
  assert.doesNotMatch(evidenceFn, /findIndex/,
    '_routeTierEvidence must not re-implement tier index lookup');
});
