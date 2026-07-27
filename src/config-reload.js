// Hot-reload account state without importing the executable CLI entry point.
//
// Pure with respect to process lifecycle: no command dispatch, no server bind, no
// globals. Credential import is injected by the CLI caller; tests can omit it.
// The function mutates the deliberately supplied memConfig + AccountManager,
// which is its contract — both must move together or a later TUI save restores
// stale startup policy over a successful disk reload.

import { sameIdentity } from './identity.js';

function findConfigAccount(config, account) {
  if (!Array.isArray(config?.accounts)) return -1;
  return config.accounts.findIndex(a => sameIdentity(a, account));
}

export async function syncAccountsFromDisk(diskConfig, memConfig, accountManager, {
  importCredentials = null,
  log = console.log,
  warn = console.error,
} = {}) {
  let added = 0;
  const claimed = new Set();
  const claim = (diskAcct) => {
    for (let i = 0; i < accountManager.accounts.length; i++) {
      if (!claimed.has(i) && sameIdentity(accountManager.accounts[i], diskAcct)) {
        claimed.add(i);
        return i;
      }
    }
    return -1;
  };

  for (const diskAcct of (Array.isArray(diskConfig?.accounts) ? diskConfig.accounts : [])) {
    const mgrIdx = claim(diskAcct);
    if (mgrIdx < 0) {
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      claimed.add(accountManager.accounts.length - 1);
      added++;
      log(`[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    const mgr = accountManager.accounts[mgrIdx];
    if (diskAcct.orgUuid && !mgr.orgUuid) mgr.orgUuid = diskAcct.orgUuid;
    if (diskAcct.orgName && !mgr.orgName) mgr.orgName = diskAcct.orgName;
    if (diskAcct.name && mgr.name !== diskAcct.name) mgr.name = diskAcct.name;
    const policyChanged = accountManager.updateAccountPolicy(mgr.index, diskAcct);
    const memIdx = findConfigAccount(memConfig, mgr);
    if (memIdx >= 0) memConfig.accounts[memIdx] = { ...memConfig.accounts[memIdx], ...diskAcct };
    if (policyChanged.length) log(`[TeamClaude] Reloaded policy for "${mgr.name}": ${policyChanged.join(', ')}`);

    const wantDisabled = !!diskAcct.disabled;
    if (mgr.disabled !== wantDisabled) accountManager.setDisabled(mgr.index, wantDisabled);

    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom && importCredentials) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (err) {
        warn(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }
    if (!freshCred) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken || mgr.refreshToken !== freshCred.refreshToken;
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt && freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}
