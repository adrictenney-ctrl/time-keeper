// Saves everything in this browser's localStorage.

const KEY = 'timekeeper.v1';

export function empty() {
  return { shifts: [], payPeriods: [], settings: {} };
}

export function normalize(data) {
  return {
    shifts: Array.isArray(data?.shifts) ? data.shifts : [],
    payPeriods: Array.isArray(data?.payPeriods) ? data.payPeriods : [],
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
