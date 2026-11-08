// Time and date helpers. Dates are "YYYY-MM-DD" keys in local time; times are "HH:MM".

const pad = (n) => String(n).padStart(2, '0');

export function dateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d.getTime());
}

export function timeStr(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function addMinutes(time, n) {
  const [h, m] = time.split(':').map(Number);
  const total = (((h * 60 + m + n) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function combine(key, time) {
  const d = parseKey(key);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// The first moment at `time` on `key` or a later day that is at/after `ref`.
// Lets shifts and breaks cross midnight (e.g. 10 PM to 2 AM).
export function resolveAfter(key, time, ref, strict = false) {
  let k = key;
  let ms = combine(k, time);
  for (let i = 0; i < 3 && (strict ? ms <= ref : ms < ref); i++) {
    k = addDays(k, 1);
    ms = combine(k, time);
  }
  return ms;
}

export function breakMs(shift, now = Date.now()) {
  return shift.breaks.reduce((t, b) => t + ((b.end ?? now) - b.start), 0);
}

export function workedMs(shift, now = Date.now()) {
  return Math.max(0, (shift.end ?? now) - shift.start - breakMs(shift, now));
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export function fmtDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDate(key, { weekday = true } = {}) {
  const d = parseKey(key);
  const opts = { month: 'short', day: 'numeric' };
  if (weekday) opts.weekday = 'short';
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}
