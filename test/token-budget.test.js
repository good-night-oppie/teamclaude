// R2: per-account client-side token budgeting (zero-config-inert).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function apikey(name, key, upstream, extra = {}) {
  return { name, type: 'apikey', apiKey: key, upstream, priority: extra.priority ?? 0, ...extra };
}

function okBody(usage = { input_tokens: 100, output_tokens: 50 }) {
  return JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    usage,
  });
}

test('R2: absent tokenBudget is zero-config-inert (no window, always serveable)', async () => {
  const am = new AccountManager([
    apikey('plain', 'k', 'http://127.0.0.1:9'),
  ]);
  assert.equal(am.accounts[0].tokenBudget, null);
  assert.deepEqual(am.accounts[0].tokenWindow, []);
  am.recordTokenBudget(0, { input: 9_999_999, output: 9_999_999 });
  assert.deepEqual(am.accounts[0].tokenWindow, [], 'record is a no-op without config');
  assert.equal(am._isAvailable(am.accounts[0], 'm'), true);
  assert.equal(am.getServeable('m').accounts[0].serveableNow, true);
  assert.equal(am.getServeable('m').accounts[0].quotaResetAt, null);
  // exportQuotaState must never carry the ephemeral window.
  const exported = am.exportQuotaState();
  assert.equal(exported[0].tokenWindow, undefined);
  assert.equal(exported[0].tokenBudget, undefined);
});

test('R2: sum-trip → typed 429 + serveableNow:false + quotaResetAt ≈ roll-off', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(okBody({ input_tokens: 800, output_tokens: 200 })); // 1000 each
    });
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;
  const windowSec = 3600;
  const am = new AccountManager([
    apikey('budgeted', 'kb', url, {
      tokenBudget: { windowSec, maxTokens: 1500 },
    }),
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    // First response records 1000 — under budget.
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(r1.status, 200, await r1.text());
    assert.equal(am.accounts[0].tokenWindow.length, 1);
    assert.equal(am._tokenWindowSum(am.accounts[0]), 1000);

    // Second response records another 1000 → sum 2000 ≥ 1500; next admit trips.
    const r2 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(r2.status, 200, await r2.text());
    assert.equal(am._tokenWindowSum(am.accounts[0]), 2000);
    assert.equal(am._isTokenBudgetTripped(am.accounts[0]), true);

    const beforeAdmit = Date.now();
    const r3 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    const text = await r3.text();
    assert.equal(r3.status, 429, text);
    assert.equal(upstreamHits, 2, 'tripped fleet must not egress');
    const retryAfter = Number(r3.headers.get('retry-after'));
    const oldest = am.accounts[0].tokenWindow[0].ts;
    const expected = Math.min(3600, Math.max(1, Math.ceil((oldest + windowSec * 1000 - Date.now()) / 1000)));
    assert.ok(Math.abs(retryAfter - expected) <= 5, `retry-after ${retryAfter} ≈ ${expected}`);
    assert.match(JSON.parse(text).error.message, /token-budget/);

    const snap = am.getServeable('m');
    assert.equal(snap.accounts[0].serveableNow, false);
    assert.equal(snap.accounts[0].reason, 'token-budget');
    const resetMs = Date.parse(snap.accounts[0].quotaResetAt);
    assert.ok(Number.isFinite(resetMs));
    assert.ok(Math.abs(resetMs - (oldest + windowSec * 1000)) <= 50,
      'quotaResetAt must track oldest-entry roll-off');
    assert.ok(resetMs > beforeAdmit);

    const status = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
    assert.equal(status.accounts[0].serveableNow, false);
    assert.ok(status.accounts[0].quotaResetAt);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('R2: window roll-off restores eligibility', () => {
  const am = new AccountManager([
    apikey('b', 'k', 'http://127.0.0.1:9', {
      tokenBudget: { windowSec: 60, maxTokens: 100 },
    }),
  ]);
  const a = am.accounts[0];
  a.tokenWindow.push({ ts: Date.now() - 61_000, tokens: 200 });
  assert.equal(am._isTokenBudgetTripped(a), false, 'stale entry must prune away');
  assert.equal(am._isAvailable(a, 'm'), true);
  a.tokenWindow.push({ ts: Date.now(), tokens: 200 });
  assert.equal(am._isTokenBudgetTripped(a), true);
  // Age the only live entry past the window.
  a.tokenWindow[0].ts = Date.now() - 61_000;
  assert.equal(am._isTokenBudgetTripped(a), false);
  assert.equal(am.getServeable('m').accounts[0].serveableNow, true);
  assert.equal(am.getServeable('m').accounts[0].quotaResetAt, null);
});

test('R2: usage recorded on streamed response completion', async () => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { model: 'm', usage: { input_tokens: 40, output_tokens: 0 } },
      })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 10 },
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();
    });
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;
  const am = new AccountManager([
    apikey('streamed', 'ks', url, {
      tokenBudget: { windowSec: 3600, maxTokens: 1_000_000 },
    }),
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [], stream: true }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(am.accounts[0].tokenWindow.length, 1);
    assert.equal(am.accounts[0].tokenWindow[0].tokens, 50, 'input+output from parsed SSE usage');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('R2×R1: budget-tripped account is skipped in rotation, not wait-retried', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const key = req.headers['x-api-key'];
      seen.push(key);
      if (key === 'key-a') {
        // Would be wait-retried under transient-429; must never be hit when budget-tripped.
        res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(okBody({ input_tokens: 1, output_tokens: 1 }));
    });
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;
  const am = new AccountManager([
    apikey('a', 'key-a', url, {
      priority: 0,
      tokenBudget: { windowSec: 3600, maxTokens: 100 },
    }),
    apikey('b', 'key-b', url, { priority: 1 }),
  ]);
  // Trip a's budget before the request — selection must skip a entirely.
  am.accounts[0].tokenWindow.push({ ts: Date.now(), tokens: 100 });
  assert.equal(am._isTokenBudgetTripped(am.accounts[0]), true);

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(seen, ['key-b'], 'budget-tripped a skipped; b served (no wait-retry on a)');
    assert.equal(am.accounts[0].status, 'active', 'budget trip must not markRateLimited');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
