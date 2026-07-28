// Per-session served-family ledger for the rotation compatibility gate (T2).
//
// DOCTRINE: prevention lives here; repair stays fleet-side. NO silent transcript
// mutation. With no account declaring `acceptsHistoryFamilies`, incompatibleIndices
// returns EMPTY — routing is byte-identical to today (ZERO-CONFIG-INERT for
// ROUTING). Marking still runs always so a later opt-in declaration has evidence;
// that rewrites sessionFamilies into the state file every ~60s even while inert
// (state-file cost; "zero config ⇒ zero change" scopes to routing only).
//
// WHY NOT SessionTracker: its SESSION_KNOWN_TTL_MS is 1h (prompt-cache window).
// Transcript poison outlives cache; coupling would silently re-arm detonations.
//
// FAILURE MODES (stated, not solved here):
//   - Ledger loss (state deleted / LRU 20k / 24h TTL / crash between persists)
//     ⇒ unknown session assumed clean ⇒ fail-open.
//   - History poisoned outside teamclaude's sight ⇒ invisible ⇒ fail-open;
//     repair remains fleet-side.
//   - Fork/compaction that mints a NEW x-claude-code-session-id over the SAME
//     poisoned transcript sheds the ledger (dormant on observed fleets) ⇒
//     fail-open residual. Counter `new_session_to_strict_tier` surfaces unexplained
//     new-id traffic to strict tiers. Structural body-scan is future work.
//   - Aborted 2xx stream over-marks (safe direction).
//   - 33rd distinct family: JS `1<<32===1` would alias bit 0 (silent under-block).
//     Overflow is FAIL-CLOSED: overflow families are incompatible with every
//     acceptsHistoryFamilies-declaring account (over-block, never under-block).
//
// Persistence stores FAMILY NAMES (never indices / bit positions). restore()
// re-compacts the intern map from live session names so orphaned rename debris
// does not permanently consume bits.

import { registerBuildFeature } from './build-identity.js';

registerBuildFeature('rotation-gate');

export const ROTATION_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
export const ROTATION_LEDGER_MAX_SESSIONS = 20_000;
export const ROTATION_LEDGER_MAX_FAMILIES = 32;
const SWEEP_INTERVAL_MS = 60 * 1000;

/** Default historyFamily for an account: direct Anthropic ⇒ "anthropic";
 * custom upstream ⇒ account name (over-fragments ⇒ fails SAFE). */
export function defaultHistoryFamily(acct) {
  if (!acct) return 'anthropic';
  if (acct.upstream) return String(acct.name || 'unknown');
  return 'anthropic';
}

export function resolveHistoryFamily(acct) {
  if (acct?.historyFamily != null && String(acct.historyFamily).length) {
    return String(acct.historyFamily);
  }
  return defaultHistoryFamily(acct);
}

export class RotationLedger {
  constructor({
    ttlMs = ROTATION_LEDGER_TTL_MS,
    maxSessions = ROTATION_LEDGER_MAX_SESSIONS,
    now = () => Date.now(),
  } = {}) {
    // sessionId -> { familiesMask: number, overflowFamilies: Set<string>, lastSeen }
    this.sessions = new Map();
    // familyName -> bit index 0..31
    this._familyBits = new Map();
    // Families that could not be interned (33rd+); tracked by name.
    this._overflowFamilies = new Set();
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this._now = now;
    this._lastSweep = 0;
    this.counters = {
      blockedSelections: 0,
      refusals: 0,
      historyResets: 0,
      new_session_to_strict_tier: 0,
      byFamilyPair: Object.create(null),
    };
  }

  /** Intern a family name to a bit. Returns { bit } or { overflow: true }. */
  intern(familyName) {
    const name = String(familyName);
    if (this._overflowFamilies.has(name)) return { overflow: true };
    const existing = this._familyBits.get(name);
    if (existing != null) return { bit: existing };
    if (this._familyBits.size >= ROTATION_LEDGER_MAX_FAMILIES) {
      this._overflowFamilies.add(name);
      return { overflow: true };
    }
    const bit = this._familyBits.size;
    this._familyBits.set(name, bit);
    return { bit };
  }

  familyNameForBit(bit) {
    for (const [name, b] of this._familyBits) {
      if (b === bit) return name;
    }
    return null;
  }

  /** Decode a mask (+ overflow set) to family name list. */
  familiesOf(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    const names = [];
    for (const [name, bit] of this._familyBits) {
      if (s.familiesMask & (1 << bit)) names.push(name);
    }
    if (s.overflowFamilies?.size) {
      for (const n of s.overflowFamilies) names.push(n);
    }
    return names;
  }

  /**
   * Mark that a successful /v1/messages response from `familyName` entered the
   * session's transcript. Always-on (even when the gate is inert) so opt-in
   * declarations later have evidence.
   */
  mark(sessionId, familyName, { isStrictTier = false } = {}) {
    if (!sessionId || familyName == null || familyName === '') return;
    const now = this._now();
    const wasNew = !this.sessions.has(sessionId);
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { familiesMask: 0, overflowFamilies: new Set(), lastSeen: now };
      this.sessions.set(sessionId, s);
    } else {
      // Map insertion-order LRU: re-insert to mark as most-recently used.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, s);
    }
    s.lastSeen = now;

    if (wasNew && isStrictTier) {
      this.counters.new_session_to_strict_tier += 1;
    }

    const interned = this.intern(familyName);
    if (interned.overflow) {
      s.overflowFamilies.add(String(familyName));
    } else {
      s.familiesMask |= (1 << interned.bit);
    }

    if (now - this._lastSweep > SWEEP_INTERVAL_MS) this.sweep(now);
    this._evictIfNeeded();
  }

  clear(sessionId) {
    if (!sessionId) return false;
    const had = this.sessions.delete(sessionId);
    if (had) this.counters.historyResets += 1;
    return had;
  }

  noteBlockedSelection(servedFamilies, blockedAccountName) {
    this.counters.blockedSelections += 1;
    const fam = (servedFamilies && servedFamilies[0]) || '?';
    const key = `${fam}→${blockedAccountName || '?'}`;
    this.counters.byFamilyPair[key] = (this.counters.byFamilyPair[key] || 0) + 1;
  }

  noteRefusal() {
    this.counters.refusals += 1;
  }

  /**
   * Account indices whose declared acceptsHistoryFamilies does NOT cover the
   * session's served families. Accounts WITHOUT acceptsHistoryFamilies are
   * never blocked (tolerant/open = today's behavior). Empty when no account
   * declares (zero-config-inert) or session unknown/clean.
   *
   * mode "off" ⇒ always empty. mode "shadow" ⇒ still computes (caller decides
   * whether to exclude); this method is pure w.r.t. routing.
   */
  incompatibleIndices(sessionId, accounts, mode = 'enforce') {
    const blocked = new Set();
    if (mode === 'off' || !sessionId) return blocked;
    const s = this.sessions.get(sessionId);
    if (!s) return blocked;

    const hasAnyDeclaration = (accounts || []).some(a =>
      Array.isArray(a.acceptsHistoryFamilies));
    if (!hasAnyDeclaration) return blocked;

    const served = this.familiesOf(sessionId);
    const hasOverflow = !!(s.overflowFamilies && s.overflowFamilies.size);
    if (!served.length && !hasOverflow) return blocked;

    for (const a of accounts || []) {
      if (!Array.isArray(a.acceptsHistoryFamilies)) continue;
      // Overflow family: incompatible with EVERY declaring account (fail-closed).
      if (hasOverflow) {
        blocked.add(a.index);
        continue;
      }
      const accepts = new Set(a.acceptsHistoryFamilies.map(String));
      const uncovered = served.some(f => !accepts.has(f));
      if (uncovered) blocked.add(a.index);
    }
    return blocked;
  }

  /**
   * True when selection returned null solely because gate-blocked accounts were
   * the only otherwise-_isAvailable ones (model-scoped). Used for the typed 409.
   */
  gateBlocksAllAvailable(sessionId, accounts, {
    mode = 'enforce',
    isAvailable,
    tried = null,
  } = {}) {
    if (mode !== 'enforce' || !sessionId) return null;
    const blocked = this.incompatibleIndices(sessionId, accounts, mode);
    if (!blocked.size) return null;

    let anyAvailableUnblocked = false;
    let anyAvailableBlocked = false;
    const blockedNames = [];
    for (const a of accounts || []) {
      if (tried?.has(a.index)) continue;
      if (!isAvailable(a)) continue;
      if (blocked.has(a.index)) {
        anyAvailableBlocked = true;
        blockedNames.push(a.name);
      } else {
        anyAvailableUnblocked = true;
      }
    }
    if (anyAvailableUnblocked || !anyAvailableBlocked) return null;
    return {
      families: this.familiesOf(sessionId),
      blockedAccounts: blockedNames,
    };
  }

  sweep(now = this._now()) {
    this._lastSweep = now;
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.ttlMs) this.sessions.delete(id);
    }
  }

  _evictIfNeeded() {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }
  }

  /**
   * Rebuild the intern map from names actually present in live sessions + any
   * currently-declared account families. Drops orphaned rename debris so bits
   * are not permanently consumed across config generations.
   */
  compact(declaredFamilies = []) {
    const needed = new Set();
    for (const name of declaredFamilies) {
      if (name != null && name !== '') needed.add(String(name));
    }
    for (const s of this.sessions.values()) {
      for (const [name, bit] of this._familyBits) {
        if (s.familiesMask & (1 << bit)) needed.add(name);
      }
      if (s.overflowFamilies) {
        for (const n of s.overflowFamilies) needed.add(n);
      }
    }

    // Re-decode every session against the OLD map, then rebuild.
    const decoded = [];
    for (const [id, s] of this.sessions) {
      const names = [];
      for (const [name, bit] of this._familyBits) {
        if (s.familiesMask & (1 << bit)) names.push(name);
      }
      const overflow = s.overflowFamilies ? [...s.overflowFamilies] : [];
      decoded.push({ id, names, overflow, lastSeen: s.lastSeen });
    }

    this._familyBits.clear();
    this._overflowFamilies.clear();
    this.sessions.clear();

    // Prefer declared + previously-live names; intern in stable sorted order
    // so restore is deterministic. Overflow set is rebuilt if >32.
    const ordered = [...needed].sort();
    for (const name of ordered) this.intern(name);

    for (const row of decoded) {
      const entry = {
        familiesMask: 0,
        overflowFamilies: new Set(),
        lastSeen: row.lastSeen,
      };
      for (const name of row.names) {
        const r = this.intern(name);
        if (r.overflow) entry.overflowFamilies.add(name);
        else entry.familiesMask |= (1 << r.bit);
      }
      for (const name of row.overflow) {
        const r = this.intern(name);
        if (r.overflow) entry.overflowFamilies.add(name);
        else entry.familiesMask |= (1 << r.bit);
      }
      this.sessions.set(row.id, entry);
    }
  }

  /** Persist by family NAME (never bit index). */
  export() {
    const out = {};
    for (const [id, s] of this.sessions) {
      const families = [];
      for (const [name, bit] of this._familyBits) {
        if (s.familiesMask & (1 << bit)) families.push(name);
      }
      if (s.overflowFamilies?.size) {
        for (const n of s.overflowFamilies) families.push(n);
      }
      out[id] = { families, lastSeen: s.lastSeen };
    }
    return out;
  }

  /**
   * Restore from export(). Compacts the intern map to only names present in the
   * payload (+ optional declaredFamilies), so orphaned rename names die.
   */
  restore(saved, declaredFamilies = []) {
    this.sessions.clear();
    this._familyBits.clear();
    this._overflowFamilies.clear();
    if (!saved || typeof saved !== 'object') return;

    const rows = [];
    for (const [id, row] of Object.entries(saved)) {
      if (!row || !Array.isArray(row.families)) continue;
      rows.push({
        id,
        families: row.families.map(String),
        lastSeen: Number.isFinite(row.lastSeen) ? row.lastSeen : this._now(),
      });
    }
    // Deterministic intern order: declared first (stable), then appearance order.
    for (const name of declaredFamilies) {
      if (name != null && name !== '') this.intern(String(name));
    }
    for (const row of rows) {
      for (const name of row.families) this.intern(name);
    }
    for (const row of rows) {
      const entry = {
        familiesMask: 0,
        overflowFamilies: new Set(),
        lastSeen: row.lastSeen,
      };
      for (const name of row.families) {
        const r = this.intern(name);
        if (r.overflow) entry.overflowFamilies.add(name);
        else entry.familiesMask |= (1 << r.bit);
      }
      this.sessions.set(row.id, entry);
    }
    // Drop anything past TTL relative to now.
    this.sweep();
  }

  statusSnapshot(mode = 'enforce') {
    return {
      mode,
      blockedSelections: this.counters.blockedSelections,
      refusals: this.counters.refusals,
      historyResets: this.counters.historyResets,
      new_session_to_strict_tier: this.counters.new_session_to_strict_tier,
      byFamilyPair: { ...this.counters.byFamilyPair },
      sessionsTracked: this.sessions.size,
      familiesInterned: this._familyBits.size,
      overflowFamilies: this._overflowFamilies.size,
    };
  }
}
