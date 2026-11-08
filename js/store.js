// Saves everything in this browser's localStorage.
// Every shift and pay period has an `updatedAt` so copies on different devices can be merged.

const KEY = 'timekeeper.v1';

export function empty() {
  return { shifts: [], payPeriods: [], settings: {} };
}

export function normalize(data) {
  const fix = (r) => (r && typeof r === 'object' && r.id ? { updatedAt: 0, ...r } : null);
  return {
    shifts: Array.isArray(data?.shifts)
      ? data.shifts.map(fix).filter(Boolean).map((s) => (s.deleted ? s : { breaks: [], ...s }))
      : [],
    payPeriods: Array.isArray(data?.payPeriods) ? data.payPeriods.map(fix).filter(Boolean) : [],
    settings: data?.settings && typeof data.settings === 'object' ? data.settings : {},
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) {
    console.error('Could not load data', e);
  }
  return empty();
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Could not save data', e);
  }
}

export const STORAGE_KEY = KEY;

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
