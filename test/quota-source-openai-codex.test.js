import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCodexUsage, fetchQuotaFor } from '../src/quota-sources.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

// Real /wham/usage payload captured 2026-08-03 (yongbing codex account).
const WHAM_FIXTURE = {
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 26,
      limit_window_seconds: 604800,
      reset_after_seconds: 428108,
      reset_at: 1786160027,
    },
    secondary_window: null,
  },
  plan_type: 'pro',
  additional_rate_limits: [],
};

function fakeRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(body); },
    async text() { return String(body); },
  };
}

// CLIProxyAPI codex auth file shape (real: top-level access_token + account_id).
function makeCodexTokenFile() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-codex-src-'));
  const file = join(dir, 'codex-test.json');
  writeFileSync(file, JSON.stringify({ access_token: 'test-codex-token', account_id: 'acc-123' }));
  return { file, dir };
}

function wham(usedPercent, { with5h = false } = {}) {
  const rl = {
    primary_window: { used_percent: usedPercent, limit_window_seconds: 604800, reset_at: 1786160027 },
    secondary_window: null,
  };
  if (with5h) rl.secondary_window = { used_percent: 40, limit_window_seconds: 18000, reset_at: 1786168000 };
  return { rate_limit: rl, plan_type: 'pro', additional_rate_limits: [] };
}

test('fetchCodexUsage parses the real wham/usage weekly window', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes(JSON.stringify(WHAM_FIXTURE), 200));
    const usage = await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, { switchThreshold: 0.98 });
    assert.ok(!usage.error, `unexpected error: ${usage.error}`);
    assert.equal(Math.round(usage.sevenDay.utilization * 100) / 100, 0.26);   // 26%
    assert.equal(usage.sevenDay.resetAt, 1786160027 * 1000);                  // seconds → ms
    assert.equal(usage.fiveHour, null);    // fresh history → synthetic 5h not yet available
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex synthetic 5h builds from history and respects the cap', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  let nowMs = Date.parse('2026-08-02T00:00:00Z');
  let call = 0;
  const pct = [26, 30];   // utilization climbs hard over 20 min
  try {
    t.mock.method(Date, 'now', () => nowMs);
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(wham(pct[Math.min(call++, pct.length - 1)])), 200));
    const src = { type: 'openai-codex', tokenFile: file };

    const u1 = await fetchCodexUsage(src, { switchThreshold: 0.98 });
    assert.equal(u1.fiveHour, null);                 // <15min history

    nowMs += 20 * 60 * 1000;                          // +20 min
    const u2 = await fetchCodexUsage(src, { switchThreshold: 0.98 });
    // pace = (0.30-0.26) / (1200/604800) = 20.16 → clamped to
    // min(switchThreshold-0.02, 0.95) = min(0.96, 0.95) = 0.95 (ceiling dominates)
    assert.equal(u2.fiveHour.utilization, 0.95);
    assert.equal(u2.fiveHour.resetAt, null);
    assert.equal(u2.sevenDay.utilization, 0.30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex synthetic 5h computes a sub-cap pace', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  let nowMs = Date.parse('2026-08-02T00:00:00Z');
  let call = 0;
  const pct = [26, 26.1];   // gentle climb over 30 min
  try {
    t.mock.method(Date, 'now', () => nowMs);
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(wham(pct[Math.min(call++, pct.length - 1)])), 200));
    const src = { type: 'openai-codex', tokenFile: file };

    await fetchCodexUsage(src, { switchThreshold: 0.98 });   // seed sample
    nowMs += 30 * 60 * 1000;                                  // +30 min
    const u2 = await fetchCodexUsage(src, { switchThreshold: 0.98 });
    // pace = (0.261-0.26)/(1800/604800) = 0.336 — below cap, kept as-is
    assert.equal(Math.round(u2.fiveHour.utilization * 1000) / 1000, 0.336);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex synthetic 5h discards pre-reset samples', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  let nowMs = Date.parse('2026-08-02T00:00:00Z');
  let call = 0;
  const pct = [26, 30, 10];   // weekly reset drops utilization back to 10%
  try {
    t.mock.method(Date, 'now', () => nowMs);
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(wham(pct[Math.min(call++, pct.length - 1)])), 200));
    const src = { type: 'openai-codex', tokenFile: file };

    await fetchCodexUsage(src, { switchThreshold: 0.98 });
    nowMs += 20 * 60 * 1000;
    await fetchCodexUsage(src, { switchThreshold: 0.98 });   // climbs to 30%
    nowMs += 20 * 60 * 1000;
    const u3 = await fetchCodexUsage(src, { switchThreshold: 0.98 });   // reset to 10%
    assert.equal(u3.sevenDay.utilization, 0.10);
    assert.equal(u3.fiveHour, null);    // pre-reset samples discarded → no old sample
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real secondary_window takes precedence over the synthetic 5h', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(wham(26, { with5h: true })), 200));
    const usage = await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, { switchThreshold: 0.98 });
    assert.equal(usage.fiveHour.utilization, 0.40);
    assert.equal(usage.fiveHour.resetAt, 1786168000 * 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex probe sends Bearer + chatgpt-account-id headers', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  let captured = null;
  try {
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
      captured = { url, headers: opts?.headers };
      return fakeRes(JSON.stringify(WHAM_FIXTURE), 200);
    });
    await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, {});
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(captured.headers['Authorization'], 'Bearer test-codex-token');
    assert.equal(captured.headers['chatgpt-account-id'], 'acc-123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex probe fails safe on missing token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-codex-src-'));
  const file = join(dir, 'empty.json');
  writeFileSync(file, JSON.stringify({ refresh_token: 'x' }));   // no access_token
  try {
    const usage = await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, {});
    assert.match(usage.error, /no access_token/);
    assert.equal(usage.status, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex probe fails safe on HTTP 401', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify({ error: { message: 'unauthorized' } }), 401));
    const usage = await fetchCodexUsage({ type: 'openai-codex', tokenFile: file }, {});
    assert.equal(usage.status, 401);
    assert.match(usage.error, /HTTP 401/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchQuotaFor dispatches openai-codex', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes(JSON.stringify(WHAM_FIXTURE), 200));
    const ok = await fetchQuotaFor({ type: 'openai-codex', tokenFile: file }, { switchThreshold: 0.98 });
    assert.ok(!ok.error, `unexpected error: ${ok.error}`);
    assert.equal(Math.round(ok.sevenDay.utilization * 100) / 100, 0.26);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Prober.probeQuotaSourceAccount applies codex quota with the real switchThreshold', async (t) => {
  const { file, dir } = makeCodexTokenFile();
  let nowMs = Date.parse('2026-08-02T00:00:00Z');
  let call = 0;
  const pct = [26, 30];
  try {
    // switchThreshold 0.50 → synthetic cap = min(0.48, 0.95) = 0.48. If the cap
    // instead used the default 0.97 it would be 0.95 — so 0.48 proves the
    // accountManager's real switchThreshold reached the synthetic 5h.
    const am = new AccountManager(
      [{ name: 'codex-gpt56', type: 'apikey', apiKey: 'k', quotaSource: { type: 'openai-codex', tokenFile: file } }],
      0.50);
    const prober = new Prober(am, { intervalMs: 0, timeoutMs: 5000, log: () => {} });
    t.mock.method(Date, 'now', () => nowMs);
    t.mock.method(globalThis, 'fetch', async () =>
      fakeRes(JSON.stringify(wham(pct[Math.min(call++, pct.length - 1)])), 200));

    await prober.probeQuotaSourceAccount(am.accounts[0]);
    assert.equal(Math.round(am.accounts[0].quota.unified7d * 100) / 100, 0.26);

    nowMs += 20 * 60 * 1000;
    await prober.probeQuotaSourceAccount(am.accounts[0]);
    assert.equal(am.accounts[0].quota.unified5h, 0.48);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
