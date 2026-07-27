// Offline rank replay: compare legacy vs dynamic selection from config + the
// persisted quota snapshot. No network, no credentials in output, no mutation.

import { AccountManager } from './account-manager.js';

function evidence(am, account, model, now = Date.now()) {
  if (!account) return null;
  const weeklyReset = am._completeWeeklyReset(account, model, now);
  const sessionReset = am._completeSessionReset(account, now);
  const utilization = am._dynamicUtilization(account, model);
  return {
    account: account.name,
    routeTier: am._costTierFor(account, model),
    accountCostTier: account.costTier,
    priority: account.priority || 0,
    weeklyReset: Number.isFinite(weeklyReset) ? weeklyReset : null,
    sessionReset: Number.isFinite(sessionReset) ? sessionReset : null,
    utilization: Number.isFinite(utilization) ? utilization : null,
    status: account.status,
    circuitOpenUntil: account.circuitOpenUntil || null,
    mappedTo: account.modelMap?.[model] || null,
  };
}

export function replayRank(config, savedQuota, model, now = Date.now()) {
  const baseOpts = { routes: config?.routes, distributeSessions: false };
  const legacy = new AccountManager(config?.accounts || [], config?.switchThreshold || 0.98, {
    ...baseOpts, routingPolicy: { mode: 'priority-first' },
  });
  const dynamic = new AccountManager(config?.accounts || [], config?.switchThreshold || 0.98, {
    ...baseOpts, routingPolicy: { ...(config?.routingPolicy || {}), mode: 'dynamic' },
  });
  if (savedQuota) { legacy.restoreQuotaState(savedQuota); dynamic.restoreQuotaState(savedQuota); }
  const oldChoice = legacy._pickBestAvailable(null, model);
  const newChoice = dynamic._pickBestAvailable(null, model);
  const eligible = dynamic.accounts.filter(a => dynamic._isAvailable(a, model));
  eligible.sort((a, b) => dynamic.dynamicCompare(a, b, model, now));
  return {
    model,
    changed: oldChoice?.index !== newChoice?.index,
    legacy: evidence(legacy, oldChoice, model, now),
    dynamic: evidence(dynamic, newChoice, model, now),
    candidates: eligible.map(a => evidence(dynamic, a, model, now)),
  };
}

export function formatRankReplay(r) {
  const fmtReset = value => value == null ? 'unknown' : `${Math.max(0, (value - Date.now()) / 3600000).toFixed(1)}h`;
  const one = (label, e) => e
    ? `${label.padEnd(8)} ${e.account}  routeTier=${e.routeTier}  weekly=${fmtReset(e.weeklyReset)}  session=${fmtReset(e.sessionReset)}  util=${e.utilization == null ? 'unknown' : (e.utilization * 100).toFixed(1) + '%'}  prio=${e.priority}${e.mappedTo ? `  model→${e.mappedTo}` : ''}`
    : `${label.padEnd(8)} (none)`;
  return [
    `model: ${r.model}`,
    one('legacy', r.legacy),
    one('dynamic', r.dynamic),
    `decision: ${r.changed ? 'CHANGED (shadow candidate)' : 'same'}`,
    'dynamic candidates:',
    ...r.candidates.map((c, i) => `  ${i + 1}. ${c.account}  tier=${c.routeTier} weekly=${fmtReset(c.weeklyReset)} session=${fmtReset(c.sessionReset)} util=${c.utilization == null ? 'unknown' : (c.utilization * 100).toFixed(1) + '%'} prio=${c.priority}`),
  ].join('\n');
}
