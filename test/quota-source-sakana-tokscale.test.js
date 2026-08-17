import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchSakanaUsage, fetchQuotaFor } from '../src/quota-sources.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

// Faithful subset of the real console.sakana.ai/billing HTML (captured
// 2026-08-03): "5-hour ... 0% used", "Weekly ... 36% used".
const BILLING_FIXTURE =
  '<div class="grid gap-4"><div class="space-y-2">'
  + '<div class="flex items-center justify-between gap-3">'
  + '<p class="font-medium text-sm">5-hour</p>'
  + '<p class="text-muted-foreground text-xs">0% used</p></div>'
  + '<div aria-valuemax="100" aria-valuemin="0" role="progressbar"></div></div>'
  + '<div class="space-y-2"><div class="flex items-center justify-between gap-3">'
  + '<p class="font-medium text-sm">Weekly</p>'
  + '<p class="text-muted-foreground text-xs">36% used</p></div></div>';

const LOGIN_REDIRECT_FIXTURE =
  '<html><body><script>self.__next_f.push([1,"NEXT_REDIRECT;/login;302;"]);</script></body></html>';

const NO_QUOTA_FIXTURE = '<html><body><p>Some other page with no quota values.</p></body></html>';

function fakeRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return JSON.parse(body); },
    async text() { return String(body); },
  };
}

function makeCookieFile(value = 'session-cookie-abc') {
  const dir = mkdtempSync(join(tmpdir(), 'tc-sakana-src-'));
  const file = join(dir, 'sakana-session');
  writeFileSync(file, value);
  return { file, dir };
}

test('fetchSakanaUsage parses the real billing page', async (t) => {
  const { file, dir } = makeCookieFile();
  try {
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
      assert.equal(url, 'https://console.sakana.ai/billing');
      assert.equal(opts.headers['Cookie'], 'session-cookie-abc');   // cookie from cookieFile
      return fakeRes(BILLING_FIXTURE, 200);
    });
    const usage = await fetchSakanaUsage({ type: 'sakana-tokscale', cookieFile: file });
    assert.ok(!usage.error, `unexpected error: ${usage.error}`);
    assert.equal(usage.fiveHour.utilization, 0);       // 0% → 0.00
    assert.equal(usage.sevenDay.utilization, 0.36);    // 36% → 0.36
    assert.equal(usage.fiveHour.resetAt, null);
    assert.equal(usage.sevenDay.resetAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchSakanaUsage reads the cookie from $SAKANA_SESSION_COOKIE (env wins)', async (t) => {
  const prev = process.env.SAKANA_SESSION_COOKIE;
  process.env.SAKANA_SESSION_COOKIE = 'env-cookie-xyz';
  try {
    t.mock.method(globalThis, 'fetch', async (_url, opts) => {
      assert.equal(opts.headers['Cookie'], 'env-cookie-xyz');
      return fakeRes(BILLING_FIXTURE, 200);
    });
    const usage = await fetchSakanaUsage({ type: 'sakana-tokscale' });   // no cookieFile
    assert.ok(!usage.error, `unexpected error: ${usage.error}`);
    assert.equal(usage.sevenDay.utilization, 0.36);
  } finally {
    if (prev === undefined) delete process.env.SAKANA_SESSION_COOKIE;
    else process.env.SAKANA_SESSION_COOKIE = prev;
  }
});

test('sakana probe fails safe on missing cookie', async () => {
  const usage = await fetchSakanaUsage({ type: 'sakana-tokscale' });   // no env, no cookieFile
  assert.match(usage.error, /no session cookie/);
  assert.equal(usage.status, null);
});

test('sakana probe reports auth expiry on a login redirect', async (t) => {
  const { file, dir } = makeCookieFile();
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes(LOGIN_REDIRECT_FIXTURE, 200));
    const usage = await fetchSakanaUsage({ type: 'sakana-tokscale', cookieFile: file });
    assert.match(usage.error, /auth expired/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sakana probe reports layout drift on empty parse without redirect', async (t) => {
  const { file, dir } = makeCookieFile();
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes(NO_QUOTA_FIXTURE, 200));
    const usage = await fetchSakanaUsage({ type: 'sakana-tokscale', cookieFile: file });
    assert.match(usage.error, /layout drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sakana probe fails safe on HTTP 401', async (t) => {
  const { file, dir } = makeCookieFile();
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes('unauthorized', 401));
    const usage = await fetchSakanaUsage({ type: 'sakana-tokscale', cookieFile: file });
    assert.equal(usage.status, 401);
    assert.match(usage.error, /HTTP 401/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchQuotaFor dispatches sakana-tokscale', async (t) => {
  const { file, dir } = makeCookieFile();
  try {
    t.mock.method(globalThis, 'fetch', async () => fakeRes(BILLING_FIXTURE, 200));
    const ok = await fetchQuotaFor({ type: 'sakana-tokscale', cookieFile: file });
    assert.ok(!ok.error, `unexpected error: ${ok.error}`);
    assert.equal(ok.sevenDay.utilization, 0.36);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Prober.probeQuotaSourceAccount applies sakana quota end-to-end', async (t) => {
  const { file, dir } = makeCookieFile();
  try {
    const am = new AccountManager(
      [{ name: 'sakana-fugu', type: 'apikey', apiKey: 'k', quotaSource: { type: 'sakana-tokscale', cookieFile: file } }],
      0.98);
    const prober = new Prober(am, { intervalMs: 0, timeoutMs: 5000, log: () => {} });
    t.mock.method(globalThis, 'fetch', async () => fakeRes(BILLING_FIXTURE, 200));
    await prober.probeQuotaSourceAccount(am.accounts[0]);
    assert.equal(am.accounts[0].quota.unified5h, 0);
    assert.equal(am.accounts[0].quota.unified7d, 0.36);
    const status = prober.getStatus().accounts.find(a => a.name === 'sakana-fugu');
    assert.equal(status.status, 'ok');
    assert.equal(status.type, 'quotaSource');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
