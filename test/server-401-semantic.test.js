// T8 §4 — semantic re-verify of upstream #136 (401 re-auth+retry) against
// B2/B3 breaker scoring, T4 admission, and T7 provenance.
//
// Textual-clean auto-merge of #136 into our server.js is NOT sufficient:
// the 401 recursion is a NEW selection/egress and must (1) release the
// half-open probe claim, (2) not score as a breaker failure, (3) not re-trip
// T4 or double-count T7 attempts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PROVENANCE_OUTCOMES } from '../src/provenance.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const HOUR = 3600_000;

function revokingUpstream(live) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    if (!live.has(token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'OAuth access token has been revoked' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'served',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  return { server, seen };
}

async function postMessages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'req-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  return res.status;
}

test('outcome enum includes reauth-401-retry', () => {
  assert.ok(PROVENANCE_OUTCOMES.includes('reauth-401-retry'));
});

// (1) 401-retry must not leak the circuit probe claim (RF-1 class).
// Half-open custom-upstream OAuth: first egress 401s, refresh+retry succeeds.
// The probe claim acquired for the half-open trial MUST be released before the
// recursive selection — otherwise the account stays hidden for the claim TTL.
test('401-retry releases the half-open circuit probe claim before recursing', async () => {
  const { server: upstream, seen } = revokingUpstream(new Set(['fresh']));
  const upPort = await listen(upstream);

  let refreshes = 0;
  const am = new AccountManager(
    [{
      name: 'custom-oauth',
      type: 'oauth',
      accessToken: 'revoked',
      refreshToken: 'r',
      expiresAt: Date.now() + HOUR,
      upstream: `http://127.0.0.1:${upPort}`,
      modelMap: { 'req-model': 'mapped' },
    }],
    0.98,
    {
      refreshFn: async () => {
        refreshes++;
        return { accessToken: 'fresh', refreshToken: 'r2', expiresAt: Date.now() + HOUR };
      },
    },
  );
  // Force half-open so selection acquires a probe claim.
  am.accounts[0].circuitOpenUntil = Date.now() - 1;
  am.accounts[0].consecutiveFailures = 2;

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    assert.equal(await postMessages(port), 200);
    assert.equal(refreshes, 1);
    assert.deepEqual(seen, ['revoked', 'fresh']);
    assert.equal(
      am.accounts[0].circuitProbeInFlightAt,
      null,
      '401-retry must release the probe claim (RF-1 leak otherwise)',
    );
    // Account remains selectable — a leaked claim would hide it from _isAvailable.
    assert.equal(am._isAvailable(am.accounts[0], 'req-model'), true);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// (2) 401-retry must not be scored as a breaker failure.
// A 401 is an auth event. B2 only scores account.upstream && status>=500.
test('401 on a custom-upstream OAuth account does not open the circuit', async () => {
  const { server: upstream } = revokingUpstream(new Set(['fresh']));
  const upPort = await listen(upstream);

  const am = new AccountManager(
    [{
      name: 'custom-oauth',
      type: 'oauth',
      accessToken: 'revoked',
      refreshToken: 'r',
      expiresAt: Date.now() + HOUR,
      upstream: `http://127.0.0.1:${upPort}`,
      modelMap: { 'req-model': 'mapped' },
    }],
    0.98,
    {
      refreshFn: async () => ({
        accessToken: 'fresh', refreshToken: 'r2', expiresAt: Date.now() + HOUR,
      }),
    },
  );
  am.accounts[0].consecutiveFailures = 0;
  am.accounts[0].circuitOpenUntil = null;

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    assert.equal(await postMessages(port), 200);
    assert.equal(
      am.accounts[0].consecutiveFailures,
      0,
      '401 must not increment consecutiveFailures',
    );
    assert.equal(
      am.accounts[0].circuitOpenUntil,
      null,
      '401 must not open the provider circuit',
    );
  } finally {
    proxy.close();
    upstream.close();
  }
});

// (3) 401-retry must not bypass/re-trip T4, and must advance T7 attempt by exactly
// one with a non-final reauth-401-retry event before the final settled attempt.
test('401-retry emits reauth-401-retry provenance and advances attempt once; does not trip T4', async () => {
  const { server: upstream, seen } = revokingUpstream(new Set(['fresh']));
  const upPort = await listen(upstream);

  const am = new AccountManager(
    [{
      name: 'custom-oauth',
      type: 'oauth',
      accessToken: 'revoked',
      refreshToken: 'r',
      expiresAt: Date.now() + HOUR,
      upstream: `http://127.0.0.1:${upPort}`,
      modelMap: { 'req-model': 'mapped' },
    }],
    0.98,
    {
      refreshFn: async () => ({
        accessToken: 'fresh', refreshToken: 'r2', expiresAt: Date.now() + HOUR,
      }),
    },
  );

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    assert.equal(await postMessages(port), 200);
    assert.deepEqual(seen, ['revoked', 'fresh']);

    const prov = await (await fetch(`http://127.0.0.1:${port}/teamclaude/provenance`)).json();
    const events = prov.events.filter(e => e.path === '/v1/messages');
    assert.ok(events.length >= 2, `expected reauth chain, got ${events.length}: ${JSON.stringify(events)}`);

    const reauth = events.find(e => e.outcome === 'reauth-401-retry');
    assert.ok(reauth, 'missing reauth-401-retry event');
    assert.equal(reauth.final, false);
    assert.equal(reauth.response_status, 401);
    assert.equal(reauth.attempt, 1);

    const last = events[events.length - 1];
    assert.equal(last.final, true);
    assert.equal(last.outcome, 'ok');
    assert.equal(last.attempt, 2, '401-retry is exactly one new egress (no double-count)');

    // T4 is pre-forward in createProxyRequestListener; 401 recurses into
    // forwardRequest only, so the typed exhausted-429 outcome must not appear.
    assert.ok(
      !events.some(e => e.outcome === 'exhausted-typed-429'),
      '401-retry must not re-enter the T4 admission gate',
    );
  } finally {
    proxy.close();
    upstream.close();
  }
});
