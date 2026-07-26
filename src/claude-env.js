// Build the shell `export` lines that point Claude Code — or any tool that
// spawns it, e.g. an agent multiplexer — at the proxy. This is the same
// environment `teamclaude run` sets up, but emitted for `eval "$(teamclaude
// env)"` instead of launching claude directly. Pure and side-effect free so it
// can be unit-tested; the caller resolves the port, cert path, and holdSeconds.
//
// MITM (forward-proxy) mode is the default, matching `teamclaude run`: it routes
// ALL of claude's traffic through the proxy — even hardcoded api.anthropic.com
// endpoints (e.g. the design MCP) — with claude trusting our leaf via
// NODE_EXTRA_CA_CERTS. base-URL mode only redirects the Anthropic base URL and
// leaves other hosts alone.
//
// No ANTHROPIC_API_KEY is emitted: loopback clients are exempt from the proxy's
// key gate, and setting it would drop Claude Code out of subscription mode (and
// its full model access). Remote clients that aren't on loopback must add the
// proxy key themselves.
//
// ── Account pinning ─────────────────────────────────────────
//
// `/tc-acct/<name-or-index>` already forces a request onto exactly one account
// and never fails over to another (`resolveAccountPin` and the pin branch in
// server.js; keep-warm uses it in warmer.js `_spawnSpec`). But it is expressed
// as an ANTHROPIC_BASE_URL *path prefix*, and MITM mode has always ended by
// clearing that variable — so the only mechanism teamclaude has for saying "run
// this whole session on THAT account" was reachable only via --no-mitm or a
// hand-rolled env, which is why nobody uses it. `accountPin` closes that gap:
// the base-URL line comes back carrying the pin, in whichever mode was asked
// for, and the `unset` is dropped because it would immediately undo the pin.
//
// WHY A PIN COEXISTS WITH MITM RATHER THAN FORCING BASE-URL MODE. When both are
// emitted, claude's Anthropic traffic follows ANTHROPIC_BASE_URL to
// http://127.0.0.1:<port>/tc-acct/<pin>, and NO_PROXY — which we emit, and which
// already lists 127.0.0.1 — exempts that host from HTTPS_PROXY/HTTP_PROXY. So
// the pinned request is made *directly* to the listener in origin form (`POST
// /tc-acct/<pin>/v1/messages`), which is precisely the shape the pin branch
// matches. The proxy variables are inert for that hop; they do not compete with
// it. Meanwhile every OTHER host — the hardcoded https://api.anthropic.com of an
// MCP server, say — still traverses the forward proxy and is still intercepted.
// Dropping the MITM lines "for simplicity" would silently trade that
// interception away as a side effect of asking for a pin: those callers would go
// straight to Anthropic on the user's own credential, neither pinned nor
// proxied. Coexistence is strictly the larger coverage, so it wins.
//
// The two remaining interactions were checked rather than assumed.
// NODE_EXTRA_CA_CERTS is a TLS trust anchor only; a plain-http loopback base URL
// never consults it, so there is nothing to interact with. And a client that
// ignored NO_PROXY would fail loudly-correctly rather than silently: it would
// send us the absolute-form `POST http://127.0.0.1:<port>/tc-acct/<pin>/...`,
// which `relayHttpForward` blind-relays back to that same loopback address; the
// second hop arrives in origin form and hits the pin branch. One wasted hop,
// same account, same answer.
//
// The tradeoff we are accepting, stated plainly: traffic captured by the MITM
// (as opposed to sent to the base URL) carries no `/tc-acct` prefix, so it still
// rotates normally. A pin governs the launched session, not every process in the
// shell. That is the honest scope of a base-URL pin, and keeping MITM on does
// not worsen it — without MITM those requests would not reach us at all.
//
// The pinned URL uses 127.0.0.1, not `localhost` like the unpinned base-URL
// line: the server binds 127.0.0.1 by default, `localhost` can resolve to ::1
// first on a dual-stack host, and warmer.js already builds its pin the same way.
export function buildClaudeEnvLines({ port, useMitm = true, caPath = null, holdSeconds = 0, accountPin = null }) {
  const lines = [];
  const pinnedBaseUrl = accountPinBaseUrl(port, accountPin);

  if (useMitm) {
    const proxyUrl = `http://127.0.0.1:${port}`;
    lines.push(
      `export HTTPS_PROXY=${proxyUrl}`,
      `export HTTP_PROXY=${proxyUrl}`,
      `export https_proxy=${proxyUrl}`,
      `export http_proxy=${proxyUrl}`,
      'export NO_PROXY=localhost,127.0.0.1,::1',
      'export no_proxy=localhost,127.0.0.1,::1',
    );
    if (caPath) lines.push(`export NODE_EXTRA_CA_CERTS=${caPath}`);
    // Clear any stale base-URL so the two modes don't stack in one shell —
    // unless a pin needs it, in which case clearing it would undo the pin.
    if (pinnedBaseUrl) lines.push(`export ANTHROPIC_BASE_URL='${pinnedBaseUrl}'`);
    else lines.push('unset ANTHROPIC_BASE_URL');
  } else if (pinnedBaseUrl) {
    lines.push(`export ANTHROPIC_BASE_URL='${pinnedBaseUrl}'`);
  } else {
    lines.push(`export ANTHROPIC_BASE_URL=http://localhost:${port}`);
  }

  // Parity with `run`: if the proxy may hold the connection on exhaustion, raise
  // the client-side timeout so it doesn't give up mid-hold.
  const holdMs = (holdSeconds || 0) * 1000;
  if (holdMs > 0) lines.push(`export API_TIMEOUT_MS=${holdMs + 60_000}`);

  return lines;
}

/** The `/tc-acct/<name-or-index>` base URL that pins every request onto one
 *  account, or null when there is no pin. Exported so the CLI can build the same
 *  URL (for `run`'s spawn env, and to echo it) without restating the string. */
export function accountPinBaseUrl(port, accountPin) {
  const pin = accountPin == null ? '' : String(accountPin);
  if (!pin) return null;
  return `http://127.0.0.1:${port}/tc-acct/${encodePinToken(pin)}`;
}

// Percent-encode an account name for the `/tc-acct/<token>` path segment. The
// name is user input on its way into a shell `export` line that a caller will
// `eval`, so it gets two independent layers.
//
// First: encodeURIComponent is necessary but NOT sufficient. It leaves !'()*
// untouched, and real account names carry exactly those — the README's own
// example is "work (Acme)". Unquoted, `(` `)` are a bash syntax error, `'` opens
// a quote, `!` is history expansion and `*` is a glob. Escaping them too reduces
// the token to the RFC 3986 unreserved set (A-Za-z0-9-_.~) plus `%`, which holds
// nothing the shell will chew on. It also guarantees the token contains no `/`,
// so it cannot split the path and shift the pin onto some other segment; the
// server's decodeURIComponent puts the original name back.
//
// Second: the value is single-quoted at the call site anyway. After the encoding
// above that is redundant by construction — which is the point. It stays correct
// if someone later loosens the encoder, and it costs nothing since eval strips
// the quotes. The other export lines stay unquoted because none of them
// interpolate user input.
//
// A whitespace-only pin is deliberately NOT treated as "no pin": it encodes to a
// token the server answers with a 404, and a loud 404 beats silently launching
// an unpinned session that the user believed was pinned.
function encodePinToken(name) {
  return encodeURIComponent(name)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// ── direct-launch environment hygiene ───────────────────────

// Proxy variables a parent shell may already carry. Set as a group by `run`'s
// MITM branch and by `teamclaude env`, so they are also inherited as a group.
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];

/**
 * What a DIRECT launch must do about proxy variables it inherited.
 *
 * `--auto-fallback` promises to launch claude "directly, bypassing the proxy"
 * when the proxy is down — but the child inherits the parent's environment, and
 * the parent shell of a teamclaude session is usually one teamclaude itself set
 * up. So the traffic goes right back through a proxy, and the promise is broken
 * in one of two ways: the variable points at the port we JUST found dead, and
 * every request fails; or it points at some OTHER live proxy, and the session
 * silently runs somewhere the operator was told it would not. The second is the
 * worse one — a wrong destination reported as no destination.
 *
 * The rule is deliberately narrow. Clear only what is provably ours and provably
 * dead: a proxy variable pointing at loopback on the very port whose liveness we
 * just probed and lost. Anything else — a corporate egress proxy, a different
 * live teamclaude — is someone's deliberate configuration and is NOT deleted
 * behind their back; it is returned in `remaining` so the caller can qualify its
 * "direct launch" claim instead of lying about it. Reporting what we will not
 * touch is the same discipline splitRunArgs applies to misplaced flags.
 *
 * ANTHROPIC_BASE_URL is cleared unconditionally when it points at that dead
 * port: unlike the proxy vars it has exactly one meaning here, and leaving it
 * would send every request to a closed socket.
 *
 * Pure: takes an env object, returns a plan, mutates nothing.
 */
export function directLaunchEnvPlan(env, port) {
  const source = env && typeof env === 'object' ? env : {};
  const ours = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${Number(port)}(/|$)`, 'i');

  // `remaining` is grouped BY VALUE, not listed per variable. The four proxy
  // vars are conventionally set as one group to one URL — teamclaude's own MITM
  // branch does exactly that — so reporting them individually turns a single
  // fact into four near-identical lines and buries it. One destination, one row.
  const clear = [];
  const byValue = new Map();
  for (const name of PROXY_VARS) {
    const value = source[name];
    if (typeof value !== 'string' || !value) continue;
    if (ours.test(value)) { clear.push(name); continue; }
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(name);
  }
  const remaining = [...byValue.entries()].map(([value, names]) => ({ names, value }));

  const base = source.ANTHROPIC_BASE_URL;
  if (typeof base === 'string' && ours.test(base)) clear.push('ANTHROPIC_BASE_URL');

  // Our MITM leaf is worthless to a direct launch and only matters alongside a
  // proxy we are clearing; drop it with them rather than leaving a dangling
  // trust anchor, but only when we actually cleared a proxy var.
  if (clear.length && typeof source.NODE_EXTRA_CA_CERTS === 'string' && source.NODE_EXTRA_CA_CERTS) {
    clear.push('NODE_EXTRA_CA_CERTS');
  }

  return { clear, remaining };
}
