import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

// Drive one request through the proxy against an upstream that always 429s with
// the given Retry-After header, and report how the request terminated.
async function runAgainstThrottlingUpstream(retryAfterHeader) {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { 'retry-after': retryAfterHeader, 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    return {
      status: res.status, upstreamHits,
      accountStatus: am.accounts[0].status,
      paused: am.accounts[0].pausedUntil != null && am.accounts[0].pausedUntil > Date.now(),
    };
  } finally {
    proxy.close();
    upstream.close();
  }
}

// Regression: a persistently rate-limited upstream must terminate (bounded
// retries), not loop forever tying up the client connection. A rate-limit 429
// does NOT rotate/throttle the account (#84) — it pauses it (so concurrent
// requests wait) and retries the same account, then surfaces a 429.
test('persistent upstream 429 terminates with a bounded number of retries', async () => {
  const { status, upstreamHits, accountStatus, paused } = await runAgainstThrottlingUpstream('1');
  assert.equal(status, 429);                                   // returns 429 instead of hanging
  assert.ok(upstreamHits >= 1 && upstreamHits <= 4, `expected bounded retries, got ${upstreamHits}`);
  assert.equal(accountStatus, 'active');                       // NOT throttled — no rotation on a rate-limit 429
  assert.ok(paused, 'account should be paused, so concurrent requests wait');
});

// A negative (or otherwise out-of-range) Retry-After must not bypass the cap:
// it would make setTimeout return immediately (and previously mark the account
// rate-limited in the past, reactivating it instantly).
test('negative Retry-After is clamped and still terminates', async () => {
  const { status, upstreamHits, accountStatus, paused } = await runAgainstThrottlingUpstream('-1');
  assert.equal(status, 429);
  assert.ok(upstreamHits >= 1 && upstreamHits <= 4, `expected bounded retries, got ${upstreamHits}`);
  assert.equal(accountStatus, 'active');
  assert.ok(paused);
});

test('long upstream Retry-After is surfaced without sleeping in client request', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      assert.fail(`request should return 429 promptly, got ${err.name}`);
    }

    await res.text();
    assert.equal(res.status, 429);
    assert.equal(upstreamHits, 1, 'long Retry-After should not be retried inline');
    assert.ok(Date.now() - started < 2000, 'request should not sleep for upstream retry window');
    assert.equal(am.accounts[0].status, 'active', 'rate-limit 429 must not throttle/rotate the account');
    assert.ok(am.accounts[0].pausedUntil > Date.now(), 'account should be paused so concurrent requests wait');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Legacy (#84): transient429RotateAfter:0 never rotates on a rate-limit 429 —
// every retry stays on the same account (pause + same-account wait).
test('a rate-limit 429 never rotates when transient429RotateAfter is 0', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    transient429RotateAfter: 0,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);
    const accounts = new Set(seen);
    assert.equal(accounts.size, 1, `all hits should be on one account, saw ${[...accounts]}`);
    assert.equal(am.accounts[0].status, 'active', 'current account not throttled');
    assert.equal(am.accounts[1].status, 'active');
    assert.equal(am.accounts[1].pausedUntil, null, 'the other account is untouched — no rotation');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A quota-rejection 429 (unified status "rejected") is durable exhaustion, so it
// DOES rotate — account a is throttled and the request succeeds on account b.
test('a quota-rejection 429 rotates to the next account', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t-a') {
      res.writeHead(429, {
        'retry-after': '60',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    }
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200, 'should succeed on the second account');
    assert.equal(am.accounts[0].status, 'throttled', 'exhausted account is throttled (rotated away)');
    assert.ok(seen.includes('Bearer t-b'), 'request rotated to account b');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Pre-T4: a 1s rate-limit hold was absorbed inline (wait + retry) so the client
// never saw a synthetic 429. T4 surfaces known unserveability as a typed 429
// with retry-after — never forward, never sleep the connection on a hold the
// dispatch machine can grade itself.
test('rate-limited fleet surfaces typed 429 with retry-after (no inline absorb)', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  am.markRateLimited(0, 1);

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    const text = await res.text();
    assert.equal(res.status, 429, text);
    assert.equal(upstreamHits, 0, 'must not forward a known-held account');
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 5, `retry-after ~1s, got ${retryAfter}`);
    const body = JSON.parse(text);
    assert.equal(body.type, 'error');
    assert.equal(body.error?.type, 'rate_limit_error');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Pre-T4 (#46): a stale/poisoned cached quota was re-probed on the request path
// so a plan-upgrade snapshot could not pin the proxy in synthetic 429s forever.
// T4 retires that probe for known near-quota state — forwarding is where
// 200-with-refusal enters. Recovery is out-of-band (background Prober,
// GET /teamclaude/serveable, operator reload), not a request-path gamble.
test('stale over-threshold quota is typed-429 locally, not re-probed on the request path', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-7d-utilization': '0.10',
    });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  am.restoreQuotaState([
    { name: 'a', quota: { unified7d: 0.98, unified7dReset: Date.now() + 7 * 24 * 3600_000 } },
  ]);

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    const text = await res.text();
    assert.equal(res.status, 429, text);
    assert.equal(upstreamHits, 0, 'known near-quota must not probe upstream');
    assert.equal(am.accounts[0].quota.unified7d, 0.98, 'cached quota unchanged without a probe');
    const body = JSON.parse(text);
    assert.equal(body.type, 'error');
    assert.equal(body.error?.type, 'rate_limit_error');
    assert.match(body.error.message, /quota-exhausted/);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// ── R1: transient-429 cap-then-rotate ─────────────────────────

function apikey(name, key, upstream, extra = {}) {
  return { name, type: 'apikey', apiKey: key, upstream, priority: extra.priority ?? 0, ...extra };
}

test('R1: 3×transient-429 then rotates to next candidate (default cap)', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const key = req.headers['x-api-key'];
    seen.push(key);
    if (key === 'key-a') {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'm',
      content: [], usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;
  // 4 accounts so maxRetries > rotateAfter; a wins by priority.
  const am = new AccountManager([
    apikey('a', 'key-a', url, { priority: 0 }),
    apikey('b', 'key-b', url, { priority: 1 }),
    apikey('c', 'key-c', url, { priority: 2 }),
    apikey('d', 'key-d', url, { priority: 3 }),
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(res.status, 200, await res.text());
    const aHits = seen.filter(k => k === 'key-a').length;
    assert.equal(aHits, 3, `expected 3 transient-429s on a before rotate, got ${aHits}; seen=${seen}`);
    assert.ok(seen.includes('key-b'), 'request rotated to b');
    assert.equal(am.accounts[0].status, 'throttled', 'capped account cooldown via markRateLimited');
    assert.ok(am.accounts[0].rateLimitedUntil > Date.now());
    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance?limit=512`)).json();
    const waits = prov.events.filter(e => e.outcome === 'rate-429-inline-wait' && e.account === 'a');
    const caps = prov.events.filter(e => e.outcome === 'transient-429-cap' && e.account === 'a');
    assert.equal(waits.length, 3, 'non-final attempt event on each transient-429');
    assert.equal(caps.length, 1, 'rotation event with transient-429-cap');
    assert.equal(caps[0].final, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('R1: single-candidate route keeps wait-retry (nothing to rotate to)', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;
  const am = new AccountManager([apikey('only', 'k1', url)]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(res.status, 429);
    // One account → maxRetries=1 → one wait (retryCount 0) then surface. No throttle.
    assert.ok(hits >= 1 && hits <= 2, `bounded wait-retry, got ${hits}`);
    assert.equal(am.accounts[0].status, 'active', 'single candidate must not markRateLimited for rotate');
    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance?limit=512`)).json();
    assert.equal(prov.events.filter(e => e.outcome === 'transient-429-cap').length, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('R1: typed/quota-429 path unchanged (still rotates on first rejected)', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers['x-api-key']);
    if (req.headers['x-api-key'] === 'key-a') {
      res.writeHead(429, {
        'retry-after': '60',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;
  const am = new AccountManager([
    apikey('a', 'key-a', url, { priority: 0 }),
    apikey('b', 'key-b', url, { priority: 1 }),
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen.filter(k => k === 'key-a'), ['key-a'], 'quota-429 rotates on first rejection');
    assert.ok(seen.includes('key-b'));
    assert.equal(am.accounts[0].status, 'throttled');
    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance?limit=512`)).json();
    assert.ok(prov.events.some(e => e.outcome === 'quota-429-rotate'));
    assert.equal(prov.events.filter(e => e.outcome === 'transient-429-cap').length, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('R1: cooldown expiry restores eligibility', async () => {
  const am = new AccountManager([
    apikey('a', 'ka', 'http://127.0.0.1:9', { priority: 0 }),
    apikey('b', 'kb', 'http://127.0.0.1:9', { priority: 1 }),
  ]);
  am.markRateLimited(0, 60);
  assert.equal(am.getServeable('m').accounts[0].serveableNow, false);
  // Expire the hold.
  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  am.clearRateLimited(0);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.getServeable('m').accounts[0].serveableNow, true);
  // Natural expiry via refreshExpiredQuotas / _isAvailable time check:
  am.markRateLimited(0, 60);
  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  assert.equal(am._isAvailable(am.accounts[0], 'm'), true,
    'past rateLimitedUntil must not keep the account unserveable');
});

test('R1: model-map miss on rotate surfaces typed error, not a hang', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const key = req.headers['x-api-key'];
    seen.push(key);
    if (key === 'sakana') {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    // codex selected after rotate but has no fugu-ultra map entry → upstream 404.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model_not_found' } }));
  });
  const upPort = await listen(upstream);
  const url = `http://127.0.0.1:${upPort}`;
  // sakana maps fugu-ultra; codex is selection-eligible (no acceptsModels gate) but
  // its modelMap lacks fugu-ultra, so the id egresses verbatim and 404s — client's
  // problem to surface, not a proxy hang (R1 constraint).
  const am = new AccountManager([
    apikey('sakana-fugu', 'sakana', url, {
      priority: 0,
      modelMap: { 'claude-fugu-ultra': 'fugu-ultra' },
    }),
    apikey('codex-gpt56', 'codex', url, {
      priority: 1,
      modelMap: { 'claude-gpt-5.6-terra': 'gpt-5.6-terra' },
    }),
    apikey('pad-c', 'c', url, { priority: 2 }),
    apikey('pad-d', 'd', url, { priority: 3 }),
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: url });
  const port = await listen(proxy);
  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fugu-ultra', messages: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    assert.equal(res.status, 404, text);
    assert.ok(Date.now() - started < 14_000, 'must not hang after model-map miss on rotate');
    assert.equal(seen.filter(k => k === 'sakana').length, 3);
    assert.ok(seen.includes('codex'), 'rotated onto codex-gpt56');
    assert.equal(am.accounts[0].status, 'throttled');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
