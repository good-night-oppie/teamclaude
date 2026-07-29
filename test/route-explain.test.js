import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainRouting, formatExplain, launchSummary } from '../src/route-explain.js';
import { preflightModel } from '../src/model-preflight.js';
import { AccountManager } from '../src/account-manager.js';
import {
  routabilityOf,
  normalizeRoutes,
  normalizeAccounts,
  accountAllows,
  routeForModel,
} from '../src/model-namespace.js';

// Covers src/route-explain.js: the read-only decision trace for "which account
// and which upstream model id will serve a request for <model>". Every fixture
// is inline — the module takes a plain config object, so no tmpdir, no server,
// no port, and the real ~/.config/teamclaude.json is never read.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function apikey(name, extra = {}) {
  return { name, type: 'apikey', apiKey: 'k-' + name, ...extra };
}

const FABLE = 'claude-fable-5';
const OPUS = 'claude-opus-4-8';

// The reference fixture: a catch-all last (the correct shape), one exclusive
// named route, a third-party backend with a modelMap, and a disabled account.
function fixture() {
  return {
    upstream: 'https://api.anthropic.com',
    blockedModels: ['*preview*'],
    routes: [
      { name: 'fable', match: ['*fable*'], accounts: ['alice', 'fugu'] },
      { name: 'default', match: ['*'], accounts: ['alice', 'bob', 'fugu'] },
    ],
    accounts: [
      oauth('alice', { priority: 10 }),
      oauth('bob', { priority: 20 }),
      apikey('fugu', {
        priority: 30,
        upstream: 'http://127.0.0.1:8083',
        modelMap: { [FABLE]: 'fugu-2', 'claude-fable-5[1m]': 'fugu-2' },
      }),
      apikey('kimi-k3', { priority: 5, disabled: true, upstream: 'http://127.0.0.1:8086' }),
    ],
  };
}

// ── route matching ────────────────────────────────────────────

test('a model matching exactly one route names that route, its glob, and its exclusivity', () => {
  const trace = explainRouting(fixture(), OPUS);
  assert.equal(trace.route.matched.name, 'default');
  assert.equal(trace.route.matched.glob, '*');
  assert.equal(trace.route.matchCount, 1);
  assert.deepEqual(trace.route.shadowed, [], 'nothing is shadowed when only one route matches');
  assert.equal(trace.route.matched.exclusive, true, 'the route lists accounts, so it is exclusive');
});

test('when several routes match, the first in array order wins and the losers are reported as shadowed', () => {
  const trace = explainRouting(fixture(), FABLE);
  assert.equal(trace.route.matchCount, 2, 'both "fable" and the catch-all match');
  assert.equal(trace.route.matched.name, 'fable');
  assert.equal(trace.route.matched.index, 0);
  assert.deepEqual(trace.route.shadowed.map(s => s.name), ['default'],
    'the catch-all matches too but never fires for this id');
});

test('route order is load-bearing: moving the catch-all first changes which route wins', () => {
  const cfg = fixture();
  cfg.routes = [cfg.routes[1], cfg.routes[0]];       // catch-all first
  const trace = explainRouting(cfg, FABLE);
  assert.equal(trace.route.matched.name, 'default');
  assert.deepEqual(trace.route.shadowed.map(s => s.name), ['fable']);
  assert.ok(trace.warnings.some(w => w.code === 'catch-all-not-last'),
    'a non-final catch-all is flagged — every route after it is dead');
});

test('setRoutes normalization is reproduced: a string match, numeric account tokens, and empty-match routes', () => {
  const cfg = {
    routes: [
      { match: [] },                                  // dropped: no globs survive
      { match: '*fable*', accounts: ['1'] },           // string match, account by index
    ],
    accounts: [oauth('alice'), oauth('bob')],
  };
  const trace = explainRouting(cfg, FABLE);
  assert.equal(trace.route.total, 1, 'the empty-match route is dropped before matching');
  assert.equal(trace.route.matched.name, 'route-2', 'the default name uses the pre-filter position');
  assert.deepEqual(trace.candidates.map(c => c.name), ['bob'], 'account index "1" resolves to bob');
});

// ── ownership fallback ────────────────────────────────────────

test('a model matching no route falls through to the per-account models[] ownership claim', () => {
  const cfg = {
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['alice'] }],
    accounts: [oauth('alice'), apikey('deepseek', { models: ['deepseek-v4-pro[1m]'] }), oauth('bob')],
  };
  const trace = explainRouting(cfg, 'deepseek-v4-pro');
  assert.equal(trace.route.matched, null, 'no route glob matches');
  assert.equal(trace.ownership.consulted, true, 'with no matching route, ownership decides');
  assert.equal(trace.ownership.claimed, true);
  assert.deepEqual(trace.ownership.owners.map(o => o.name), ['deepseek'],
    'the [1m] suffix on the claim still names the bare request id');
  assert.deepEqual(trace.candidates.map(c => c.name), ['deepseek'],
    'ownership is a global trigger — non-owners become ineligible');
  assert.deepEqual(trace.ineligible.map(a => a.reason).sort(), ['not-an-owner', 'not-an-owner']);
});

test('an exclusive route suppresses the ownership claim entirely, and that is flagged', () => {
  const cfg = {
    routes: [{ name: 'default', match: ['*'], accounts: ['alice', 'deepseek'] }],
    accounts: [oauth('alice'), apikey('deepseek', { models: ['deepseek-v4-pro'] })],
  };
  const trace = explainRouting(cfg, 'deepseek-v4-pro');
  assert.equal(trace.ownership.claimed, true);
  assert.equal(trace.ownership.consulted, false, 'the catch-all lists accounts, so ownership is unreachable');
  assert.deepEqual(trace.candidates.map(c => c.name), ['alice', 'deepseek'],
    'alice is eligible despite not owning the model — the route decided, not ownership');
  assert.ok(trace.warnings.some(w => w.code === 'ownership-suppressed'),
    'the inert models[] claim is reported as a config finding');
});

test('a route that lists no accounts does not restrict, and ownership decides instead', () => {
  const cfg = {
    routes: [{ name: 'fable', match: ['*fable*'], bucket: 'unified7dFable' }],
    accounts: [oauth('alice'), oauth('bob', { models: [FABLE] })],
  };
  const trace = explainRouting(cfg, FABLE);
  assert.equal(trace.route.matched.exclusive, false);
  assert.equal(trace.route.governingBucket, 'unified7dFable', 'the route bucket override wins');
  assert.deepEqual(trace.candidates.map(c => c.name), ['bob'], 'bob owns Fable, alice does not');
});

// ── blocklist ─────────────────────────────────────────────────

test('a blocked model is reported as a short-circuit before any account is considered', () => {
  const trace = explainRouting(fixture(), 'claude-preview-9');
  assert.equal(trace.blocked.blocked, true);
  assert.equal(trace.blocked.pattern, '*preview*');
  assert.equal(trace.blocked.shortCircuits, true);
  assert.match(formatExplain(trace), /BLOCKED by "\*preview\*"/);
  assert.match(formatExplain(trace), /never reached — blocked above/,
    'the would-be candidates are still shown, clearly marked unreachable');
});

test('an empty blocklist blocks nothing', () => {
  const cfg = fixture();
  delete cfg.blockedModels;
  const trace = explainRouting(cfg, 'claude-preview-9');
  assert.equal(trace.blocked.blocked, false);
  assert.equal(trace.blocked.pattern, null);
});

// ── candidates, ordering, and the upstream view ───────────────

test('candidates are ordered by priority ascending and disabled accounts are excluded with a reason', () => {
  const trace = explainRouting(fixture(), OPUS);
  assert.deepEqual(trace.candidates.map(c => c.name), ['alice', 'bob', 'fugu']);
  assert.deepEqual(trace.candidates.map(c => c.rank), [1, 2, 3]);
  const kimi = trace.ineligible.find(a => a.name === 'kimi-k3');
  assert.equal(kimi.reason, 'disabled',
    'kimi-k3 has the lowest priority value (5) but is disabled, so it never appears as a candidate');
  assert.ok(!trace.candidates.some(c => c.name === 'kimi-k3'));
});

test('equal priorities are broken by config array order', () => {
  const cfg = { routes: [], accounts: [oauth('c', { priority: 7 }), oauth('a', { priority: 7 }), oauth('b', { priority: 7 })] };
  assert.deepEqual(explainRouting(cfg, OPUS).candidates.map(c => c.name), ['c', 'a', 'b']);
});

test('an account whose modelMap rewrites the id shows the model the upstream actually receives', () => {
  const trace = explainRouting(fixture(), FABLE);
  const fugu = trace.candidates.find(c => c.name === 'fugu');
  assert.equal(fugu.upstreamModel, 'fugu-2');
  assert.equal(fugu.rewritten, true);
  assert.equal(fugu.upstreamHost, '127.0.0.1:8083', 'the per-account upstream wins over the global one');
  const alice = trace.candidates.find(c => c.name === 'alice');
  assert.equal(alice.upstreamModel, FABLE, 'no modelMap → the id egresses verbatim');
  assert.equal(alice.rewritten, false);
  assert.equal(alice.upstreamHost, 'api.anthropic.com');
  assert.match(formatExplain(trace), /model -> fugu-2/);
});

test('the modelMap rewrite is exact and case-sensitive, so a [1m]-only key is flagged as a near miss', () => {
  const cfg = {
    routes: [],
    accounts: [apikey('fugu', { upstream: 'http://127.0.0.1:8083', modelMap: { 'claude-fable-5[1m]': 'fugu-2' } })],
  };
  const trace = explainRouting(cfg, FABLE);
  const fugu = trace.candidates[0];
  assert.equal(fugu.rewritten, false, 'rewriteModel does no [Nm] stripping');
  assert.equal(fugu.upstreamModel, FABLE, 'the unmapped id reaches the backend verbatim');
  assert.equal(fugu.modelMapNearMiss, 'claude-fable-5[1m]');
  assert.ok(trace.warnings.some(w => w.code === 'model-map'));
});

test('no eligible account is reported as the 429 it would produce, not as an empty list', () => {
  const cfg = {
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['nobody'] }],
    accounts: [oauth('alice')],
  };
  const trace = explainRouting(cfg, FABLE);
  assert.deepEqual(trace.candidates, []);
  assert.ok(trace.warnings.some(w => w.code === 'no-eligible-account'));
  assert.ok(trace.warnings.some(w => w.code === 'route-names-unknown-account'),
    'a route naming a non-existent account is a config defect worth naming');
});

// ── fallback chain ────────────────────────────────────────────

test('the fallback chain is the candidate order, bounded by one attempt per account', () => {
  const trace = explainRouting(fixture(), OPUS);
  assert.deepEqual(trace.fallback.chain, ['alice', 'bob', 'fugu']);
  assert.equal(trace.fallback.maxRetries, 4, 'maxRetries is the account count, disabled ones included');
  assert.equal(trace.fallback.pinned, false);
  assert.ok(trace.fallback.rules.some(r => /transient429RotateAfter/.test(r)),
    'transient-429 cap-then-rotate (R1) must be stated in fallback rules');
  assert.ok(trace.fallback.rules.some(r => /non-429/.test(r)),
    'a 404 for an unknown model id is relayed verbatim with no failover');
});

test('a /tc-acct pin forces one account and never fails over', () => {
  const trace = explainRouting(fixture(), FABLE, { account: 'bob' });
  assert.equal(trace.pin.resolved, true);
  assert.equal(trace.pin.name, 'bob');
  assert.equal(trace.pin.failsOver, false);
  assert.deepEqual(trace.candidates.map(c => c.name), ['bob'], 'the pin bypasses selection entirely');
  assert.deepEqual(trace.fallback.chain, ['bob']);
  assert.equal(trace.fallback.maxRetries, 0);
  assert.equal(trace.pin.routable, false, 'route "fable" would never have picked bob');
  assert.ok(trace.warnings.some(w => w.code === 'pin-outside-routing'));
});

test('a pin is resolved by exact name first, then by numeric index, and an unknown token is a local 404', () => {
  assert.equal(explainRouting(fixture(), OPUS, { account: '2' }).pin.name, 'fugu');
  const bad = explainRouting(fixture(), OPUS, { account: 'nope' });
  assert.equal(bad.pin.resolved, false);
  assert.deepEqual(bad.candidates, []);
  assert.ok(bad.warnings.some(w => w.code === 'pin-unresolved'));
});

// ── parity with the real router ───────────────────────────────

test('the candidate order matches what the real AccountManager would actually pick, in failover order', () => {
  const cfg = fixture();
  const am = new AccountManager(cfg.accounts, 0.98, { routes: cfg.routes });
  const tried = new Set();
  const actual = [];
  for (;;) {
    const account = am.getActiveAccount(tried, FABLE);
    if (!account) break;
    actual.push(account.name);
    tried.add(account.index);
  }
  assert.deepEqual(explainRouting(cfg, FABLE).fallback.chain, actual,
    'the explanation reproduces the router, it does not approximate it');
});

test('eligibility parity: every account the trace calls ineligible is one _routeAllows/disabled rejects', () => {
  const cfg = fixture();
  const am = new AccountManager(cfg.accounts, 0.98, { routes: cfg.routes });
  for (const model of [FABLE, OPUS, 'deepseek-v4-pro']) {
    const trace = explainRouting(cfg, model);
    const eligible = new Set(trace.candidates.map(c => c.name));
    for (const account of am.accounts) {
      assert.equal(eligible.has(account.name), am._isAvailable(account, model),
        `${account.name} / ${model}: trace and router must agree on eligibility`);
    }
  }
});

// ── purity and shape ──────────────────────────────────────────

test('explainRouting is pure: it never mutates the config and the trace is JSON-serializable', () => {
  const cfg = fixture();
  const before = JSON.stringify(cfg);
  const trace = explainRouting(cfg, FABLE, { account: 'alice' });
  assert.equal(JSON.stringify(cfg), before, 'the input config is untouched');
  assert.deepEqual(JSON.parse(JSON.stringify(trace)), trace, 'a --json flag is a one-liner for the caller');
});

test('a request with no model id skips the route and ownership rules entirely', () => {
  const cfg = fixture();
  const trace = explainRouting(cfg, null);
  assert.equal(trace.model, null);
  assert.equal(trace.route.matched, null);
  assert.equal(trace.blocked.blocked, false);
  assert.deepEqual(trace.candidates.map(c => c.name), ['alice', 'bob', 'fugu'],
    'the router only consults routes when the request carries a model (account-manager.js:554)');
});

test('an empty config explains itself instead of throwing', () => {
  const trace = explainRouting({}, FABLE);
  assert.deepEqual(trace.candidates, []);
  assert.equal(trace.route.total, 0);
  assert.ok(formatExplain(trace).length > 0);
});

// ── formatting ────────────────────────────────────────────────

test('formatExplain is stable, plain text, and answers the four questions it exists to answer', () => {
  const trace = explainRouting(fixture(), FABLE);
  const out = formatExplain(trace);
  assert.equal(out, formatExplain(trace), 'same trace → byte-identical output (no clock, no randomness)');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('\x1b['), 'no ANSI: the output is meant to be pasted into an issue');

  assert.match(out, /^model: claude-fable-5$/m);
  assert.match(out, /blocklist {3}: not blocked/);
  assert.match(out, /route {7}: "fable"/);
  assert.match(out, /candidates {2}: tried in this order/);
  assert.match(out, /1\. alice/);
  assert.match(out, /2\. fugu/);
  assert.match(out, /not eligible: /);
  assert.match(out, /fallback {4}: alice → fugu/);
  assert.match(out, /explanation : /);
  assert.match(out, /caveats {5}: /);

  const overlong = out.split('\n').filter(l => l.length > 100);
  assert.deepEqual(overlong, [], 'prose is wrapped; only the aligned table may run long');
});

test('formatExplain states the ordering rule and the runtime factors it cannot see', () => {
  const out = formatExplain(explainRouting(fixture(), OPUS));
  assert.match(out, /priority ascending, then config array order/);
  assert.match(out, /quota-blind/);
  assert.match(out, /Tok - Req -/, 'the apikey quota gap is acknowledged, not silently implied to be fine');
  assert.match(out, /availableModels/, 'the client-side allowlist can still veto a perfectly routable id');
});

// ── one derivation: the trace cannot disagree with the router ──

test('the headline verdict is the same oracle `run`\'s preflight blocks on, not a second opinion', () => {
  const cfg = fixture();
  for (const id of [FABLE, OPUS, 'deepseek-v4-pro', 'claude-zephyr-9-not-yet-released']) {
    const trace = explainRouting(cfg, id);
    const oracle = routabilityOf(cfg, id);
    assert.equal(trace.verdict.routable, oracle.routable, `verdict must match routabilityOf for "${id}"`);
    assert.equal(trace.verdict.reason, oracle.reason);
  }
});

test('under a pin the headline verdict is the PINNED one, so it cannot contradict the pin row below it', () => {
  // The verdict row is the line an operator debugging a failed launch reads
  // first. Printing the unpinned verdict there produced a self-contradicting
  // page: "NOT ROUTABLE … first choice alice" as the headline, directly above
  // "pin: /tc-acct/bob → account bob" and a candidate table containing only bob.
  const trace = explainRouting(fixture(), FABLE, { account: 'bob' });
  assert.equal(trace.verdict.pinned, true);
  assert.equal(trace.verdict.routable, true, 'bob serves it — the pin bypasses the route that excludes him');
  assert.match(trace.verdict.reason, /bypasses selection/);

  // The unpinned answer is not discarded: "the rules would never have picked
  // this account" is exactly what a pin is for and is worth seeing.
  assert.equal(trace.verdictUnpinned.routable, true);
  assert.ok(!trace.verdictUnpinned.reason.includes('bypasses selection'));

  const out = formatExplain(trace);
  assert.match(out, /verdict {5}: PINNED — SERVED/);
  assert.match(out, /without the pin:/);
  assert.ok(!/verdict {5}: NOT ROUTABLE/.test(out));

  // With no pin the row is unchanged, and there is no second line to explain.
  const plain = explainRouting(fixture(), FABLE);
  assert.equal(plain.verdict.pinned, false);
  assert.equal(plain.verdictUnpinned, null);
});

test('explain and the preflight read the SAME pinned oracle, so `run --account X` and `explain X --account` cannot disagree', () => {
  // The divergence that shipped: `run --account deepseek -- --model M` refused
  // the launch while `explain M --account deepseek` on the same config described
  // it working. Two tools, two oracles, one config.
  const cfg = fixture();
  for (const [model, account] of [[FABLE, 'bob'], [OPUS, 'fugu'], [FABLE, 'kimi-k3'],
    ['claude-preview-x', 'alice'], [OPUS, 'nope']]) {
    const trace = explainRouting(cfg, model, { account });
    const decision = preflightModel({ config: cfg, claudeArgs: ['--model', model], accountPin: { token: account } });
    const explainSaysServed = trace.pin.resolved && trace.verdict.routable;
    assert.equal(decision.blocked, !explainSaysServed,
      `run and explain disagree about "${model}" pinned to "${account}"`);
  }
});

test('eligibility is decided by the shared predicate for every account x model pair', () => {
  // The dedupe gate. explainRouting narrates; model-namespace.accountAllows
  // decides. If someone reintroduces a local copy of the rules here, this fails.
  const cfg = fixture();
  const routes = normalizeRoutes(cfg.routes);
  const accounts = normalizeAccounts(cfg.accounts);
  for (const id of [FABLE, OPUS, 'deepseek-v4-pro', 'claude-haiku-4-5']) {
    const trace = explainRouting(cfg, id);
    const eligible = new Set(trace.candidates.map(c => c.name));
    for (const a of accounts) {
      if (a.disabled) continue;   // an operator toggle, not a routing rule
      assert.equal(eligible.has(a.name), accountAllows(routes, accounts, a, id),
        `explain and the router must agree on ${a.name} x ${id}`);
    }
  }
});

test('the winning route is routeForModel\'s, and the shadowed list is the rest in order', () => {
  const cfg = fixture();
  const routes = normalizeRoutes(cfg.routes);
  const trace = explainRouting(cfg, FABLE);
  assert.equal(trace.route.matched.name, routeForModel(routes, FABLE).name);
  assert.equal(trace.route.matched.index, routeForModel(routes, FABLE).index,
    'first-match position is the whole story, so it comes from the shared predicate');
});

test('a request for an account NAME is called out, with the pin as the remedy', () => {
  // The incident: the id was not a model at all. The candidate table alone looks
  // healthy here — something does serve the request — so the warning is the only
  // thing that tells the operator why they got a 404.
  const cfg = {
    accounts: [oauth('alice'), apikey('deepseek-v4-pro', { upstream: 'http://127.0.0.1:8084' })],
    routes: [{ name: 'default', match: ['*'], accounts: ['alice'] }],
  };
  const trace = explainRouting(cfg, 'deepseek-v4-pro');
  assert.equal(trace.verdict.routable, false);
  const w = trace.warnings.find(x => x.code === 'model-is-account-name');
  assert.ok(w, 'an id that is really an account name must be named as such');
  assert.match(w.message, /teamclaude run --account deepseek-v4-pro/);
  assert.match(formatExplain(trace), /verdict {5}: NOT ROUTABLE/);
});

// ── the launch line ───────────────────────────────────────────
//
// This is the guard that fires on EVERY launch rather than only on a provable
// fault, so its contract is mostly about what it must never do: never throw,
// never claim rules the launch will not run under, never grow past one line.

test('the launch line names route, account, transport and failover depth', () => {
  const line = launchSummary(fixture(), { model: FABLE });
  assert.match(line, /model "claude-fable-5"/);
  assert.match(line, /route "fable"/);
  assert.match(line, /account "alice"/, 'lowest priority value wins');
  assert.match(line, /1 more on failover/, 'fugu stands behind alice; disabled kimi-k3 does not count');
  assert.equal(line.includes('\n'), false, 'one line, always');
});

test('the launch line shows the upstream and the modelMap rewrite for a third-party account', () => {
  // alice and bob removed, so fugu is the only candidate and its rewrite shows.
  const cfg = fixture();
  cfg.routes = [{ name: 'fable', match: ['*fable*'], accounts: ['fugu'] }];
  const line = launchSummary(cfg, { model: FABLE });
  assert.match(line, /account "fugu"/);
  assert.match(line, /http:\/\/127\.0\.0\.1:8083/, 'the real destination, not "the Anthropic API"');
  assert.match(line, /as "fugu-2"/, 'the id the upstream actually receives');
  assert.match(line, /no failover candidate/);
});

test('a pinned launch says PINNED, names the account, and disclaims rotation', () => {
  const line = launchSummary(fixture(), { model: FABLE, accountPin: 'fugu' });
  assert.match(line, /PINNED account "fugu"/);
  assert.match(line, /as "fugu-2"/);
  assert.match(line, /no rotation, no failover/);
  assert.equal(/route "fable"/.test(line), false,
    'a pin bypasses selection, so naming the route would describe rules this launch does not run under');
});

test('a pin that resolves to nothing is reported as a total failure, not as routing', () => {
  const line = launchSummary(fixture(), { model: FABLE, accountPin: 'typo' });
  assert.match(line, /matches NO account/);
  assert.match(line, /404/);
});

test('a direct launch refuses to describe teamclaude routing at all', () => {
  const line = launchSummary(fixture(), { model: FABLE, routingApplies: false });
  assert.match(line, /direct launch/);
  assert.match(line, /routing does not apply/);
  assert.equal(/account "/.test(line), false,
    'the proxy is bypassed, so no account claim is truthful');
});

test('no --model is stated as unknown rather than guessed', () => {
  const line = launchSummary(fixture(), {});
  assert.match(line, /no --model/);
  assert.match(line, /picks its own default/);
  assert.equal(/route "/.test(line), false, 'the client default is not predictable from config');
});

test('a blocked model is reported as blocked, naming the pattern', () => {
  const line = launchSummary(fixture(), { model: 'claude-preview-9' });
  assert.match(line, /BLOCKED/);
  assert.match(line, /\*preview\*/);
});

test('an unroutable id points at explain instead of inventing a destination', () => {
  const cfg = {
    accounts: [oauth('alice'), apikey('deepseek-v4-pro', { upstream: 'http://127.0.0.1:8084' })],
    routes: [{ name: 'default', match: ['*'], accounts: ['alice'] }],
  };
  const line = launchSummary(cfg, { model: 'deepseek-v4-pro' });
  assert.match(line, /NOT ROUTABLE/);
  assert.match(line, /teamclaude explain deepseek-v4-pro/);
});

test('the launch line never throws, whatever the config', () => {
  // It runs on the launch path of every session, so a malformed config must
  // degrade to a useless line, never to a failed launch.
  const junk = [null, undefined, {}, { accounts: null, routes: null },
    { accounts: [{}], routes: [{}] }, { accounts: 'nope', routes: 7 }];
  for (const cfg of junk) {
    for (const opts of [{ model: FABLE }, {}, { model: FABLE, accountPin: 'x' }]) {
      assert.doesNotThrow(() => launchSummary(cfg, opts), `config ${JSON.stringify(cfg)}`);
    }
  }
});

test('the launch line agrees with the full trace about which account serves the request', () => {
  // The line is a summary of the trace, so a disagreement between them would be
  // worse than printing neither — pin them to each other.
  for (const model of [FABLE, OPUS]) {
    const trace = explainRouting(fixture(), model);
    const first = trace.candidates.find(c => !c.disabled);
    assert.match(launchSummary(fixture(), { model }), new RegExp(`account "${first.name}"`),
      `${model}: the line must name the same first candidate as the trace`);
  }
});
