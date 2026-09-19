import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Live incident 2026-09-18/19: tangeddie1024 (OAuth) went into `error` (revoked
// grant) while dynamic mode + preserveSessionAffinity:true was live. A session
// pinned to it failed over to deepseek-v4-flash. Re-authing tangeddie1024
// flipped its status back to 'active', but the session stayed on
// deepseek-v4-flash for ~40 minutes — dynrank never pulled it back. Root cause,
// confirmed by reading the code (not guessed from symptoms): the
// error/throttled -> active transitions never set `requalify`, and even if they
// had, `_selectForSession`'s ONLY pull-back check compared `costTier` with a
// strict `<` — with costTier unconfigured (every account defaults to 0, see
// makeAccount), `cheaperEligible` is permanently false, so nothing could ever
// win the comparison regardless of timing.
//
// Fix: the three recovery transitions (setDisabled re-enable, clearRateLimited,
// updateAccountTokens after an error) now set `account.requalify = true`.
// `_selectForSession`'s dynamic+preserveSessionAffinity branch consumes that
// flag and re-ranks the recovered account against the pin using
// `dynamicCompare` — the same comparator dynamic mode uses everywhere else —
// instead of the tier-only `cheaperEligible` check, which stays for its
// original (hard economic boundary) purpose.
//
// `priority-first` mode is untouched and needs no fix: `betterExists` there
// re-checks `account.priority` on every request with no flag/memoization, so a
// recovered account is picked up on the very next request. It is a hand
// workaround for this bug (Eddie approved it live), not the buggy path itself.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function dynamicAffinity(accounts, opts = {}) {
  return new AccountManager(accounts, 0.98, {
    distributeSessions: true,
    routingPolicy: { mode: 'dynamic', preserveSessionAffinity: true },
    ...opts,
  });
}

const NOW = Date.now();
const H = 60 * 60 * 1000;

test('the live incident, reconstructed: an account.status error->active pulls the session home', () => {
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  // home fails: pin the session onto it first (as if it had been healthy),
  // then simulate the outage the same way the gateway does.
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback', 'precondition: outage fails over as expected');
  am.recordSession('s1', during.index); // the gateway repins on every served request

  // account.status flips back — this is updateAccountTokens's path (OAuth
  // re-auth), the one that actually fired in the incident.
  am.updateAccountTokens(0, { accessToken: 't-home-2' });
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].requalify, true, 'updateAccountTokens must arm requalify on recovery');

  const after = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(after.name, 'home', 'the session must be pulled back once its home account recovers');
});

test('clearRateLimited also arms requalify and pulls the session back', () => {
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.markRateLimited(0, 60);
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback');
  am.recordSession('s1', during.index);

  am.clearRateLimited(0);
  assert.equal(am.accounts[0].requalify, true);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home');
});

test('setDisabled re-enable also arms requalify and pulls the session back', () => {
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback');
  am.recordSession('s1', during.index);

  am.setDisabled(0, false); // re-enable clears the stuck error
  assert.equal(am.accounts[0].requalify, true);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home');
});

test('a recovery that ranks WORSE than the current pin does NOT pull the session', () => {
  // "recovered" must mean "actually preferred by dynamicCompare", not "any
  // account whose state just changed". A lower-priority/worse account
  // recovering from a transient throttle must not steal a session from a
  // genuinely better-ranked pin.
  const am = dynamicAffinity([
    oauth('best', { priority: 0, costTier: 0 }),
    oauth('worse', { priority: 50, costTier: 0 }),
  ]);
  measured(am, 0, { r7: NOW + H });      // best: resets soon (dynamic-preferred)
  measured(am, 1, { r7: NOW + 96 * H }); // worse: resets far out
  am.recordSession('s1', 0);
  am.accounts[1].status = 'error';
  am.clearRateLimited(1); // no-op path guard: status isn't 'throttled', exercise the flag directly
  am.accounts[1].requalify = true; // simulate the recovery event directly (status transition tested above)

  const result = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(result.name, 'best', 'a worse-ranked recovery must not displace a better-ranked pin');
  assert.equal(am.accounts[1].requalify, false, 'the flag is still consumed even when it does not win');
});

test('the requalify flag is consumed exactly once — no re-check storm on every request', () => {
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  am.recordSession('s1', am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').index);
  am.updateAccountTokens(0, { accessToken: 't-2' });

  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home');
  assert.equal(am.accounts[0].requalify, false, 'consumed on the pull-back that used it');

  // Fail again without a new recovery event: must NOT spuriously pull back a
  // second time (there is nothing to pull back FROM this time — establishes
  // the flag doesn't linger and cause phantom re-evaluation).
  am.accounts[0].status = 'error';
  const again = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(again.name, 'fallback');
});

test('preserveSessionAffinity:false is untouched by the recovery path', () => {
  const am = new AccountManager([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('other', { priority: 20, costTier: 0 }),
  ], 0.98, {
    distributeSessions: true,
    routingPolicy: { mode: 'dynamic', preserveSessionAffinity: false },
  });
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  am.recordSession('s1', am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').index);
  am.updateAccountTokens(0, { accessToken: 't-2' });
  // With affinity off, the session-pin branch is skipped entirely (line 708's
  // guard), so recovery has nothing to pull back INTO — best-available runs on
  // every request regardless, same as it always did.
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home');
});

test('priority-first mode needs no fix: the very next request re-checks priority live', () => {
  // This is the actual workaround Eddie approved live (mode switched to
  // priority-first). Confirms it was never broken — no requalify plumbing
  // needed on this path.
  const am = new AccountManager([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ], 0.98, { routingPolicy: { mode: 'priority-first' } });
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback');
  am.recordSession('s1', during.index);

  am.accounts[0].status = 'active'; // no requalify plumbing exercised at all
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home',
    'betterExists re-derives priority order on every call — recovery is immediate by construction');
});

function measured(am, idx, { u5 = 0.1, r5, u7 = 0.1, r7 } = {}) {
  const q = am.accounts[idx].quota;
  if (u5 != null) q.unified5h = u5;
  if (r5 != null) q.unified5hReset = r5;
  if (u7 != null) q.unified7d = u7;
  if (r7 != null) q.unified7dReset = r7;
}
