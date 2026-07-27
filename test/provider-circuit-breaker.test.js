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

async function request(port, model = 'claude-sonnet-5') {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: res.status, body: await res.text() };
}

// A custom adapter is an independent failure domain. A 503 from it should not
// escape while another eligible account can serve the request; the adapter's
// circuit opens and selection skips it on the next request.
test('custom adapter 503 opens circuit and fails over before client headers', async () => {
  let badHits = 0;
  let goodHits = 0;
  const bad = http.createServer((_req, res) => {
    badHits++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'adapter unavailable' }));
  });
  const good = http.createServer((_req, res) => {
    goodHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'ok', type: 'message', model: 'served-good' }));
  });
  const badPort = await listen(bad);
  const goodPort = await listen(good);

  const am = new AccountManager([
    { name: 'bad', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${badPort}`, priority: 0 },
    { name: 'good', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${goodPort}`, priority: 1 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  try {
    const first = await request(proxyPort);
    assert.equal(first.status, 200);
    assert.match(first.body, /served-good/);
    assert.equal(badHits, 1);
    assert.equal(goodHits, 1);
    assert.equal(am.accounts[0].consecutiveFailures, 1);
    assert.ok(am.accounts[0].circuitOpenUntil > Date.now());

    const second = await request(proxyPort);
    assert.equal(second.status, 200);
    assert.equal(badHits, 1, 'open circuit excludes bad adapter before selection');
    assert.equal(goodHits, 2);
  } finally {
    await close(proxy); await close(bad); await close(good);
  }
});

// ECONNREFUSED to a custom adapter is also account-specific. This is the minimum
// HA promise: one dead microservice does not take down the data plane or client.
test('custom adapter connection refusal fails over to a healthy provider', async () => {
  const unused = http.createServer();
  const deadPort = await listen(unused);
  await close(unused); // port is now guaranteed unused

  let goodHits = 0;
  const good = http.createServer((_req, res) => {
    goodHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'ok', type: 'message', model: 'served-good' }));
  });
  const goodPort = await listen(good);
  const am = new AccountManager([
    { name: 'dead', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${deadPort}`, priority: 0 },
    { name: 'good', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${goodPort}`, priority: 1 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  try {
    const out = await request(proxyPort);
    assert.equal(out.status, 200);
    assert.equal(goodHits, 1);
    assert.equal(am.accounts[0].consecutiveFailures, 1);
    assert.ok(am.accounts[0].circuitOpenUntil > Date.now());
  } finally {
    await close(proxy); await close(good);
  }
});

// An arbitrary provider 400 remains non-retryable. A circuit breaker must not
// hide a real request/model defect by spraying it across every provider.
test('custom adapter 400 is relayed and heals transport health; it never fails over', async () => {
  let badHits = 0;
  let goodHits = 0;
  const bad = http.createServer((_req, res) => {
    badHits++;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad model' }));
  });
  const good = http.createServer((_req, res) => {
    goodHits++;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  const badPort = await listen(bad);
  const goodPort = await listen(good);
  const am = new AccountManager([
    { name: 'bad', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${badPort}`, priority: 0 },
    { name: 'good', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${goodPort}`, priority: 1 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  try {
    const out = await request(proxyPort);
    assert.equal(out.status, 400);
    assert.equal(badHits, 1);
    assert.equal(goodHits, 0);
    assert.equal(am.accounts[0].consecutiveFailures, 0, 'reachable 400 is not provider-health failure');
    assert.ok(am.accounts[0].lastSuccessAt, 'transport path is healthy even though request is bad');
  } finally {
    await close(proxy); await close(bad); await close(good);
  }
});
