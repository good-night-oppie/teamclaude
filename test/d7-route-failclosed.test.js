// D7: fail-closed route fallback — guard the FALLBACK, not each entrance.
// B47/B55: null model and empty-after-load table both used to reach
// _accountOwnsModel's unconditional true when no account declares models[].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PROVENANCE_OUTCOMES } from '../src/provenance.js';

function oauth(name, extra = {}) {
  return {
    name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r',
    expiresAt: Date.now() + 3600_000, ...extra,
  };
}
function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k-' + name, ...extra };
}
async function fetchOk(url, init = {}, ms = 5000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => {
    // undici keep-alive otherwise leaves sockets open and server.close() hangs the suite.
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

const ROUTES = [
  { name: 'haiku', match: ['*haiku*'], accounts: ['allowed'] },
  { name: 'other', match: ['*opus*', '*sonnet*'], accounts: ['allowed', 'excluded'] },
];

function routedManager(acctFn = oauth) {
  return new AccountManager(
    [acctFn('allowed'), acctFn('excluded')],
    0.98,
    { routes: ROUTES },
  );
}

// ── unit: guard the fallback ───────────────────────────────────────────────

test('D7: routes configured + null model → _routeAllows fails closed', () => {
  const am = routedManager();
  assert.equal(am._routesConfigured, true);
  assert.equal(am._routeAllows(am.accounts[0], null), false);
  assert.equal(am._routeAllows(am.accounts[1], null), false);
});

test('D7: NO routes declared → _accountOwnsModel legacy preserved byte-identical', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  assert.equal(am._routesConfigured, false);
  assert.equal(am.routes.length, 0);
  // Ownership inert (no models[] claims) → true for every account, including null model.
  assert.equal(am._routeAllows(am.accounts[0], null), true);
  assert.equal(am._routeAllows(am.accounts[1], 'claude-haiku-4-5'), true);
  assert.equal(am._accountOwnsModel(am.accounts[0], 'claude-haiku-4-5'), true);
  assert.equal(am._routeAllows(am.accounts[0], 'claude-haiku-4-5'), am._accountOwnsModel(am.accounts[0], 'claude-haiku-4-5'));
});

test('D7: routes configured then emptied (index.js || [] outcome) → fail closed', () => {
  const am = routedManager();
  assert.equal(am._routesConfigured, true);
  // Simulate config.routes = diskConfig.routes || [] when disk lacks routes.
  am.setRoutes([]);
  assert.equal(am.routes.length, 0);
  assert.equal(am._routesConfigured, true, 'sticky: once routes were declared, stay fail-closed');
  assert.equal(am._routeAllows(am.accounts[0], 'claude-haiku-4-5'), false);
  assert.equal(am._routeAllows(am.accounts[1], 'claude-haiku-4-5'), false);
  assert.equal(am._isAvailable(am.accounts[0], 'claude-haiku-4-5'), false);
});

test('D7: B47 — route-excluded account unreachable for unparseable (null) model', () => {
  const am = routedManager();
  // Pre-fix: _routeAllows(excluded, null) was true → selection could land there.
  assert.equal(am._routeAllows(am.accounts[1], null), false);
  assert.equal(am._routeAllows(am.accounts[1], 'claude-haiku-4-5'), false);
});

test('D7: unmatched model with live routes still uses ownership (not a dangerous entrance)', () => {
  const am = new AccountManager(
    [oauth('claude'), oauth('ds', { models: ['deepseek-v4-pro'] })],
    0.98,
    { routes: [{ name: 'haiku', match: ['*haiku*'], accounts: ['claude'] }] },
  );
  // deepseek id matches no route → ownership still decides (legacy routed behavior).
  assert.equal(am._routeAllows(am.accounts[0], 'deepseek-v4-pro'), false);
  assert.equal(am._routeAllows(am.accounts[1], 'deepseek-v4-pro'), true);
});

// ── HTTP: path-aware null-model ────────────────────────────────────────────

test('D7: routes + null model + inference path → REFUSED with distinct client error', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', content: [] }));
  });
  const upPort = await listen(upstream);
  const am = routedManager(apikey);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    // Body with no model field → parseRequestModel yields null.
    const res = await fetchOk(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.type, 'error');
    assert.match(body.error?.message || '', /model/i);
    assert.match(body.error?.message || '', /route/i);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('D7: routes + null model + non-inference path → today\'s behavior (no regression)', async () => {
  let hitUpstream = false;
  const upstream = http.createServer((_req, res) => {
    hitUpstream = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upPort = await listen(upstream);
  const am = routedManager(apikey);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetchOk(`http://127.0.0.1:${port}/api/eval/sdk-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }), // no model
    });
    assert.equal(res.status, 200, 'non-inference null-model must not be fail-closed');
    assert.equal(hitUpstream, true);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('D7: emptied route table → fail closed on inference paths', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', content: [] }));
  });
  const upPort = await listen(upstream);
  const am = routedManager(apikey);
  am.setRoutes([]); // post-load wipe
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetchOk(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.notEqual(res.status, 200, 'must not forward when routing authority was wiped');
    assert.ok(res.status === 400 || res.status === 429);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// ── reload provenance ──────────────────────────────────────────────────────

test('D7: POST /teamclaude/reload emits exactly one config-reload provenance event', async () => {
  assert.ok(PROVENANCE_OUTCOMES.includes('config-reload'));
  const am = new AccountManager([apikey('a')], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {
    reload: async () => 1,
  });
  const port = await listen(proxy);
  try {
    const before = await (await fetchOk(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    assert.equal(before.events.length, 0);

    const res = await fetchOk(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    assert.equal(res.status, 200);

    const prov = await (await fetchOk(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    const reloads = prov.events.filter(e => e.outcome === 'config-reload');
    assert.equal(reloads.length, 1, `expected exactly one config-reload, got ${prov.events.map(e => e.outcome)}`);
    assert.equal(reloads[0].pinned, false);
    assert.equal(typeof reloads[0].ts, 'string');
    assert.equal(reloads[0].final, true);
    assert.equal(reloads[0].response_status, 200);
  } finally {
    await close(proxy);
  }
});

test('D7: failed reload also emits one config-reload (fail) event', async () => {
  const am = new AccountManager([apikey('a')], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {
    reload: async () => { throw new Error('disk boom'); },
  });
  const port = await listen(proxy);
  try {
    const res = await fetchOk(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
    assert.equal(res.status, 500);
    const prov = await (await fetchOk(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    const reloads = prov.events.filter(e => e.outcome === 'config-reload');
    assert.equal(reloads.length, 1);
    assert.equal(reloads[0].response_status, 500);
    assert.equal(reloads[0].pinned, false);
  } finally {
    await close(proxy);
  }
});
