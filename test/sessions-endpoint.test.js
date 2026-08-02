import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  SessionTracker,
  SESSION_ACTIVE_TTL_MS,
} from '../src/session-tracker.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function snapshotBreaker(a) {
  return {
    circuitOpenUntil: a.circuitOpenUntil,
    circuitProbeInFlightAt: a.circuitProbeInFlightAt,
    consecutiveFailures: a.consecutiveFailures,
    status: a.status,
    rateLimitedUntil: a.rateLimitedUntil,
    quota: { ...a.quota },
  };
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

function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

test('GET /teamclaude/sessions returns teamclaude.sessions.v1 with build + absent honesty', async () => {
  const am = new AccountManager([oauth('a')]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/sessions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schema, 'teamclaude.sessions.v1');
    assert.ok(body.server?.build?.version);
    assert.equal(typeof body.server.startedAt, 'string');
    assert.equal(body.observed_since, body.server.startedAt);
    assert.ok(Array.isArray(body.sessions));
    assert.ok(body.absent?.awaiting_permission);
    assert.match(body.absent.awaiting_permission, /unobservable/i);
    assert.ok(body.absent?.current_turn_output_tokens, 'output-token lag must be stated in contract');
    assert.ok(body.absent?.count_tokens_ctx, 'count_tokens ctx exclusion must be labeled');
  } finally {
    await close(proxy);
  }
});

test('sessions + session-hint reads mutate nothing (breaker, probe claim, quota) — B3 purity', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ], 0.98);
  const a = am.accounts[0];
  a.circuitOpenUntil = Date.now() + 60_000;
  a.consecutiveFailures = 3;
  a.circuitProbeInFlightAt = Date.now();
  a.quota.unified7d = 0.99;
  a.quota.unified7dReset = Date.now() + 3_600_000;
  const before = snapshotBreaker(a);

  am.beginSession('s-pure');
  am.recordSession('s-pure', 0);
  am.endSession('s-pure');

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const sessionsRes = await fetch(`http://127.0.0.1:${port}/teamclaude/sessions`);
    assert.equal(sessionsRes.status, 200);
    await sessionsRes.json();
    assert.deepEqual(snapshotBreaker(a), before, 'sessions must not mutate breaker/quota');

    const hintRes = await fetch(`http://127.0.0.1:${port}/teamclaude/session-hint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-pure', state: 'awaiting_permission', source: 'claude-hook' }),
    });
    assert.equal(hintRes.status, 200);
    await hintRes.json();
    assert.deepEqual(snapshotBreaker(a), before, 'session-hint must not mutate breaker/quota');
  } finally {
    await close(proxy);
  }
});

test('building the sessions payload does not alter selection for an active session', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  const am = new AccountManager(
    [oauth('a'), oauth('b')],
    0.98,
    { distributeSessions: true, sessionTracker: st },
  );
  st.beginRequest('s-pin', clock.t);
  st.touch('s-pin', 1, clock.t); // pinned to account b
  const beforePin = st.pinnedAccount('s-pin', clock.t);
  const beforeSelect = am._selectForSession('s-pin', null, 'claude-sonnet-4', null)?.index;
  assert.equal(beforePin, 1);
  assert.equal(beforeSelect, 1);

  // Evidence write + pure snapshot must leave routing pins alone.
  st.noteSemanticBegin('s-pin', {
    at: clock.t, pathClass: 'messages', model: 'claude-sonnet-4', account: 'b',
  });
  st.noteUsage('s-pin', 'claude-sonnet-4', 50_000, { at: clock.t });
  // getSessions(config, now) — the clock is the SECOND argument. Passing
  // { now } as the first left `now` defaulting to Date.now(), so the fixed
  // clock was ignored and the snapshot was taken against real time.
  const payload = am.getSessions({}, clock.t);
  assert.ok(payload.sessions.some(s => s.session_id === 's-pin'));

  assert.equal(st.pinnedAccount('s-pin', clock.t), beforePin, 'pin unchanged after payload build');
  assert.equal(
    am._selectForSession('s-pin', null, 'claude-sonnet-4', null)?.index,
    beforeSelect,
    'selection unchanged after payload build',
  );
});

test('evidence-map MAX_SESSIONS eviction never drops a routing pin', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now, maxEvidence: 3 });
  st.touch('keep-pin', 0, clock.t);
  assert.equal(st.pinnedAccount('keep-pin', clock.t), 0);

  for (let i = 0; i < 5; i++) {
    clock.t += 1;
    st.noteSemanticBegin(`evict-${i}`, {
      at: clock.t, pathClass: 'messages', model: 'm', account: null,
    });
  }
  assert.equal(st.pinnedAccount('keep-pin', clock.t), 0, 'routing pin survives evidence eviction');
  assert.ok(st.evidence.size <= 3);
});

test('snapshot is pure — does not delete expired routing entries', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now, knownTtlMs: 1000 });
  st.touch('old', 0, clock.t);
  clock.t += 2000;
  const snap = st.snapshot(clock.t);
  assert.equal(snap.length, 0, 'expired filtered from snapshot');
  assert.equal(st.sessions.has('old'), true, 'must NOT delete on read');
});

test('busy iff in_flight>0; idle_ms null when busy; semantic stamp ages idle_ms', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, clock.t);
  st.noteSemanticBegin('s1', { at: clock.t, pathClass: 'messages', model: 'm', account: 'a' });
  clock.t += 5_000;
  let rows = st.snapshot(clock.t);
  let s = rows.find(r => r.session_id === 's1');
  assert.equal(s.state, 'busy');
  assert.equal(s.state_basis, 'in_flight>0');
  assert.equal(s.idle_ms, null);
  assert.equal(s.in_flight, 1);

  st.noteSemanticEnd('s1', clock.t);
  st.endRequest('s1', clock.t);
  clock.t += 12_000;
  rows = st.snapshot(clock.t);
  s = rows.find(r => r.session_id === 's1');
  assert.equal(s.state, 'idle');
  assert.equal(s.state_basis, 'last-semantic-request-age');
  assert.equal(s.idle_ms, 12_000);
});

test('event_logging beginSession does not stamp lastSemanticSeen or clear hint', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, clock.t);
  st.noteSemanticBegin('s1', { at: clock.t, pathClass: 'messages', model: 'm', account: 'a' });
  st.noteHint('s1', { state: 'awaiting_permission', at: clock.t, source: 'claude-hook' });
  st.noteSemanticEnd('s1', clock.t);
  st.endRequest('s1', clock.t);

  const semanticAt = clock.t;
  clock.t += 60_000;
  // Non-semantic traffic: begin/end only (event_logging path).
  st.beginRequest('s1', clock.t);
  st.endRequest('s1', clock.t);

  const s = st.snapshot(clock.t).find(r => r.session_id === 's1');
  assert.equal(s.idle_ms, clock.t - semanticAt, 'lastSemanticSeen unchanged by non-semantic begin');
  assert.equal(s.client_hint?.state, 'awaiting_permission', 'hint not cleared by non-semantic begin');
});

test('semantic begin clears client_hint; semantic end refreshes lastSemanticSeen', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, clock.t);
  st.noteSemanticBegin('s1', { at: clock.t, pathClass: 'messages', model: 'm', account: 'a' });
  st.noteHint('s1', { state: 'awaiting_permission', at: clock.t, source: 'hook' });
  st.noteSemanticEnd('s1', clock.t);
  st.endRequest('s1', clock.t);

  clock.t += 1000;
  const beginAt = clock.t;
  st.beginRequest('s1', clock.t);
  st.noteSemanticBegin('s1', { at: clock.t, pathClass: 'messages', model: 'm', account: 'a' });
  let s = st.snapshot(clock.t).find(r => r.session_id === 's1');
  assert.equal(s.client_hint, null, 'hint superseded by semantic begin');

  clock.t += 180_000; // multi-minute stream
  st.noteSemanticEnd('s1', clock.t);
  st.endRequest('s1', clock.t);
  clock.t += 500;
  s = st.snapshot(clock.t).find(r => r.session_id === 's1');
  assert.equal(s.idle_ms, 500, 'idle_ms from END stamp, not begin (would be 180500)');
  assert.ok(s.idle_ms !== clock.t - beginAt);
});

test('pre-gate rejection stamps lastSemanticSeen + last_rejection so retry loops are not idle', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.noteSemanticRejection('s-retry', {
    at: clock.t, status: 429, reason: 'quota-admission', model: 'm', pathClass: 'messages',
  });
  clock.t += 2_000;
  const s = st.snapshot(clock.t).find(r => r.session_id === 's-retry');
  assert.ok(s, 'evidence-only rejection session appears');
  assert.equal(s.state, 'idle');
  assert.equal(s.idle_ms, 2_000);
  assert.equal(s.last_rejection?.status, 429);
  assert.equal(s.last_rejection?.reason, 'quota-admission');
});

test('blocked-model / collision / typed-429 stamp semantic activity before return', async () => {
  // Blocked
  const amBlocked = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ]);
  const proxyBlocked = createProxyServer(amBlocked, {
    proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9', blockedModels: ['*blocked*'],
  });

  // Collision: account name equals model id, winning route excludes that account,
  // and the first candidate has NO custom upstream (provable Anthropic 404).
  const collideAccounts = [
    {
      name: 'primary@example.com', type: 'oauth', priority: 0,
      accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
    },
    {
      name: 'kimi-k3', type: 'apikey', apiKey: 'k3', priority: 60,
      upstream: 'http://127.0.0.1:9',
    },
  ];
  const collideRoutes = [
    { name: 'kimi', match: ['*kimi*', '*k3*'], accounts: ['primary@example.com'] },
    { name: 'default', match: ['*'], accounts: ['primary@example.com'] },
  ];
  const amCollide = new AccountManager(collideAccounts, 0.98, { routes: collideRoutes });
  const proxyCollide = createProxyServer(amCollide, {
    proxy: { apiKey: 'k' },
    upstream: 'http://127.0.0.1:9',
    accounts: collideAccounts,
    routes: collideRoutes,
  });

  // Typed-429 capacity admission
  const resetAt = Date.now() + 3_600_000;
  const amQuota = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ], 0.98);
  amQuota.accounts[0].quota.unified7d = 0.99;
  amQuota.accounts[0].quota.unified7dReset = resetAt;
  const proxyQuota = createProxyServer(amQuota, {
    proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9',
  });

  const portB = await listen(proxyBlocked);
  const portC = await listen(proxyCollide);
  const portQ = await listen(proxyQuota);
  try {
    await fetch(`http://127.0.0.1:${portB}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'sess-blocked',
      },
      body: JSON.stringify({ model: 'claude-blocked-9', messages: [] }),
    });
    await fetch(`http://127.0.0.1:${portC}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'sess-collide',
      },
      body: JSON.stringify({ model: 'kimi-k3', messages: [] }),
    });
    await fetch(`http://127.0.0.1:${portQ}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'sess-quota',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4', messages: [] }),
    });

    const b = await (await fetch(`http://127.0.0.1:${portB}/teamclaude/sessions`)).json();
    const c = await (await fetch(`http://127.0.0.1:${portC}/teamclaude/sessions`)).json();
    const q = await (await fetch(`http://127.0.0.1:${portQ}/teamclaude/sessions`)).json();

    const sb = b.sessions.find(s => s.session_id === 'sess-blocked');
    const sc = c.sessions.find(s => s.session_id === 'sess-collide');
    const sq = q.sessions.find(s => s.session_id === 'sess-quota');
    assert.ok(sb, 'blocked rejection stamped');
    assert.equal(sb.last_rejection?.status, 400);
    assert.ok(sc, 'collision rejection stamped');
    assert.equal(sc.last_rejection?.status, 400);
    assert.ok(sq, 'typed-429 rejection stamped');
    assert.equal(sq.last_rejection?.status, 429);
    assert.ok(typeof sq.idle_ms === 'number' && sq.idle_ms < 60_000);
  } finally {
    await close(proxyBlocked);
    await close(proxyCollide);
    await close(proxyQuota);
  }
});

test('noteUsage records observed context_tokens; count_tokens path is excluded from ctx', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.noteSemanticBegin('s1', { at: clock.t, pathClass: 'messages', model: 'claude-sonnet-4', account: 'a' });
  st.noteUsage('s1', 'claude-sonnet-4', 12_000, { at: clock.t, pathClass: 'messages' });
  // Caller must not invoke noteUsage for count_tokens; if it does with that
  // pathClass, tracker refuses to claim it as ctx.
  st.noteUsage('s1', 'claude-sonnet-4', 99, { at: clock.t, pathClass: 'count_tokens' });
  const s = st.snapshot(clock.t).find(r => r.session_id === 's1');
  assert.equal(s.ctx.context_tokens, 12_000);
  assert.equal(s.ctx_by_model['claude-sonnet-4'].context_tokens, 12_000);
});

test('ctx window estimate: default 200k, [1m] tag 1M, config.contextWindows override', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.noteSemanticBegin('s1', { at: clock.t, pathClass: 'messages', model: 'claude-sonnet-4', account: 'a' });
  st.noteUsage('s1', 'claude-sonnet-4', 1000, { at: clock.t });
  st.noteUsage('s1', 'claude-opus-4[1m]', 1000, { at: clock.t });
  st.noteUsage('s1', 'custom-model', 1000, { at: clock.t });

  const rows = st.snapshot(clock.t, {
    contextWindows: { 'custom-model': 500_000 },
  });
  const s = rows.find(r => r.session_id === 's1');
  assert.equal(s.ctx_by_model['claude-sonnet-4'].window_tokens, 200_000);
  assert.equal(s.ctx_by_model['claude-sonnet-4'].window_basis, 'default');
  assert.equal(s.ctx_by_model['claude-opus-4[1m]'].window_tokens, 1_000_000);
  assert.equal(s.ctx_by_model['claude-opus-4[1m]'].window_basis, '[1m]-tag');
  assert.equal(s.ctx_by_model['custom-model'].window_tokens, 500_000);
  assert.equal(s.ctx_by_model['custom-model'].window_basis, 'config-override');
});

test('ctx picks largest context_tokens among ACTIVE-window entries, else most recent', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.noteSemanticBegin('s1', { at: clock.t, pathClass: 'messages', model: 'opus', account: 'a' });
  st.noteUsage('s1', 'opus', 100_000, { at: clock.t });
  clock.t += 1;
  st.noteUsage('s1', 'haiku', 500, { at: clock.t }); // sidechain — smaller
  let s = st.snapshot(clock.t).find(r => r.session_id === 's1');
  assert.equal(s.ctx.model, 'opus');
  assert.equal(s.ctx.context_tokens, 100_000);

  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  st.noteUsage('s1', 'haiku', 800, { at: clock.t }); // only fresh entry
  s = st.snapshot(clock.t).find(r => r.session_id === 's1');
  assert.equal(s.ctx.model, 'haiku', 'falls back to most-recent when max is stale');
});

test('message_start usage is recorded into session ctx (cache fields summed)', async () => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const usage = {
        input_tokens: 1000,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      };
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { usage },
      })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 40 },
      })}\n\n`);
      res.end();
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: `http://127.0.0.1:${upPort}` },
  ]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'sess-sse',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4', messages: [], stream: true }),
    });
    assert.equal(res.status, 200);
    await res.text();

    const body = await (await fetch(`http://127.0.0.1:${port}/teamclaude/sessions`)).json();
    const s = body.sessions.find(x => x.session_id === 'sess-sse');
    assert.ok(s);
    assert.equal(s.resume_id, 'sess-sse');
    assert.equal(s.resume_id_provenance, 'observed-header-unverified');
    assert.equal(s.ctx.context_tokens, 1250, 'input+cache_read+cache_creation');
    assert.equal(s.state, 'idle');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('POST /teamclaude/session-hint stores client_hint; unknown session refused', async () => {
  const am = new AccountManager([oauth('a')]);
  am.beginSession('known');
  am.recordSession('known', 0);
  am.endSession('known');

  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/teamclaude/session-hint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'nope', state: 'awaiting_permission', source: 'claude-hook' }),
    });
    assert.equal(bad.status, 200);
    assert.deepEqual(await bad.json(), { stored: false, reason: 'unknown-session' });

    const ok = await fetch(`http://127.0.0.1:${port}/teamclaude/session-hint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'known', state: 'awaiting_permission', source: 'claude-hook' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { stored: true });

    const body = await (await fetch(`http://127.0.0.1:${port}/teamclaude/sessions`)).json();
    const s = body.sessions.find(x => x.session_id === 'known');
    assert.equal(s.client_hint.state, 'awaiting_permission');
    assert.equal(s.client_hint.provenance, 'client-reported');
    assert.equal(s.state, 'idle', 'hint never merges into state');
  } finally {
    await close(proxy);
  }
});
