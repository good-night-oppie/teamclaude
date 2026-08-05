// Fleet-agent display-name feature (x-fleet-agent header → TUI activity label).
// Eddie live directive 2026-08-05; teamclaude half of the header-injection design.
// The header is DISPLAY-ONLY: it colors/labels the activity stream and must never
// enter rotation/quota/history logic keyed by sessionId. These tests pin the
// sanitizer's security properties (no control/ANSI chars, no path separators,
// bounded length) and the render-precedence contract (fleet > sid > blank,
// never both).
import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizeFleetAgent } from '../src/server.js';

test('sanitizeFleetAgent: absent/empty/non-string → null', () => {
  assert.strictEqual(sanitizeFleetAgent(undefined), null);
  assert.strictEqual(sanitizeFleetAgent(null), null);
  assert.strictEqual(sanitizeFleetAgent(''), null);
  assert.strictEqual(sanitizeFleetAgent(123), null);
  assert.strictEqual(sanitizeFleetAgent({}), null);
  assert.strictEqual(sanitizeFleetAgent('!@#$%^&*()'), null); // only-illegal → empty → null
});

test('sanitizeFleetAgent: valid fleet names pass unchanged', () => {
  for (const n of ['harness-123', 'tc-fugu-24', 'ai-scientist-26', 'apple-4', 'apple.4_x-1', 'bene']) {
    assert.strictEqual(sanitizeFleetAgent(n), n);
  }
});

test('sanitizeFleetAgent: bounded to 32 chars', () => {
  assert.strictEqual(sanitizeFleetAgent('a'.repeat(50)), 'a'.repeat(32));
});

test('sanitizeFleetAgent: strips whitespace and illegal chars', () => {
  assert.strictEqual(sanitizeFleetAgent('  tc fugu  '), 'tcfugu');
});

test('sanitizeFleetAgent: neutralizes ANSI/control-char injection', () => {
  const out = sanitizeFleetAgent('x\n\x1b[31mRED\x07\x7f');
  assert.ok(!/[\x00-\x1f\x7f]/.test(out), 'no control chars survive');
  assert.ok(!out.includes('\x1b'), 'no ESC');
  assert.ok(!out.includes('['), 'no CSI bracket — an activity line cannot be color-hijacked');
});

test('sanitizeFleetAgent: neutralizes path separators (no traversal into log paths)', () => {
  const out = sanitizeFleetAgent('../../etc/passwd');
  assert.ok(out === null || !out.includes('/'), 'no slash survives');
});

test('sanitizeFleetAgent: comma-joined / array header takes first element', () => {
  assert.strictEqual(sanitizeFleetAgent(['first', 'second']), 'first');
});

// Render-precedence contract mirrored from src/tui.js sessionTag + src/index.js
// headless writer: fleet name wins over sid, sid is the fallback, blank when
// neither — and the two are NEVER concatenated.
test('render precedence: fleet > sid > blank, never both (tui.js sessionTag)', () => {
  const SESSION_ID_LEN = 6, FLEET_TAG_MAX = 16;
  const sessionTag = (sid, fleetAgent) => {
    if (fleetAgent) return fleetAgent.slice(0, FLEET_TAG_MAX).padEnd(SESSION_ID_LEN);
    return sid ? sid.slice(0, SESSION_ID_LEN) : ' '.repeat(SESSION_ID_LEN);
  };
  const withFleet = sessionTag('f10635abcd', 'harness-123');
  assert.strictEqual(withFleet, 'harness-123');
  assert.ok(!withFleet.includes('f10635'), 'sid prefix absent when fleet present');
  assert.strictEqual(sessionTag('f10635abcd', null), 'f10635');
  assert.strictEqual(sessionTag(null, null), ' '.repeat(SESSION_ID_LEN));
  assert.strictEqual(sessionTag('f10635', 'cc'), 'cc    '); // short name padded to align
  assert.strictEqual(sessionTag('f10635', 'x'.repeat(30)), 'x'.repeat(16)); // capped
});

test('render precedence: headless writer falls back to in-flight record (index.js)', () => {
  const render = (info, r) => {
    const fleetAgent = info.fleetAgent || r?.fleetAgent || null;
    return fleetAgent ? `${fleetAgent} ` : (info.sessionId ? `${info.sessionId.slice(0, 6)} ` : '');
  };
  assert.strictEqual(render({ fleetAgent: 'apple-4', sessionId: '380424x' }, null), 'apple-4 ');
  assert.strictEqual(render({ sessionId: '380424x' }, { fleetAgent: 'apple-4' }), 'apple-4 '); // error-path fallback
  assert.strictEqual(render({ sessionId: '380424x' }, null), '380424 ');
  assert.strictEqual(render({}, null), '');
});
