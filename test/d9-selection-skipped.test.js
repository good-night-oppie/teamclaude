// D9: selection-time eligibility capture into provenance (skipped / skipped_more).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  ProvenanceBuffer,
  PROVENANCE_SAFE_FIELDS,
  buildProvenanceEvent,
} from '../src/provenance.js';
import { AccountManager, SELECTION_SKIPPED_CAP } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
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
  return { name, type: 'apikey', apiKey: 'k', ...extra };
}

function okUpstream() {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
      content: [], usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
}

test('D9: SAFE_FIELDS allowlists skipped + skipped_more; builder sanitizes', () => {
  assert.ok(PROVENANCE_SAFE_FIELDS.includes('skipped'));
  assert.ok(PROVENANCE_SAFE_FIELDS.includes('skipped_more'));
  const withSkips = buildProvenanceEvent({
    request_id: 'x-b-1', attempt: 1, final: true, outcome: 'ok',
    skipped: [{ a: 'tier0', r: 'quota-exhausted' }, { a: 'x', secret: 'LEAK' }],
    skipped_more: 2,
    body: 'PROMPT',
  }, { seq: 1, ts: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(withSkips.skipped, [{ a: 'tier0', r: 'quota-exhausted' }]);
  assert.equal(withSkips.skipped_more, 2);
  assert.equal(withSkips.body, undefined);
  assert.deepEqual(Object.keys(withSkips).sort(), [...PROVENANCE_SAFE_FIELDS].sort());

  const absent = buildProvenanceEvent({
    request_id: 'x-b-2', attempt: 1, final: true, outcome: 'ok',
  }, { seq: 2, ts: '2026-01-01T00:00:00.000Z' });
  assert.equal(absent.skipped, null);
  assert.equal(absent.skipped_more, null);
});

test('D9: tier-0 rate-limited → tier-1 serves with skipped reason', () => {
  const am = new AccountManager([
    oauth('sakana', { priority: 0 }),
    api('codex', { priority: 10 }),
  ], 0.98, {
    routes: [{
      name: 'fugu', match: ['*fugu*'],
      tiers: [
        { name: 't0', accounts: ['sakana'] },
        { name: 't1', accounts: ['codex'] },
      ],
    }],
    routingPolicy: { mode: 'dynamic', reevaluateMs: 0 },
  });
  am.markRateLimited(0, 3600);
  const chosen = am.getActiveAccount(null, 'claude-fugu-ultra');
  assert.equal(chosen.name, 'codex');
  const { skipped, skipped_more } = am.selectionSkippedAhead(chosen, 'claude-fugu-ultra');
  assert.deepEqual(skipped, [{ a: 'sakana', r: 'quota-exhausted' }]);
  assert.equal(skipped_more, undefined);
});

test('D9: tier-0 healthy → serves; skipped empty/absent', () => {
  const am = new AccountManager([
    oauth('sakana', { priority: 0 }),
    api('codex', { priority: 10 }),
  ], 0.98, {
    routes: [{
      name: 'fugu', match: ['*fugu*'],
      tiers: [
        { name: 't0', accounts: ['sakana'] },
        { name: 't1', accounts: ['codex'] },
      ],
    }],
    routingPolicy: { mode: 'dynamic', reevaluateMs: 0 },
  });
  const chosen = am.getActiveAccount(null, 'claude-fugu-ultra');
  assert.equal(chosen.name, 'sakana');
  const { skipped, skipped_more } = am.selectionSkippedAhead(chosen, 'claude-fugu-ultra');
  assert.equal(skipped, undefined);
  assert.equal(skipped_more, undefined);
});

test('D9: non-routed model → skipped absent', () => {
  const am = new AccountManager([
    oauth('a'), oauth('b'),
  ], 0.98, {
    routes: [{ name: 'fugu', match: ['*fugu*'], accounts: ['a'] }],
    routingPolicy: { mode: 'dynamic', reevaluateMs: 0 },
  });
  am.markRateLimited(0, 3600);
  const chosen = am.getActiveAccount(null, 'claude-opus-4');
  assert.ok(chosen);
  const { skipped, skipped_more } = am.selectionSkippedAhead(chosen, 'claude-opus-4');
  assert.equal(skipped, undefined);
  assert.equal(skipped_more, undefined);
});

test('D9: pinned selection → skipped absent (pin explains)', () => {
  const am = new AccountManager([
    oauth('sakana'), api('codex'),
  ], 0.98, {
    routes: [{
      name: 'fugu', match: ['*fugu*'],
      tiers: [
        { name: 't0', accounts: ['sakana'] },
        { name: 't1', accounts: ['codex'] },
      ],
    }],
    routingPolicy: { mode: 'dynamic', reevaluateMs: 0 },
  });
  am.markRateLimited(0, 3600);
  const chosen = am.accounts[1];
  const { skipped } = am.selectionSkippedAhead(chosen, 'claude-fugu-ultra', null, { pinned: true });
  assert.equal(skipped, undefined);
});

test('D9: >8 skipped candidates → cap + skipped_more', () => {
  assert.equal(SELECTION_SKIPPED_CAP, 8);
  const accounts = [];
  for (let i = 0; i < 10; i++) accounts.push(oauth(`t0-${i}`, { priority: i }));
  accounts.push(api('fallback', { priority: 100 }));
  const am = new AccountManager(accounts, 0.98, {
    routes: [{
      name: 'x', match: ['*'],
      tiers: [
        { name: 't0', accounts: accounts.slice(0, 10).map(a => a.name) },
        { name: 't1', accounts: ['fallback'] },
      ],
    }],
    routingPolicy: { mode: 'dynamic', reevaluateMs: 0 },
  });
  for (let i = 0; i < 10; i++) am.markRateLimited(i, 3600);
  const chosen = am.getActiveAccount(null, 'wire');
  assert.equal(chosen.name, 'fallback');
  const { skipped, skipped_more } = am.selectionSkippedAhead(chosen, 'wire');
  assert.equal(skipped.length, 8);
  assert.equal(skipped_more, 2);
  for (const row of skipped) {
    assert.equal(row.r, 'quota-exhausted');
    assert.match(row.a, /^t0-/);
  }
});

test('D9: field survives ProvenanceBuffer snapshot + GET /teamclaude/provenance', async () => {
  const buf = new ProvenanceBuffer({ size: 8 });
  buf.push({
    request_id: 'ep-b-1', attempt: 1, final: true, outcome: 'ok',
    path: '/v1/messages',
    skipped: [{ a: 'sakana', r: 'quota-exhausted' }],
    skipped_more: null,
  });
  const snap = buf.snapshot(0, 10);
  assert.deepEqual(snap.events[0].skipped, [{ a: 'sakana', r: 'quota-exhausted' }]);
  snap.events[0].skipped[0].a = 'mutated';
  assert.equal(buf.snapshot(0, 10).events[0].skipped[0].a, 'sakana');

  const upstream = okUpstream();
  const upPort = await listen(upstream);
  const am = new AccountManager([
    oauth('sakana', { priority: 0 }),
    { name: 'codex', type: 'apikey', apiKey: 'k', upstream: `http://127.0.0.1:${upPort}`, priority: 10 },
  ], 0.98, {
    routes: [{
      name: 'fugu', match: ['*fugu*'],
      tiers: [
        { name: 't0', accounts: ['sakana'] },
        { name: 't1', accounts: ['codex'] },
      ],
    }],
    routingPolicy: { mode: 'dynamic', reevaluateMs: 0 },
  });
  am.markRateLimited(0, 3600);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fugu-ultra', messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const pinnedRes = await fetch(`http://127.0.0.1:${port}/tc-acct/codex/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fugu-ultra', messages: [{ role: 'user', content: 'p' }] }),
    });
    assert.equal(pinnedRes.status, 200);
    await pinnedRes.text();

    const nonRouted = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'n' }] }),
    });
    assert.equal(nonRouted.status, 200);
    await nonRouted.text();

    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    const fuguFinal = prov.events.find(e => e.final && e.requested_model === 'claude-fugu-ultra' && e.pinned === false);
    assert.ok(fuguFinal, 'routed unpinned serve must emit final');
    assert.equal(fuguFinal.account, 'codex');
    assert.deepEqual(fuguFinal.skipped, [{ a: 'sakana', r: 'quota-exhausted' }]);

    const pinnedFinal = prov.events.find(e => e.final && e.pinned === true);
    assert.ok(pinnedFinal);
    assert.equal(pinnedFinal.skipped, null);
    assert.equal(pinnedFinal.skipped_more, null);

    const opusFinal = prov.events.find(e => e.final && e.requested_model === 'claude-opus-4');
    assert.ok(opusFinal);
    assert.equal(opusFinal.skipped, null);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
