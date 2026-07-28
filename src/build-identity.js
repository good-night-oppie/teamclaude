// Explicit build identity for fleet G1 assertion via GET /teamclaude/status.
// Identity is for EXTERNAL assertion only — never branch in-process behavior
// on version strings or feature tags.
//
// Feature tags are compile-time constants declared where the features live;
// each layer calls registerBuildFeature() once at module load. The registry is
// additive-only: dropping a module from a build visibly changes the tag set.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
);

/** package.json version of this build — not compared in-process. */
export const BUILD_VERSION = pkg.version;

/** ISO timestamp captured once at process start (module load). */
export const PROCESS_STARTED_AT = new Date().toISOString();

/** Live additive registry of stable feature tags for this process. */
export const BUILD_FEATURE_TAGS = [];

/** Append a stable feature tag once. Unknown/empty tags are ignored. */
export function registerBuildFeature(tag) {
  if (typeof tag !== 'string' || !tag) return;
  if (!BUILD_FEATURE_TAGS.includes(tag)) BUILD_FEATURE_TAGS.push(tag);
}

/** Snapshot for /teamclaude/status `build` field. */
export function buildIdentity() {
  return {
    version: BUILD_VERSION,
    features: [...BUILD_FEATURE_TAGS],
    startedAt: PROCESS_STARTED_AT,
  };
}
