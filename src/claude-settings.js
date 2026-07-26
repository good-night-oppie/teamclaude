// Read Claude Code's own model allowlist — `settings.availableModels` — from the
// settings tiers Claude Code itself reads. READ-ONLY, and structurally so: this
// module exports no writer, and the only value it ever returns from a settings
// file is the `availableModels` string array plus the paths it came from. It
// never returns, logs, or even retains the parsed object, so an API key, an
// OAuth token, an `env` block or an `mcpServers` credential in one of those files
// cannot escape through it. That restraint is the point of the module existing at
// all rather than being three lines inside index.js.
//
// WHY teamclaude needs this at all. A model id that teamclaude can route
// perfectly is still refused by Claude Code BEFORE the request is ever sent, by a
// client-side gate reading these files — and at launch that refusal is advisory:
// the client warns in-band and silently falls back to its default model, never
// writing to stdout or stderr. So the operator sees a session that looks healthy
// running the wrong model. teamclaude cannot fix that gate (it is the client's,
// and the client never asks the proxy for a model list), but it CAN read the same
// files and say so out loud before spawning claude.
//
// Precedence, mirroring the client's own merge (see the tier table below):
// settings arrays UNION across the user/project/local tiers, so a lower tier can
// only ever ADD entries. The managed-policy tier is the exception — when it
// defines availableModels it REPLACES the union wholesale — so it is read first
// and short-circuits.
//
//   policy   /etc/claude-code/managed-settings.json + managed-settings.d/*.json
//   user     ~/.claude/settings.json            (CLAUDE_CONFIG_DIR relocates it)
//   project  <cwd>/.claude/settings.json
//   local    <git-root>/.claude/settings.local.json  (+ <cwd>/… legacy path)
//
// Not modeled here: the plugin-settings base tier (it lives inside installed
// plugin manifests, not a fixed path) and `--settings` (a per-process flag, so
// it is not on disk to read).
//
// Which way that biases the result — stated correctly, because an earlier
// version of this comment had it backwards and the error is load-bearing. Both
// tiers can only ADD entries. Missing them therefore returns a SMALLER allowlist
// than the client will actually apply, which makes a FALSE DENIAL more likely,
// not less. That is precisely why the verdict built on this array is advisory
// and must not block by default: the one error this reader can make is the
// expensive one. `--settings` is recovered at the point where it is knowable —
// model-preflight.js reads it out of the argv being launched and unions it in
// (readFlagSettingsModels) — which leaves the plugin tier as the only remaining
// under-count.
//
// A missing file is not an error; an unparseable one is reported and skipped,
// exactly as Claude Code treats it.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const POLICY_DIR = '/etc/claude-code';

/**
 * The settings files Claude Code would consult on this host, highest-precedence
 * tier first. Pure given its arguments — every path is derived, nothing is read
 * — so a test can point it at a tmpdir instead of the real home.
 */
export function claudeSettingsSources({
  home = homedir(),
  cwd = process.cwd(),
  configDir = process.env.CLAUDE_CONFIG_DIR || null,
  policyDir = POLICY_DIR,
} = {}) {
  const userDir = configDir || join(home, '.claude');
  const sources = [
    { tier: 'policy', path: join(policyDir, 'managed-settings.json') },
  ];
  // The managed-settings.d drop-in directory is merged in sorted order.
  for (const p of dropIns(join(policyDir, 'managed-settings.d'))) {
    sources.push({ tier: 'policy', path: p });
  }
  sources.push(
    { tier: 'user', path: join(userDir, 'settings.json') },
    { tier: 'project', path: join(cwd, '.claude', 'settings.json') },
  );
  const gitRoot = findGitRoot(cwd);
  if (gitRoot && gitRoot !== cwd) {
    sources.push({ tier: 'local', path: join(gitRoot, '.claude', 'settings.local.json') });
  }
  sources.push({ tier: 'local', path: join(cwd, '.claude', 'settings.local.json') });
  return sources;
}

/**
 * The effective `availableModels` allowlist, as Claude Code would compute it.
 *
 * Returns `{ availableModels, sources, errors, policyOverride }`:
 *   availableModels — the merged array, or null when NO tier defines the key.
 *                     null is meaningfully different from []: no key at all
 *                     means the gate admits every model, while an empty array
 *                     means it admits only the tier default.
 *   sources         — every file that contributed, with its entry count.
 *   errors          — files that exist but could not be parsed (reported, not
 *                     thrown: a broken project settings file must not stop a
 *                     launch, and Claude Code skips it too).
 *   policyOverride  — true when a managed-settings tier supplied the array and
 *                     the user/project/local union was therefore discarded.
 *
 * Nothing else from any settings file crosses this boundary.
 */
export function readAvailableModels(opts = {}) {
  const sources = [];
  const errors = [];
  let merged = null;
  let policyOverride = false;

  for (const src of claudeSettingsSources(opts)) {
    if (!existsSync(src.path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(src.path, 'utf8'));
    } catch (err) {
      errors.push({ path: src.path, message: err?.message || 'unreadable' });
      continue;
    }
    const list = parsed && Array.isArray(parsed.availableModels)
      ? parsed.availableModels.filter(m => typeof m === 'string')
      : null;
    if (list === null) continue;
    sources.push({ tier: src.tier, path: src.path, count: list.length });
    if (src.tier === 'policy') {
      // Managed policy replaces the whole array rather than unioning into it,
      // and the first (highest) policy tier that defines it wins outright.
      if (!policyOverride) { merged = [...list]; policyOverride = true; }
      continue;
    }
    if (policyOverride) continue;         // a policy array already settled it
    merged = merged === null ? [...list] : [...new Set([...merged, ...list])];
  }

  return { availableModels: merged, sources, errors, policyOverride };
}

// Walk up from `cwd` looking for a `.git` entry, the way Claude Code locates the
// repo root for the localSettings tier. Returns null outside a repo.
function findGitRoot(cwd) {
  let dir = cwd;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// Sorted *.json drop-ins, or nothing when the directory is absent/unreadable.
function dropIns(dir) {
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => join(dir, f));
  } catch {
    return [];                            // no drop-in dir on this host
  }
}
