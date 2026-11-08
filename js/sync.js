// Syncs your data between devices through a secret GitHub Gist on your account.
// Each device stores a GitHub token (gist access only) in its own browser.

import { normalize } from './store.js';

const CFG = 'timekeeper.sync';
const FILE = 'time-keeper-data.json';
const API = 'https://api.github.com';

export class SyncError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let cfg = readCfg();

function readCfg() {
  try { return JSON.parse(localStorage.getItem(CFG)) || null; } catch { return null; }
}
function writeCfg() {
  try {
    if (cfg) localStorage.setItem(CFG, JSON.stringify(cfg));
    else localStorage.removeItem(CFG);
  } catch { /* ignore */ }
}

export const isConfigured = () => !!(cfg?.token && cfg?.gistId);
export const account = () => cfg?.login || null;
export const lastSynced = () => cfg?.lastSynced || null;

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('Can’t reach GitHub. Check your internet connection.', 0);
  }
  if (res.status === 401) throw new SyncError('GitHub didn’t accept the token. It may have expired.', 401);
  if (!res.ok) throw new SyncError(`GitHub returned an error (${res.status}).`, res.status);
  return res;
}

export async function connect(token, localState) {
  const prev = cfg;
  cfg = { token: token.trim() };
  try {
    if (cfg.token.startsWith('github_pat_')) {
      throw new SyncError('That’s a fine-grained token, which can’t use gists. Make a classic token with the “gist” box checked.', 400);
    }
    const userRes = await api('/user');
    const scopes = userRes.headers.get('x-oauth-scopes');
    if (scopes != null && !scopes.split(/,\s*/).includes('gist')) {
      throw new SyncError('This token doesn’t have gist access. Make a classic token with the “gist” box checked.', 403);
    }
    const user = await userRes.json();

    let gistId = null;
    for (let page = 1; page <= 10 && !gistId; page++) {
      const list = await (await api(`/gists?per_page=100&page=${page}`)).json();
      const found = list.find((g) => g.files && g.files[FILE]);
      if (found) gistId = found.id;
      if (list.length < 100) break;
    }
    if (!gistId) {
      const created = await (await api('/gists', {
        method: 'POST',
        body: {
          description: 'Time Keeper data (used by the Time Keeper app)',
          public: false,
          files: { [FILE]: { content: JSON.stringify(localState) } },
        },
      })).json();
      gistId = created.id;
    }
    cfg = { token: cfg.token, gistId, login: user.login, lastSynced: null };
    writeCfg();
  } catch (e) {
    cfg = prev;
    throw e;
  }
}

export function disconnect() {
  cfg = null;
  writeCfg();
}

export async function pull() {
  const gist = await (await api(`/gists/${cfg.gistId}`)).json();
  const file = gist.files?.[FILE];
  if (!file) return null;
  let content = file.content;
  if (file.truncated) content = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
  try { return normalize(JSON.parse(content)); } catch { return null; }
}

export async function push(state) {
  await api(`/gists/${cfg.gistId}`, {
    method: 'PATCH',
    body: { files: { [FILE]: { content: JSON.stringify(state) } } },
  });
}

export function markSynced() {
  if (!cfg) return;
  cfg.lastSynced = Date.now();
  writeCfg();
}

// Combine two copies of the data. For each shift / pay period, the most recently
// changed version wins (deletions are kept as markers so they spread too).
export function merge(a, b) {
  const pick = (x, y) => {
    const m = new Map();
    for (const r of [...x, ...y]) {
      const cur = m.get(r.id);
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) m.set(r.id, r);
    }
    return [...m.values()].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  };
  return {
    shifts: pick(a.shifts, b.shifts),
    payPeriods: pick(a.payPeriods, b.payPeriods),
    settings: (a.settings.updatedAt || 0) >= (b.settings.updatedAt || 0) ? a.settings : b.settings,
  };
}

export const canon = (s) => JSON.stringify(s);
