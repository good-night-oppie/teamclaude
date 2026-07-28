// A read-only consistency check over the teamclaude config, plus an optional
// cross-check against Claude Code's own model allowlist.
//
// The defects it looks for share one shape: a declaration that LOOKS effective
// and is silently inert. A modelMap key on an account the winning route
// excludes; a `models[]` ownership claim that a catch-all route with an account
// list has already suppressed; a route sitting after a `*` route, where nothing
// can ever reach it; an account NAME that reads like a model id and 404s when
// used as one. None of these produces an error at runtime — the request just
// goes somewhere else, or upstream, and comes back wrong. Nothing in the system
// says a word about any of them today, which is why they accumulate.
//
// Pure and side-effect free: no fs, no fetch, no console, no clock. The caller
// loads the config and reads Claude Code's settings; this module only decides.
// It shares every routing predicate with model-namespace.js — the module the
// router itself delegates to — so a config the doctor calls clean is clean by
// the same rules the request path uses, not by a second opinion.
//
// Exit codes (the reason this is a command and not a paragraph in the README):
// it is meant to run in cron and CI, so the codes distinguish outcomes rather
// than collapsing to the repo's usual 0/1. 0 clean or info-only, 2 warnings,
// 3 errors — and 1 is reserved by the CALLER for "the doctor could not run at
// all" (no config, unreadable JSON, bad usage), so automation can tell a broken
// config from a broken invocation. Documented in `teamclaude help`.
//
// What a clean bill does NOT mean, stated here because the command will be
// trusted: accounts with a custom `upstream` keep their real model namespace in
// another process's configuration, which teamclaude cannot see. The doctor
// checks the parts that are decidable from config, and says so in its output.

import {
  deriveNamespace,
  routabilityOf,
  normalizeRoutes,
  normalizeAccounts,
  accountAllows,
  accountAcceptsModel,
  routeForModel,
  blockedBy,
  clientAllowlistVerdict,
} from './model-namespace.js';

/**
 * Check `config` and return an array of findings, most severe first.
 *
 * opts.availableModels — Claude Code's effective allowlist (from
 *   claude-settings.js), or null/undefined when no settings tier defines one.
 *   Supplying it enables the drift checks; omitting it simply skips them.
 * opts.settingsSources — the files that array came from, so a finding can name
 *   the exact file the operator must edit instead of guessing at one.
 */
export function checkConfig(config, opts = {}) {
  const accounts = normalizeAccounts(config?.accounts);
  const routes = normalizeRoutes(config?.routes);
  const findings = [];
  const add = (severity, code, subject, message, fix = []) =>
    findings.push({ severity, code, subject, message, fix });

  if (!accounts.length) {
    add('error', 'no-accounts', 'accounts',
      'no accounts are configured, so nothing can be routed at all.',
      ['teamclaude login', 'teamclaude import']);
    return sortFindings(findings);
  }

  checkRouteOrder(routes, add);
  checkRouteAccounts(routes, accounts, add);
  checkDeclarationShapes(config, add);
  checkOwnership(config, routes, accounts, add);
  checkModelMaps(config, routes, accounts, add);
  checkCapabilities(config, routes, accounts, opts.availableModels, add);
  checkDynamicPolicy(config, accounts, add);
  checkAccountNamesAsModels(config, accounts, opts.availableModels, add);
  checkAllowlistDrift(config, opts, add);

  return sortFindings(findings);
}

// ── (d) route ordering: everything after a catch-all is dead ──

function checkRouteOrder(routes, add) {
  const at = routes.findIndex(r => r.match.some(g => g === '*'));
  if (at < 0 || at === routes.length - 1) return;
  const dead = routes.slice(at + 1);
  add('error', 'route-after-catchall', `route "${routes[at].name}"`,
    `route "${routes[at].name}" (#${at + 1} of ${routes.length}) matches "*", and the first matching route wins — so `
    + `the ${dead.length} route(s) after it can never fire: ${dead.map(r => `"${r.name}"`).join(', ')}.`,
    [`move "${routes[at].name}" to the end: teamclaude route rm ${routes[at].name} && teamclaude route add ${routes[at].name} --match "*" …`,
      'a catch-all is only ever correct as the last route']);
}

function checkRouteAccounts(routes, accounts, add) {
  const byName = new Map(accounts.map(a => [a.name, a]));
  for (const r of routes) {
    if (!r.accounts.length) continue;
    const resolved = [];
    for (const token of r.accounts) {
      const hit = byName.get(token)
        || (/^\d+$/.test(token) ? accounts[Number(token)] : undefined);
      if (!hit) {
        add('error', 'route-unknown-account', `route "${r.name}"`,
          `route "${r.name}" lists "${token}", which is neither a configured account name nor an in-range index. `
          + 'That token silently shrinks the route\'s eligible set.',
          [`teamclaude route add ${r.name} --match "${r.match.join(',')}" --accounts "<real account names>"`,
            'teamclaude accounts — the valid names']);
        continue;
      }
      resolved.push(hit);
    }
    if (resolved.length && resolved.every(a => a.disabled)) {
      add('error', 'route-accounts-all-disabled', `route "${r.name}"`,
        `every account route "${r.name}" lists is disabled (${resolved.map(a => a.name).join(', ')}), so any id it `
        + 'matches has no eligible account and the proxy answers 429 without contacting an upstream.',
        [`teamclaude enable ${resolved[0].name}`, `or widen route "${r.name}"'s account list`]);
    }
  }
}

// ── malformed declarations that take the proxy down ──

// `models` is documented as a JSON array. Written as a bare string — a plausible
// hand-edit, and the README's own example is an array of strings so the shape is
// easy to get half-right — the REAL router throws on it: `_accountOwnsModel`
// calls `a.models.some(...)` (account-manager.js:622) and `makeAccount` keeps
// whatever the config held (`acct.models || null`), so every request that reaches
// the ownership fallback dies with a TypeError and the client gets the 502
// "Internal proxy error" from server.js:311. That is a total outage, not a
// routing subtlety, and it is invisible to every other check here because the
// oracle's own normalizer coerces the bad value away (deliberately: an oracle
// that throws is useless exactly when the config is broken).
function checkDeclarationShapes(config, add) {
  for (const a of (Array.isArray(config?.accounts) ? config.accounts : [])) {
    const name = a?.name ?? '(unnamed account)';
    if (a?.models === undefined || a?.models === null) continue;
    if (!Array.isArray(a.models)) {
      add('error', 'malformed-models-declaration', name,
        `account "${name}" declares models as ${typeof a.models === 'string' ? `the string "${a.models}"` : `a ${typeof a.models}`}, `
        + 'not an array. The router calls `.some()` on it for every request that reaches the ownership fallback, so '
        + 'this does not merely misroute — it throws, and the proxy answers 502 "Internal proxy error" until the '
        + 'config is fixed.',
        [`write it as an array: "models": ["${typeof a.models === 'string' ? a.models : '<model-id>'}"]`,
          'or remove the field: with no claim anywhere, every account may serve every id']);
      continue;
    }
    const bad = a.models.filter(m => typeof m !== 'string');
    if (bad.length) {
      add('error', 'malformed-models-declaration', name,
        `account "${name}" declares ${bad.length} non-string entry(ies) in models[] (${bad.map(b => JSON.stringify(b)).join(', ')}). `
        + 'The router calls `.replace()` on each entry, so a non-string throws and the proxy answers 502 for every '
        + 'request that reaches the ownership fallback.',
        ['every models[] entry must be a model-id string', 'drop the offending entries']);
    }
  }
}

// ── (a) F7(b): a terminal catch-all WITH accounts kills models[] ──

function checkOwnership(config, routes, accounts, add) {
  const claimers = accounts.filter(a => a.models);

  // NOT gated on a claim already existing. The defect is a property of the ROUTE
  // TABLE, and F7(b) is precisely the case where nobody has written a models[]
  // claim yet: the README documents models[] as the way to give an account its
  // own model ids (its example is literally "deepseek-v4-pro[1m]"), the operator
  // follows it, restarts, and nothing happens — because a catch-all with an
  // account list is exclusive for every id and suppresses ownership everywhere.
  // Learning that only on a SECOND doctor run, after the edit, is learning it
  // too late. Severity is the honest difference between the two states: a config
  // with claims is broken now (warn); one without is a trap laid for the next
  // edit (info — a note, so it neither fails a cron job nor trains skimming).
  const catchAll = routes.find(r => r.match.some(g => g === '*'));
  if (catchAll && catchAll.accounts.length) {
    add(claimers.length ? 'warn' : 'info', 'catchall-shadows-ownership', `route "${catchAll.name}"`,
      `route "${catchAll.name}" matches "*" AND lists accounts, so it is exclusive for EVERY model id — which makes `
      + 'the per-account models[] ownership claim unreachable for every id in this config. '
      + (claimers.length
        ? `${claimers.length} account(s) declare models[] (${claimers.map(a => a.name).join(', ')}) and none of those `
          + 'declarations can ever decide anything. This is the documented mechanism for giving an account its own '
          + 'model ids, and it is inert here by construction, not by accident of any single id.'
        : 'No account declares models[] today, so nothing is broken yet — this is a note about what would happen if '
          + 'one did: the documented mechanism for giving an account its own model ids would silently do nothing.'),
      [`give the claimed ids their own route BEFORE "${catchAll.name}": teamclaude route add <name> --match "<glob>" --accounts "<account>"`,
        `or drop --accounts from "${catchAll.name}" so it stops being exclusive`]);
  }

  // Per-declaration verdicts: inert is one thing, unservable is worse. A claim
  // written with a trailing [Nm] tag also answers the bare id (modelMatches), so
  // both forms are checked — they can hit different routes. The candidate ids are
  // collected per ACCOUNT before the loop, not per declaration: the README's own
  // example lists both "deepseek-v4-pro[1m]" and "deepseek-v4-pro", whose
  // expansions overlap, and emitting the same (account, id) finding twice makes
  // the summary count disagree with the number of real problems.
  for (const a of claimers) {
    const ids = new Set();
    for (const declared of a.models) {
      if (typeof declared !== 'string' || !declared || declared.includes('*')) continue;
      ids.add(declared);
      ids.add(declared.replace(/\[\d+m\]$/, ''));
    }
    for (const id of ids) {
      const block = blockedBy(config?.blockedModels, id);
      if (block) {
        add('warn', 'declared-id-blocked', `${a.name}:${id}`,
          `account "${a.name}" declares "${id}" in models[], but blockedModels pattern "${block}" rejects it with a `
          + '400 before any account is considered.',
          [`remove "${block}" from blockedModels, or drop "${id}" from ${a.name}'s models[]`]);
        continue;
      }
      if (!accountAllows(routes, accounts, a, id)) {
        const r = routeForModel(routes, id);
        add('error', 'models-claim-unreachable', `${a.name}:${id}`,
          `account "${a.name}" declares "${id}" in models[], but ${r ? `route "${r.name}" matches that id first and ` : ''}`
          + `does not allow "${a.name}" — the declaration can never make this account serve this id.`,
          [r ? `add "${a.name}" to route "${r.name}"'s accounts, or insert a more specific route before it`
            : `nothing routes "${id}" to ${a.name}; check the account list of the first matching route`,
          `teamclaude explain ${id}`]);
      }
    }
  }
}

// ── dead modelMap translations ──

function checkModelMaps(config, routes, accounts, add) {
  for (const a of accounts) {
    if (!a.modelMap) continue;
    const dead = [];
    for (const id of Object.keys(a.modelMap)) {
      if (blockedBy(config?.blockedModels, id)) continue;
      if (accountAllows(routes, accounts, a, id)) continue;
      dead.push(id);
    }
    if (!dead.length) continue;
    const r = routeForModel(routes, dead[0]);
    add('error', 'modelmap-key-unreachable', a.name,
      `account "${a.name}" declares ${dead.length} modelMap key(s) it can never be asked for: ${dead.join(', ')}. `
      + `${r ? `Route "${r.name}" matches ${dead.length > 1 ? 'those ids' : 'that id'} first and excludes this account` : 'No route selects this account for them'}`
      + ' — and a modelMap only rewrites the body AFTER an account is chosen, it never makes an account eligible. '
      + 'The translation is dead code.',
      [r ? `add "${a.name}" to route "${r.name}", or add a route matching those ids before it` : `add a route: teamclaude route add ${a.name} --match "<glob>" --accounts "${a.name}"`,
        `teamclaude explain ${dead[0]}`]);
  }
}

// ── closed-provider capability holes ──

function checkCapabilities(config, routes, accounts, availableModels, add) {
  const ids = new Set(Array.isArray(availableModels) ? availableModels.filter(x => typeof x === 'string') : []);
  for (const a of accounts) {
    if (a.modelMap) for (const k of Object.keys(a.modelMap)) ids.add(k);
    if (a.models) for (const m of a.models) if (typeof m === 'string') ids.add(m.replace(/\[\d+m\]$/, ''));
  }
  for (const a of accounts) {
    if (!a.strictModelMap && !a.acceptsModels?.length) continue;
    const holes = [];
    for (const id of ids) {
      if (blockedBy(config?.blockedModels, id)) continue;
      if (!accountAllows(routes, accounts, a, id)) continue;
      if (!accountAcceptsModel(a, id)) holes.push(id);
    }
    if (!holes.length) continue;
    add('error', 'route-capability-hole', a.name,
      `account "${a.name}" is eligible by the route table for ${holes.length} concrete model id(s) that its closed provider capability rejects: ${holes.join(', ')}. `
      + 'Without the capability gate, selection forwards those ids into a non-retryable provider 400 and the fallback chain stops.',
      [`add valid modelMap entries whose targets are in acceptsModels, or remove "${a.name}" from the matching routes`,
        `teamclaude explain ${holes[0]}`]);
  }
}

// ── dynamic ranking activation / evidence ──

function checkDynamicPolicy(config, accounts, add) {
  const mode = config?.routingPolicy?.mode || 'priority-first';
  const priorities = new Set(accounts.map(a => a.priority));
  if (mode === 'priority-first' && priorities.size === accounts.length && accounts.length > 1) {
    add('info', 'dynamic-ranking-inert', 'routingPolicy',
      `all ${accounts.length} accounts have distinct priority values and mode is "priority-first", so reset-time ranking can never decide between two accounts — routing is entirely static priority.`,
      ['set routingPolicy.mode to "shadow" first, observe /teamclaude/status shadowDecisions, then promote to "dynamic"',
        'define costTier as the hard economic boundary; do not use one unique priority per account as a tier']);
  }

  const routes = Array.isArray(config?.routes) ? config.routes : [];
  const declaredCostTiers = accounts.filter(a => Number.isFinite(a.costTier) && a.costTier !== 0);
  const routesWithTiers = routes.filter(r => Array.isArray(r?.tiers) && r.tiers.length > 0);

  // costTier / route tiers only reshape selection in dynamic mode. Declaring
  // them under priority-first (or shadow, which serves legacy) is the same
  // "looks effective, silently inert" class the doctor already owns.
  if (mode !== 'dynamic' && (declaredCostTiers.length || routesWithTiers.length)) {
    const bits = [];
    if (declaredCostTiers.length) {
      bits.push(`${declaredCostTiers.length} account(s) declare a non-zero costTier`);
    }
    if (routesWithTiers.length) {
      bits.push(`${routesWithTiers.length} route(s) declare tiers[]`);
    }
    add('warn', 'cost-tiers-inert', 'routingPolicy',
      `${bits.join(' and ')}, but routingPolicy.mode is "${mode}" — those declarations do not affect which account serves a request until mode is "dynamic".`,
      ['set routingPolicy.mode to "shadow" to observe disagreement without changing traffic, then promote to "dynamic"',
        'or remove unused costTier / route tiers[] so the config matches what the data plane actually does']);
  }

  if (mode === 'dynamic' || mode === 'shadow') {
    const tiers = new Map();
    for (const a of accounts) {
      const n = a.costTier;
      if (!tiers.has(n)) tiers.set(n, []);
      tiers.get(n).push(a.name);
    }
    if ([...tiers.values()].every(xs => xs.length === 1)) {
      add('warn', 'dynamic-singleton-tiers', 'routingPolicy',
        'every costTier contains exactly one account, so dynamic ranking has no choice inside any tier and degenerates to static tier order.',
        ['put economically equivalent accounts in the same costTier',
          'use priority only as the final deterministic tie-break inside a tier']);
    }
  }

  // All-defaults economics under dynamic: every account at costTier 0 and no
  // route tiers[] → ranking reduces to soonest-reset-wins with no hard
  // economic boundary between subscription and metered accounts.
  if (mode === 'dynamic' && accounts.length > 1
      && declaredCostTiers.length === 0 && routesWithTiers.length === 0) {
    add('warn', 'dynamic-all-defaults', 'routingPolicy',
      `routingPolicy.mode is "dynamic" but every account has the default costTier (0) and no route declares tiers[] — ranking has no economic boundary and reduces to soonest-reset-wins across the whole fleet.`,
      ['set costTier (or route tiers[]) so subscription and metered accounts do not share one unbounded tier',
        'run teamclaude rank <model> --json against the persisted quota snapshot before promoting further']);
  }
}

// ── (b) an account name used as a model id ──

// The incident's exact shape. An account NAME is not a model id: asking for it
// reaches whichever account the routing table picks, which is usually not the
// account that bears the name, and the id then egresses verbatim and 404s.
// Reported only when there is EVIDENCE the operator may be treating the name as
// a model id — it appears as a modelMap VALUE (so it genuinely is an upstream
// model id somewhere) or it is listed in Claude Code's allowlist. Without that,
// every account name on a config with an exclusive catch-all would be flagged,
// and a check that fires on every well-formed config teaches operators to ignore it.
function checkAccountNamesAsModels(config, accounts, availableModels, add) {
  const upstreamIds = new Set();
  for (const a of accounts) {
    if (!a.modelMap) continue;
    for (const v of Object.values(a.modelMap)) if (typeof v === 'string') upstreamIds.add(v);
  }
  const allow = new Set(Array.isArray(availableModels) ? availableModels : []);

  for (const a of accounts) {
    const evidence = [];
    if (upstreamIds.has(a.name)) evidence.push('it is a modelMap target elsewhere in this config, so it really is an upstream model id');
    if (allow.has(a.name)) evidence.push('it is listed in Claude Code\'s availableModels');
    if (!evidence.length) continue;
    const r = routabilityOf(config, a.name);

    // A NOMINALLY routable account name is still a trap, and this is the case
    // the check used to skip in silence: the sibling account is listed in the
    // catch-all, so the id "routes" — to the FIRST candidate, which is a
    // different account that has never heard of it. A 404 does not rotate
    // (server.js:794-807 relays any non-429 verbatim), so the later candidate
    // that could have served it is never reached. Report it, one severity down,
    // because the proof is about the first choice rather than about every
    // account.
    if (r.routable) {
      const firstLive = r.candidates.find(c => !c.disabled);
      if (!firstLive || firstLive.name === a.name || firstLive.mappedTo) continue;
      const firstAcct = accounts.find(x => x.name === firstLive.name);
      if (firstAcct?.upstream) continue;              // opaque backend: not provable, do not claim it
      add('warn', 'account-name-first-choice-404', a.name,
        `"${a.name}" is an ACCOUNT name that looks like a model id (${evidence.join('; ')}). Requesting it as a model `
        + `does not reach that account: the rules pick "${firstLive.name}" first, which has no modelMap entry for it `
        + 'and no custom upstream, so the id egresses verbatim to the Anthropic API and 404s — and a 404 never fails '
        + `over, so account "${a.name}" is never tried.`,
        [`to run a session on that account, pin it: teamclaude run --account ${a.name} -- --model <a model id it serves>`,
          'account pinning is what /tc-acct is for; a model id is not an account selector',
          `teamclaude explain ${a.name}`]);
      continue;
    }

    add('warn', 'account-name-not-routable', a.name,
      `"${a.name}" is an ACCOUNT name that looks like a model id (${evidence.join('; ')}), but requesting it as a model `
      + `does not work: ${r.reason}`,
      [`to run a session on that account, pin it: teamclaude run --account ${a.name} -- --model <a model id it serves>`,
        'account pinning is what /tc-acct is for; a model id is not an account selector',
        `teamclaude explain ${a.name}`]);
  }
}

// ── (c) drift between the client allowlist and what we can route ──

function checkAllowlistDrift(config, opts, add) {
  const { availableModels, settingsSources } = opts;
  const where = Array.isArray(settingsSources) && settingsSources.length
    ? settingsSources.map(s => s.path).join(', ')
    : 'the settings file that defines availableModels';

  if (!Array.isArray(availableModels)) {
    add('info', 'no-client-allowlist', 'claude settings',
      'no Claude Code settings tier defines availableModels, so the client gate admits any model id and there is no '
      + 'drift to check. (This check reads those files; it never writes them.)', []);
    return;
  }

  const unroutable = availableModels.filter(id => typeof id === 'string' && !routabilityOf(config, id).routable);
  if (unroutable.length) {
    add('warn', 'allowlist-id-not-routable', 'availableModels',
      `${unroutable.length} id(s) in availableModels cannot be served by this proxy: ${unroutable.join(', ')}. The `
      + 'client would let the request out and teamclaude would then have nowhere to send it.',
      [`drop those ids from availableModels in ${where}, or add routes for them`,
        `teamclaude explain ${unroutable[0]}`]);
  }

  const ns = deriveNamespace(config);
  const vetoed = ns.concrete.filter(id =>
    routabilityOf(config, id).routable && !clientAllowlistVerdict(availableModels, id).allowed);
  if (vetoed.length) {
    add('info', 'routable-id-client-vetoed', 'availableModels',
      `${vetoed.length} id(s) this proxy can route are not admitted by availableModels: ${vetoed.join(', ')}. Asking `
      + 'for one of them at launch is refused inside Claude Code, which then silently falls back to its default model '
      + 'without writing a word to stdout or stderr. Advisory only: this mirrors one client build, and settings tiers '
      + 'teamclaude does not read (plugins, --settings) can only ADD entries.',
      [`add them to availableModels in ${where}`,
        'or launch with --settings \'{"availableModels":[…]}\' — per-process, unions in, writes no file',
        'teamclaude never writes ~/.claude/settings.json']);
  }
}

// ── verdict plumbing ──

const RANK = { error: 0, warn: 1, info: 2 };

function sortFindings(findings) {
  return findings.slice().sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** Count findings by severity — the summary line and the exit code both need it. */
export function summarize(findings) {
  const out = { error: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

/**
 * 0 clean or info-only, 2 warnings, 3 errors. `--strict` promotes warnings to
 * errors. 1 is never returned here: the caller reserves it for "could not run".
 */
export function doctorExitCode(findings, { strict = false } = {}) {
  const n = summarize(findings);
  if (n.error) return 3;
  if (n.warn) return strict ? 3 : 2;
  return 0;
}

/**
 * Render findings for a terminal. Plain text, no ANSI — the output is meant to
 * be pasted into an issue, and colour is the status renderer's job.
 */
export function formatFindings(findings, { strict = false } = {}) {
  const lines = [];
  const label = { error: 'ERROR', warn: 'WARN ', info: 'info ' };
  for (const f of findings) {
    lines.push(`${label[f.severity]} ${f.code}  [${f.subject}]`);
    for (const l of wrap(f.message, 76)) lines.push(`      ${l}`);
    for (const fix of f.fix) {
      const parts = wrap(fix, 72);
      lines.push(`      → ${parts[0]}`);
      for (const p of parts.slice(1)) lines.push(`        ${p}`);
    }
    lines.push('');
  }
  const n = summarize(findings);
  // Notes are not problems: a config carrying only info findings is clean, and
  // must read as clean, or the command stops being worth running.
  if (!n.error && !n.warn) lines.push('No problems found.');
  lines.push(`${n.error} error(s), ${n.warn} warning(s), ${n.info} note(s) — exit ${doctorExitCode(findings, { strict })}`);
  lines.push('Checked from config alone: accounts with a custom `upstream` hold their real model namespace in another');
  lines.push('process, so a clean result is not a promise that every id those backends advertise will work.');
  return lines;
}

// Greedy wrap; never splits a token, so model ids and commands stay intact.
function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const out = [];
  let line = words[0];
  for (const w of words.slice(1)) {
    if (line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line += ` ${w}`;
  }
  out.push(line);
  return out;
}
