import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayRank, formatRankReplay } from '../src/rank-replay.js';

function oauth(name, extra = {}) { return { name, type: 'oauth', priority: 0, ...extra }; }

const NOW = Date.now();
const H = 60 * 60 * 1000;

function quotaEntry(name, { reset } = {}) {
  return { name, quota: { unified7d: 0.1, unified7dReset: reset } };
}

test('replayRank never mutates the caller config and never touches the network', () => {
  const config = {
    switchThreshold: 0.98,
    accounts: [oauth('a', { priority: 0 }), oauth('b', { priority: 20 })],
    routes: [], routingPolicy: { mode: 'dynamic' },
  };
  const savedQuota = [quotaEntry('a', { reset: NOW + 90 * H }), quotaEntry('b', { reset: NOW + H })];
  const before = JSON.stringify(config);
  const r = replayRank(config, savedQuota, 'claude-opus-4-8');
  assert.equal(JSON.stringify(config), before, 'pure: config is not mutated');
  assert.equal(r.legacy.account, 'a');
  assert.equal(r.dynamic.account, 'b');
  assert.equal(r.changed, true);
});

test('formatRankReplay renders human-readable output including candidate order', () => {
  const config = {
    accounts: [oauth('a', { priority: 0 }), oauth('b', { priority: 20 })],
    routes: [], routingPolicy: { mode: 'dynamic' },
  };
  const savedQuota = [quotaEntry('a', { reset: NOW + 90 * H }), quotaEntry('b', { reset: NOW + H })];
  const out = formatRankReplay(replayRank(config, savedQuota, 'claude-opus-4-8'));
  assert.match(out, /legacy\s+a/);
  assert.match(out, /dynamic\s+b/);
  assert.match(out, /CHANGED/);
  assert.match(out, /1\. b/);
});

test('replayRank with no saved quota still runs and reports unknown evidence', () => {
  const config = { accounts: [oauth('a')], routes: [] };
  const r = replayRank(config, null, 'claude-opus-4-8');
  assert.equal(r.legacy.account, 'a');
  assert.equal(r.legacy.weeklyReset, null);
});

test('replayRank respects route tiers, not just account costTier', () => {
  const config = {
    accounts: [
      oauth('subscription', { priority: 50, costTier: 0 }),
      { name: 'payg', type: 'apikey', apiKey: 'k', upstream: 'http://x', priority: 0, costTier: 0 },
    ],
    routes: [{ name: 'x', match: ['*'], tiers: [
      { name: 'sub', accounts: ['subscription'] },
      { name: 'payg', accounts: ['payg'] },
    ] }],
    routingPolicy: { mode: 'dynamic' },
  };
  const r = replayRank(config, null, 'x');
  assert.equal(r.dynamic.account, 'subscription', 'route tier must win even though account costTier ties');
});
