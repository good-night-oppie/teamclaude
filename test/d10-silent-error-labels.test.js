// D10: visibility labels for two silent error classes (outcome-only; no behavior change).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  ProvenanceBuffer,
  PROVENANCE_OUTCOMES,
  UPSTREAM_THINKING_REQUIRED_MARKER,
  classifyUpstreamRelayOutcome,
} from '../src/provenance.js';
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

function oauth(name) {
  return {
    name, type: 'oauth', priority: 0,
    accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
  };
}

async function withProxy(upstreamHandler, fn, { path = '/v1/messages' } = {}) {
  const upstream = http.createServer(upstreamHandler);
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('a')]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    return await fn({ port, path });
  } finally {
    await close(proxy);
    await close(upstream);
  }
}

async function postAndFinalEvent(port, path, bodyObj) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj ?? { model: 'claude-sonnet-4', messages: [] }),
  });
  const status = res.status;
  await res.arrayBuffer(); // drain
  const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
  const e = prov.events.find(ev => ev.final);
  return { status, event: e, events: prov.events };
}

test('PROVENANCE_OUTCOMES includes both D10 labels', () => {
  assert.ok(PROVENANCE_OUTCOMES.includes('upstream-thinking-required'));
  assert.ok(PROVENANCE_OUTCOMES.includes('count-tokens-unsupported'));
});

test('classifyUpstreamRelayOutcome: 400 with marker → upstream-thinking-required', () => {
  assert.equal(
    classifyUpstreamRelayOutcome({
      status: 400,
      path: '/v1/messages',
      body: JSON.stringify({ error: { message: UPSTREAM_THINKING_REQUIRED_MARKER } }),
    }),
    'upstream-thinking-required',
  );
});

test('classifyUpstreamRelayOutcome: 400 without marker → upstream-error-relayed', () => {
  assert.equal(
    classifyUpstreamRelayOutcome({
      status: 400,
      path: '/v1/messages',
      body: JSON.stringify({ error: { message: 'invalid_request' } }),
    }),
    'upstream-error-relayed',
  );
});

test('classifyUpstreamRelayOutcome: 404 on count_tokens → count-tokens-unsupported', () => {
  assert.equal(
    classifyUpstreamRelayOutcome({
      status: 404,
      path: '/v1/messages/count_tokens',
      pathClass: 'count_tokens',
      body: null,
    }),
    'count-tokens-unsupported',
  );
});

test('classifyUpstreamRelayOutcome: 404 on other path → upstream-error-relayed', () => {
  assert.equal(
    classifyUpstreamRelayOutcome({
      status: 404,
      path: '/v1/messages',
      pathClass: 'messages',
      body: null,
    }),
    'upstream-error-relayed',
  );
});

test('relayed 400 with deepseek thinking marker → upstream-thinking-required', async () => {
  const { status, event } = await withProxy((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `bad: ${UPSTREAM_THINKING_REQUIRED_MARKER}`,
      },
    }));
  }, ({ port }) => postAndFinalEvent(port, '/v1/messages'));
  assert.equal(status, 400);
  assert.ok(event);
  assert.equal(event.outcome, 'upstream-thinking-required');
  assert.equal(event.response_status, 400);
});

test('relayed 400 without marker stays upstream-error-relayed', async () => {
  const { status, event } = await withProxy((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'missing field foo' },
    }));
  }, ({ port }) => postAndFinalEvent(port, '/v1/messages'));
  assert.equal(status, 400);
  assert.ok(event);
  assert.equal(event.outcome, 'upstream-error-relayed');
});

test('relayed 404 on count_tokens → count-tokens-unsupported', async () => {
  const { status, event } = await withProxy((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'nope' } }));
  }, ({ port }) => postAndFinalEvent(port, '/v1/messages/count_tokens', {
    model: 'claude-sonnet-4',
    messages: [{ role: 'user', content: 'hi' }],
  }));
  assert.equal(status, 404);
  assert.ok(event);
  assert.equal(event.outcome, 'count-tokens-unsupported');
  assert.equal(event.path, '/v1/messages/count_tokens');
  assert.equal(event.response_status, 404);
});

test('relayed 404 on /v1/messages stays upstream-error-relayed', async () => {
  const { status, event } = await withProxy((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'nope' } }));
  }, ({ port }) => postAndFinalEvent(port, '/v1/messages'));
  assert.equal(status, 404);
  assert.ok(event);
  assert.equal(event.outcome, 'upstream-error-relayed');
});

test('D10 labels survive ring snapshot + GET /teamclaude/provenance', async () => {
  // Unit: push both labels into a buffer and confirm snapshot round-trip.
  const buf = new ProvenanceBuffer({ size: 16 });
  buf.push({
    request_id: 'r1', final: true, outcome: 'upstream-thinking-required',
    response_status: 400, path: '/v1/messages', method: 'POST',
  });
  buf.push({
    request_id: 'r2', final: true, outcome: 'count-tokens-unsupported',
    response_status: 404, path: '/v1/messages/count_tokens', method: 'POST',
  });
  const snap = buf.snapshot();
  const a = snap.events.find(e => e.request_id === 'r1');
  const b = snap.events.find(e => e.request_id === 'r2');
  assert.equal(a.outcome, 'upstream-thinking-required');
  assert.equal(b.outcome, 'count-tokens-unsupported');

  // Integration: live GET after a count_tokens 404.
  const { event } = await withProxy((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"type":"error"}');
  }, async ({ port }) => {
    await postAndFinalEvent(port, '/v1/messages/count_tokens', {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'x' }],
    });
    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    return { status: 404, event: prov.events.find(ev => ev.final), events: prov.events };
  });
  assert.ok(event);
  assert.equal(event.outcome, 'count-tokens-unsupported');
});
