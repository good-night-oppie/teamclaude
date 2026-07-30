import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PROVENANCE_OUTCOMES } from '../src/provenance.js';
import {
  shouldStripForeignThinking,
  stripThinkingBlocks,
} from '../src/thinking-strip.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = (b) => JSON.parse(b.toString('utf8'));

const thinkingBody = {
  model: 'claude-opus-4',
  messages: [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'foreign sig', signature: 'sakana-sig' },
        { type: 'text', text: 'hello' },
        { type: 'redacted_thinking', data: 'opaque' },
      ],
    },
    { role: 'user', content: 'again' },
  ],
};

async function setupProxy({
  ingressThinkingStrip,
  accounts,
  markFamily = null,
  sessionId = 'sess-d3',
} = {}) {
  let lastBody = null;
  let lastBodyRaw = null;
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      lastBodyRaw = Buffer.concat(chunks);
      lastBody = lastBodyRaw.toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_x', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  const upPort = await listen(upstream);
  const acctList = accounts || [
    {
      name: 'primary', type: 'oauth', priority: 0,
      accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
    },
    {
      name: 'sakana', type: 'apikey', priority: 50, apiKey: 'k',
      upstream: `http://127.0.0.1:${upPort}`,
      historyFamily: 'sakana',
    },
  ];
  const am = new AccountManager(acctList, 0.98);
  if (markFamily) {
    am.rotationLedger.mark(sessionId, markFamily);
  }
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    ...(ingressThinkingStrip != null ? { ingressThinkingStrip } : {}),
  });
  const port = await listen(proxy);
  return {
    am, port, proxy, upstream, sessionId,
    get hits() { return hits; },
    get lastBody() { return lastBody; },
    get lastBodyRaw() { return lastBodyRaw; },
    async post(bodyObj, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-claude-code-session-id': sessionId,
          ...headers,
        },
        body: JSON.stringify(bodyObj),
      });
      await res.text();
      return res;
    },
    async close() { await close(proxy); await close(upstream); },
  };
}

// ── unit: predicate ───────────────────────────────────────────

test('shouldStripForeignThinking is inert without enable / anthropic target / foreign ledger', () => {
  assert.equal(shouldStripForeignThinking({
    enabled: false, targetFamily: 'anthropic', servedFamilies: ['sakana'],
  }), false);
  assert.equal(shouldStripForeignThinking({
    enabled: true, targetFamily: 'sakana', servedFamilies: ['sakana'],
  }), false);
  assert.equal(shouldStripForeignThinking({
    enabled: true, targetFamily: 'anthropic', servedFamilies: [],
  }), false);
  assert.equal(shouldStripForeignThinking({
    enabled: true, targetFamily: 'anthropic', servedFamilies: ['anthropic'],
  }), false);
  assert.equal(shouldStripForeignThinking({
    enabled: true, targetFamily: 'anthropic', servedFamilies: ['sakana'],
  }), true);
  assert.equal(shouldStripForeignThinking({
    enabled: true, targetFamily: 'anthropic', servedFamilies: ['anthropic', 'sakana'],
  }), true);
});

test('stripThinkingBlocks drops thinking + redacted_thinking, keeps siblings, same-Buffer when untouched', () => {
  const original = buf(thinkingBody);
  const { body, count } = stripThinkingBlocks(original, '/v1/messages', 'application/json');
  assert.equal(count, 2);
  const out = parse(body);
  assert.equal(out.messages[1].content.length, 1);
  assert.equal(out.messages[1].content[0].type, 'text');
  assert.equal(out.messages[1].content[0].text, 'hello');
  assert.equal(out.messages.length, 3);

  const clean = buf({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
  const noop = stripThinkingBlocks(clean, '/v1/messages', 'application/json');
  assert.equal(noop.count, 0);
  assert.equal(noop.body, clean);
});

test('stripThinkingBlocks drops a message whose content becomes empty', () => {
  const original = buf({
    model: 'x',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only', signature: 's' }] },
      { role: 'user', content: 'follow' },
    ],
  });
  const { body, count } = stripThinkingBlocks(original, '/v1/messages', 'application/json');
  assert.equal(count, 1);
  const out = parse(body);
  // Empty assistant removed; adjacent user turns coalesced (API requires
  // non-empty content + alternating roles).
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, 'user');
});

test('PROVENANCE_OUTCOMES includes thinking-stripped', () => {
  assert.ok(PROVENANCE_OUTCOMES.includes('thinking-stripped'));
});

// ── integration: forward path ─────────────────────────────────

test('absent ingressThinkingStrip is byte-identical (thinking blocks forward unchanged)', async () => {
  const t = await setupProxy({ markFamily: 'sakana' });
  try {
    const res = await t.post(thinkingBody);
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1);
    const forwarded = JSON.parse(t.lastBody);
    assert.equal(forwarded.messages[1].content.length, 3);
    assert.ok(forwarded.messages[1].content.some(b => b.type === 'thinking'));
    assert.ok(forwarded.messages[1].content.some(b => b.type === 'redacted_thinking'));
  } finally {
    await t.close();
  }
});

test('strip fires only on anthropic target + foreign-family ledger; provenance count emitted', async () => {
  const t = await setupProxy({ ingressThinkingStrip: true, markFamily: 'sakana' });
  try {
    const res = await t.post(thinkingBody);
    assert.equal(res.status, 200);
    const forwarded = JSON.parse(t.lastBody);
    assert.equal(forwarded.messages[1].content.length, 1);
    assert.equal(forwarded.messages[1].content[0].type, 'text');

    const prov = await fetch(`http://127.0.0.1:${t.port}/teamclaude/provenance`, {
      headers: { 'x-api-key': 'k' },
    });
    const snap = await prov.json();
    const stripped = (snap.events || []).filter(e => e.outcome === 'thinking-stripped');
    assert.equal(stripped.length, 1);
    assert.equal(stripped[0].final, false);
    assert.equal(stripped[0].count, 2);
  } finally {
    await t.close();
  }
});

test('anthropic→anthropic history is untouched (caching-safe)', async () => {
  const t = await setupProxy({ ingressThinkingStrip: true, markFamily: 'anthropic' });
  try {
    await t.post(thinkingBody);
    const forwarded = JSON.parse(t.lastBody);
    assert.equal(forwarded.messages[1].content.length, 3);
    const prov = await fetch(`http://127.0.0.1:${t.port}/teamclaude/provenance`, {
      headers: { 'x-api-key': 'k' },
    });
    const snap = await prov.json();
    assert.equal((snap.events || []).filter(e => e.outcome === 'thinking-stripped').length, 0);
  } finally {
    await t.close();
  }
});

test('empty ledger (restart wipe) falls back to inert — no strip', async () => {
  const t = await setupProxy({ ingressThinkingStrip: true, markFamily: null });
  try {
    assert.deepEqual(t.am.rotationLedger.familiesOf(t.sessionId), []);
    await t.post(thinkingBody);
    const forwarded = JSON.parse(t.lastBody);
    assert.equal(forwarded.messages[1].content.length, 3);
  } finally {
    await t.close();
  }
});

test('non-anthropic target does not strip even with foreign ledger + flag on', async () => {
  let lastBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'sakana', type: 'apikey', priority: 0, apiKey: 'k',
    upstream: `http://127.0.0.1:${upPort}`,
    historyFamily: 'sakana',
  }], 0.98);
  am.rotationLedger.mark('sess-d3', 'codex');
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    ingressThinkingStrip: true,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claude-code-session-id': 'sess-d3',
      },
      body: JSON.stringify(thinkingBody),
    });
    await res.text();
    assert.equal(res.status, 200);
    const forwarded = JSON.parse(lastBody);
    assert.equal(forwarded.messages[1].content.length, 3, 'non-anthropic target keeps its blocks');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
