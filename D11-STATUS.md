# D11 — PR #1 macroscopeapp thread triage + fixes

**Branch:** `d11-review-threads` (from `da35369`)  
**Fix SHA:** `4cd3a61b70d340cd1807a9a19364ad78f77d0995`  
**Suite:** `764/764` pass (759 baseline + 5 new regressions)  
**Eslint:** green  
**Push:** none (per dispatch)

---

## Thread 1 — HIGH — `NODE_EXTRA_CA_CERTS` over-clear

**Verdict:** CONFIRMED → FIXED

**Evidence (pre-fix):** `directLaunchEnvPlan` gated CA clear on `clear.length` (`src/claude-env.js:124`), so a BASE_URL-only dead-port match also pushed `NODE_EXTRA_CA_CERTS` — a corporate trust bundle was lost on `--auto-fallback`.

**Fix:** Clear `NODE_EXTRA_CA_CERTS` only when a `PROXY_VARS` entry was cleared (MITM leaf rides with the proxy), never on a BASE_URL-only match.

**Regression:** `NODE_EXTRA_CA_CERTS survives when only ANTHROPIC_BASE_URL matched the dead port` in `test/claude-env.test.js`

---

## Thread 2 — HIGH — userinfo URL regex miss

**Verdict:** CONFIRMED → FIXED

**Evidence (pre-fix):** regex was `^https?://(127\.0\.0\.1|localhost|\[::1\]):port` — required host immediately after `://`, so teamclaude's own pinned MITM URL `http://<pin>:<key>@127.0.0.1:<port>` survived auto-fallback clearing.

**Fix:** host match tolerates optional `userinfo@` (`(?:[^/@]+@)?`).

**Regression:** `dead-port match tolerates userinfo URLs (pinned MITM form) and bare host form` in `test/claude-env.test.js` (both URL forms + userinfo BASE_URL).

---

## Thread 3 — MEDIUM — UUID `--account` false "matches NO account"

**Verdict:** CONFIRMED → FIXED

**Evidence (pre-fix):** `src/index.js:923` passed `accountPin?.token` into `launchSummary` → `pinnedRoutabilityOf` → `resolveAccountToken`, which only matches name/index (`normalizeAccounts` drops uuids). Preflight already preferred `accountPin.name` (`model-preflight.js:308`).

**Fix:** launch line passes `accountPin?.name || accountPin?.token`; `launchSummary` accepts a resolved `{ name, token }` object the same way.

**Regression:** `uuid-form account pin produces a truthful launchSummary via resolved identity` in `test/route-explain.test.js`

---

## Thread 4 — MEDIUM — rotation-gate double `onRequestEnd`

**Verdict:** CONFIRMED → FIXED

**Evidence (pre-fix):** gate refusal at `src/server.js:1201` called `hooks.onRequestEnd`, then the request listener `finally` at `:917` called it again → two terminal events per refused request.

**Fix:** drop the inner call; outer lifecycle owns the single terminal event.

**Regression:** `D11: rotation-gate refusal emits exactly one onRequestEnd` in `test/rotation-gate.test.js`

---

## Thread 5 — HIGH — pinned failover rotates into `pinned-unavailable`

**Verdict:** CONFIRMED → FIXED

**Evidence (pre-fix):** three (plus siblings) failover branches ignored `ctx.pinnedIndex`, did `tried.add` + recurse; pinned selection then returned null → client saw 429 `pinned-unavailable` instead of the real upstream failure. Reproduced by the former D8 test (solo custom 500 → 429).

**Branches treated identically (no rotate when pinned):**

1. Custom-upstream 5xx (`~1483`) — relay real status
2. Custom-upstream transport / ECONNREFUSED (`~1852`) — typed 502 with real `err.message` / `err_code`
3. Generic thrown-error rotate (`~1889`) — fall through to typed 502
4. *(same contract)* quota-429-rotate, transient-429-cap, status===`error` rotate

**Regressions:**
- `D8/D11: pinned custom-upstream 5xx relays the real status (not pinned-unavailable)`
- `D11: pinned custom-upstream ECONNREFUSED surfaces real transport error`

in `test/provenance.test.js`

---

## Acceptance checklist

| Thread | Reproduced | Minimal fix | Named regression | Suite+eslint |
|--------|------------|-------------|------------------|--------------|
| T1 CA over-clear | yes `:124` | yes | yes | green |
| T2 userinfo regex | yes `:101` | yes | yes (both forms) | green |
| T3 UUID launch line | yes `:923` | yes | yes | green |
| T4 double onRequestEnd | yes `:1201`+`:917` | yes | yes (exactly 1) | green |
| T5 pinned failover | yes 5xx/ECONNREFUSED/generic | yes | yes | green |

Unrelated diff: none. `data/` left untracked. Branch unpushed.
