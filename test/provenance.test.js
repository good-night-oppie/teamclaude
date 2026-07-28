import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import {
  ProvenanceBuffer,
  PROVENANCE_SAFE_FIELDS,
  buildProvenanceEvent,
  sanitizeProvenancePath,
} from '../src/provenance.js';
import { AccountManager } from '../src/account-manager.js';
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

test('sanitizeProvenancePath strips query, absolute-form host, and caps at 128', () => {
  assert.equal(sanitizeProvenancePath('/v1/messages?beta=true'), '/v1/messages');
  assert.equal(
    sanitizeProvenancePath('https://api.anthropic.com/v1/messages?x=1'),
    '/v1/messages',
  );
  assert.equal(
    sanitizeProvenancePath('http://evil.test:443/v1/messages#frag'),
    '/v1/messages',
  );
  const long = `/${'a'.repeat(200)}`;
  assert.equal(sanitizeProvenancePath(long).length, 128);
});

test('buildProvenanceEvent allowlist drops body/header/secret keys', () => {
  const evt = buildProvenanceEvent({
    request_id: 'x-b-1',
    attempt: 1,
    final: true,
    path: '/v1/messages?secret=1',
    outcome: 'ok',
    body: 'PROMPT LEAK',
    headers: { authorization: 'Bearer SECRET' },
    err_message: 'fetch failed https://leak',
    prompt: 'do not include',
    accountUuid: 'uuid-leak',
    credential: 'cred-leak',
  }, { seq: 1, ts: '2026-01-01T00:00:00.000Z' });

  assert.deepEqual(Object.keys(evt).sort(), [...PROVENANCE_SAFE_FIELDS].sort());
  assert.equal(evt.path, '/v1/messages');
  assert.equal(evt.body, undefined);
  assert.equal(evt.headers, undefined);
  assert.equal(evt.err_message, undefined);
  assert.equal(evt.prompt, undefined);
  assert.equal(evt.accountUuid, undefined);
  assert.equal(evt.credential, undefined);
  const blob = JSON.stringify(evt);
  assert.equal(blob.includes('PROMPT'), false);
  assert.equal(blob.includes('SECRET'), false);
  assert.equal(blob.includes('Bearer'), false);
  assert.equal(blob.includes('uuid-leak'), false);
});

test('ProvenanceBuffer ring wrap + monotonic seq + gap detection', () => {
  const buf = new ProvenanceBuffer({ size: 4, now: () => 1_000_000 });
  for (let i = 0; i < 6; i++) {
    buf.push({ request_id: `r-${i}`, attempt: 1, final: true, outcome: 'ok' });
  }
  const snap = buf.snapshot(0, 256);
  assert.equal(snap.head_seq, 3); // seqs 3..6 retained
  assert.equal(snap.tail_seq, 6);
  assert.deepEqual(snap.events.map(e => e.seq), [3, 4, 5, 6]);
  // Consumer at cursor 1 sees first retained seq 3 → lost = 3 - 1 - 1 = 1? 
  // Actually lost from cursor c when first.seq > c+1: first=3, c=1 → lost 1 event (seq 2).
  // Seq 1 also gone: lost = first.seq - c - 1 = 1. Wait c=0: first=3 → lost 2.
  assert.ok(snap.events[0].seq > 0 + 1);
  const lost = snap.events[0].seq - 0 - 1;
  assert.equal(lost, 2);
});

test('snapshot is pure — does not mutate ring (B3 doctrine, in-repo 503038d/d26c461)', () => {
  const buf = new ProvenanceBuffer({ size: 8 });
  buf.push({ request_id: 'a', attempt: 1, final: true, outcome: 'ok', path: '/v1/messages' });
  const before = buf.snapshot(0, 10);
  const again = buf.snapshot(0, 10);
  assert.deepEqual(again, before);
  // Mutating the returned copy must not affect the next snapshot.
  again.events[0].path = '/HACKED';
  again.events[0].usage.input = 999;
  const third = buf.snapshot(0, 10);
  assert.equal(third.events[0].path, '/v1/messages');
  assert.equal(third.events[0].usage.input, null);
  assert.equal(buf._count, 1);
  assert.equal(buf._nextSeq, 2);
});

test('nextRequestId uses bootEpoch + tag counters for b and m', () => {
  const buf = new ProvenanceBuffer({ now: () => 0xabc });
  assert.equal(buf.bootEpoch, (0xabc).toString(36));
  assert.equal(buf.nextRequestId('b'), `${buf.bootEpoch}-b-1`);
  assert.equal(buf.nextRequestId('b'), `${buf.bootEpoch}-b-2`);
  assert.equal(buf.nextRequestId('m'), `${buf.bootEpoch}-m-1`);
  assert.throws(() => buf.nextRequestId('x'), /tag/);
});

test('optional JSONL sink appends and queues across rotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-prov-'));
  const file = join(dir, 'prov.jsonl');
  try {
    const buf = new ProvenanceBuffer({ size: 32, filePath: file, maxFileBytes: 120 });
    for (let i = 0; i < 8; i++) {
      buf.push({
        request_id: `${buf.bootEpoch}-b-${i + 1}`,
        attempt: 1,
        final: true,
        outcome: 'ok',
        path: '/v1/messages',
      });
    }
    // Allow stream flush.
    await new Promise(r => setTimeout(r, 30));
    const primary = await readFile(file, 'utf8').catch(() => '');
    const rotated = await readFile(`${file}.1`, 'utf8').catch(() => '');
    const lines = `${rotated}${primary}`.split('\n').filter(Boolean);
    assert.ok(lines.length >= 8, `expected >=8 jsonl lines, got ${lines.length}`);
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.ok(obj.request_id.startsWith(buf.bootEpoch));
      assert.deepEqual(Object.keys(obj).sort(), [...PROVENANCE_SAFE_FIELDS].sort());
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GET /teamclaude/provenance returns boot_epoch and is pure-read', async () => {
  const am = new AccountManager([oauth('a')]);
  const a = am.accounts[0];
  a.circuitOpenUntil = Date.now() + 60_000;
  a.consecutiveFailures = 3;
  a.circuitProbeInFlightAt = Date.now();
  const before = {
    circuitOpenUntil: a.circuitOpenUntil,
    circuitProbeInFlightAt: a.circuitProbeInFlightAt,
    consecutiveFailures: a.consecutiveFailures,
  };

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/provenance?since=0&limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.boot_epoch, 'string');
    assert.ok(body.boot_epoch.length > 0);
    assert.equal(typeof body.head_seq, 'number');
    assert.equal(typeof body.tail_seq, 'number');
    assert.equal(typeof body.buffer_size, 'number');
    assert.ok(Array.isArray(body.events));
    assert.ok(body.now);

    const status = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    const st = await status.json();
    assert.ok(st.build?.features?.includes('provenance-t7'));

    assert.deepEqual({
      circuitOpenUntil: a.circuitOpenUntil,
      circuitProbeInFlightAt: a.circuitProbeInFlightAt,
      consecutiveFailures: a.consecutiveFailures,
    }, before);
  } finally {
    await close(proxy);
  }
});

test('pre-forward gate rejection emits attempt=0 final terminal event', async () => {
  const am = new AccountManager([oauth('a')]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: 'http://127.0.0.1:9',
    blockedModels: ['blocked-*'],
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'blocked-x', messages: [] }),
    });
    assert.equal(res.status, 400);
    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    assert.equal(prov.events.length, 1);
    const e = prov.events[0];
    assert.equal(e.attempt, 0);
    assert.equal(e.final, true);
    assert.equal(e.outcome, 'rejected-blocked');
    assert.equal(e.requested_model, 'blocked-x');
    assert.match(e.request_id, new RegExp(`^${prov.boot_epoch}-b-\\d+$`));
    assert.equal(e.path, '/v1/messages');
  } finally {
    await close(proxy);
  }
});

test('failover chain emits non-final then final with monotonic attempts', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'served-model',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 3, output_tokens: 5 },
    }));
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'custom-a', type: 'apikey', apiKey: 'k', upstream: `http://127.0.0.1:${upPort}`, modelMap: { 'req-model': 'mapped-model' } },
    { name: 'custom-b', type: 'apikey', apiKey: 'k', upstream: `http://127.0.0.1:${upPort}`, modelMap: { 'req-model': 'mapped-model' } },
  ]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'req-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, 'served-model');

    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    const events = prov.events.filter(e => e.path === '/v1/messages');
    assert.ok(events.length >= 2, `expected failover chain, got ${events.length}`);
    assert.equal(events[0].final, false);
    assert.equal(events[0].outcome, 'failover-upstream-5xx');
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].mapped_model, 'mapped-model');
    const last = events[events.length - 1];
    assert.equal(last.final, true);
    assert.equal(last.outcome, 'ok');
    assert.equal(last.attempt, 2);
    assert.equal(last.response_reported_model, 'served-model');
    assert.equal(last.usage.input, 3);
    assert.equal(last.usage.output, 5);
    assert.equal(last.requested_model, 'req-model');
    // Same request_id across the chain.
    assert.equal(events[0].request_id, last.request_id);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('relayed Anthropic non-2xx is upstream-error-relayed never ok', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream' } }));
  });
  const upPort = await listen(upstream);
  // oauth / no account.upstream → real-Anthropic path (no custom 5xx failover)
  const am = new AccountManager([oauth('a')]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
    });
    assert.equal(res.status, 500);
    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    const e = prov.events.find(ev => ev.final);
    assert.ok(e);
    assert.equal(e.outcome, 'upstream-error-relayed');
    assert.equal(e.response_status, 500);
    assert.notEqual(e.outcome, 'ok');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('advisor_model_requested captured pre-strip with advisor_degraded', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4',
      content: [], usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('a')]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    blockedModels: ['blocked-advisor*'],
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        messages: [],
        tools: [{ type: 'advisor', name: 'adv', model: 'blocked-advisor-x' }],
      }),
    });
    assert.equal(res.status, 200);
    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    const e = prov.events.find(ev => ev.final);
    assert.ok(e);
    assert.equal(e.advisor_model_requested, 'blocked-advisor-x');
    assert.equal(e.advisor_degraded, true);
    assert.equal(e.requested_model, 'claude-sonnet-4');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('streaming message_start populates response_reported_model', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"stream-served","usage":{"input_tokens":2,"output_tokens":0}}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('a')]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4', messages: [], stream: true }),
    });
    assert.equal(res.status, 200);
    await res.text();
    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    const e = prov.events.find(ev => ev.final && ev.stream);
    assert.ok(e);
    assert.equal(e.response_reported_model, 'stream-served');
    assert.equal(e.usage.input, 2);
    assert.equal(e.usage.output, 7);
    assert.equal(e.outcome, 'ok');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
