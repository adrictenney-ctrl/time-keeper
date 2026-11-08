import { load, save, uid, normalize, STORAGE_KEY } from './store.js';
import * as T from './time.js';

let state = load();
let tab = 'clock';

const $view = document.getElementById('view');
const $sheetRoot = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const persist = () => save(state);
const todayKey = () => T.dateKey(Date.now());

export function haptic(pattern = 10) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

/* ---------- state helpers ---------- */

function activeShift() {
  return state.shifts.find((s) => s.end == null) || null;
}

function openBreak(s) {
  const b = s?.breaks[s.breaks.length - 1];
  return b && b.end == null ? b : null;
}

function status() {
  const s = activeShift();
  if (!s) return 'idle';
  return openBreak(s) ? 'break' : 'working';
}

function paidIds() {
  return new Set(state.payPeriods.flatMap((p) => p.shiftIds || []));
}

function sumWorked(list, now = Date.now()) {
  return list.reduce((t, s) => t + T.workedMs(s, now), 0);
}

function lastPeriod() {
  return [...state.payPeriods].sort((a, b) => b.to.localeCompare(a.to))[0] || null;
}

// The range a new pay period covers by default: the day after the last saved
// period (or the first shift ever) through today.
function defaultRange() {
  const today = todayKey();
  const lp = lastPeriod();
  let from;
  if (lp) {
    from = T.addDays(lp.to, 1);
  } else if (state.shifts.length) {
    from = T.dateKey(Math.min(...state.shifts.map((s) => s.start)));
  } else {
    from = T.addDays(today, -13);
  }
  if (from > today) from = today;
  return { from, to: today };
}

function shiftsInRange(from, to, { includeActive = false } = {}) {
  return state.shifts.filter((s) => {
    if (!includeActive && s.end == null) return false;
    const k = T.dateKey(s.start);
    return k >= from && k <= to;
  });
}

/* ---------- clock actions ---------- */

function startShift() {
  if (activeShift()) return;
  state.shifts.push({ id: uid(), start: Date.now(), end: null, breaks: [] });
  persist();
  haptic(25);
  render();
}

function pauseShift() {
  const s = activeShift();
  if (!s || openBreak(s)) return;
  s.breaks.push({ start: Date.now(), end: null });
  persist();
  haptic(15);
  render();
}

function resumeShift() {
  const b = openBreak(activeShift());
  if (!b) return;
  b.end = Date.now();
  persist();
  haptic(15);
  render();
}

async function endShift() {
  const s = activeShift();
  if (!s) return;
  const ok = await confirmSheet({
    title: 'End your shift?',
    message: `You've worked ${T.fmtDuration(T.workedMs(s))} so far.`,
    okText: 'End shift',
    danger: true,
  });
  if (!ok) return;
  const now = Date.now();
  const b = openBreak(s);
  if (b) b.end = now;
  s.end = now;
  persist();
  haptic([20, 60, 20]);
  render();
  toast(`Shift saved · ${T.fmtDuration(T.workedMs(s))}`);
}

/* ---------- rendering ---------- */

function render() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'clock') renderClock();
  else if (tab === 'history') renderHistory();
  else renderPay();
}

function setText(sel, text) {
  const el = $view.querySelector(sel);
  if (el && el.textContent !== text) el.textContent = text;
}

function renderClock() {
  const st = status();
  const label = { idle: 'Off the clock', working: 'Working', break: 'On break' }[st];
  let actions;
  if (st === 'idle') {
    actions = `<button class="btn btn-primary btn-xl" data-act="start">Start shift</button>`;
  } else {
    actions = `
      ${st === 'working'
        ? `<button class="btn btn-warn btn-lg" data-act="pause">Pause</button>`
        : `<button class="btn btn-primary btn-lg" data-act="resume">Resume</button>`}
      <button class="btn btn-danger btn-lg" data-act="end">End shift</button>`;
  }

  $view.innerHTML = `
    <section class="clock clock-${st}">
      <div class="status"><span class="dot"></span>${label}</div>
      <div class="timer" id="timer">00:00:00</div>
      <div class="timer-sub" id="timer-sub"></div>
      <div class="actions">${actions}</div>
    </section>
    <section class="stats">
      <div class="stat">
        <div class="stat-label">Today</div>
        <div class="stat-value" id="stat-today">0m</div>
      </div>
      <div class="stat">
        <div class="stat-label">Unpaid hours</div>
        <div class="stat-value" id="stat-period">0m</div>
        <div class="stat-foot">since ${T.fmtDate(defaultRange().from)}</div>
      </div>
    </section>`;

  const fns = { start: startShift, pause: pauseShift, resume: resumeShift, end: endShift };
  $view.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', () => fns[b.dataset.act]()));
  updateClock();
}

function updateClock() {
  if (tab !== 'clock') return;
  const now = Date.now();
  const s = activeShift();
  setText('#timer', T.fmtClock(s ? T.workedMs(s, now) : 0));

  let sub = 'Tap start when you begin working';
  if (s) {
    const b = openBreak(s);
    if (b) sub = `On break for ${T.fmtClock(now - b.start)}`;
    else {
      sub = `Started at ${T.fmtTime(s.start)}`;
      if (s.breaks.length) sub += ` · ${T.fmtDuration(T.breakMs(s, now))} on break`;
    }
  }
  setText('#timer-sub', sub);

  const tk = todayKey();
  setText('#stat-today', T.fmtDuration(sumWorked(state.shifts.filter((x) => T.dateKey(x.start) === tk), now)));
  const r = defaultRange();
  const paid = paidIds();
  const unpaid = shiftsInRange(r.from, r.to, { includeActive: true }).filter((x) => !paid.has(x.id));
  setText('#stat-period', T.fmtDuration(sumWorked(unpaid, now)));
}

function renderHistory() {
  const paid = paidIds();
  const sorted = [...state.shifts].sort((a, b) => b.start - a.start);
  const groups = new Map();
  for (const s of sorted) {
    const k = T.dateKey(s.start);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }

  let body = '';
  if (!sorted.length) {
    body = `<div class="empty">No shifts yet.<br>Start one on the Clock tab, or add one by hand.</div>`;
  }
  for (const [k, list] of groups) {
    body += `<div class="day">
      <div class="day-head"><span>${T.fmtDate(k)}</span><span>${T.fmtDuration(sumWorked(list))}</span></div>`;
    for (const s of list) {
      const active = s.end == null;
      const nextDay = !active && T.dateKey(s.end) !== k;
      const meta = s.breaks.length
        ? `${s.breaks.length} break${s.breaks.length > 1 ? 's' : ''} · ${T.fmtDuration(T.breakMs(s))}`
        : 'No breaks';
      const tag = active
        ? '<span class="tag tag-live">Live</span>'
        : paid.has(s.id) ? '<span class="tag tag-paid">Paid</span>' : '';
      body += `
        <button class="shift" data-id="${s.id}">
          <div class="shift-main">
            <div class="shift-times">${T.fmtTime(s.start)} – ${active ? 'now' : T.fmtTime(s.end)}${nextDay ? ' <span class="tag">+1 day</span>' : ''}</div>
            <div class="shift-meta">${meta}</div>
          </div>
          <div class="shift-side">
            <div class="shift-dur">${T.fmtDuration(T.workedMs(s))}</div>
            ${tag}
          </div>
        </button>`;
    }
    body += `</div>`;
  }

  $view.innerHTML = `
    <div class="page-head">
      <h2>History</h2>
      <button class="btn btn-primary btn-sm" id="add-shift">+ Add shift</button>
    </div>
    ${body}`;

  $view.querySelector('#add-shift').addEventListener('click', () => openShiftEditor(null));
  $view.querySelectorAll('.shift').forEach((b) =>
    b.addEventListener('click', () => openShiftEditor(b.dataset.id)));
}

function renderPay() {
  const r = defaultRange();
  const paid = paidIds();
  const unpaid = shiftsInRange(r.from, r.to).filter((s) => !paid.has(s.id));
  const ms = sumWorked(unpaid);
  const periods = [...state.payPeriods].sort((a, b) => b.to.localeCompare(a.to));

  const list = periods.length
    ? periods.map((p) => `
        <button class="period" data-id="${p.id}">
          <div>
            <div class="period-range">${T.fmtDate(p.from, { weekday: false })} – ${T.fmtDate(p.to, { weekday: false })}</div>
            <div class="muted small">${p.hours.toFixed(2)} h × ${money.format(p.rate)}/h</div>
          </div>
          <div class="period-earned">${money.format(p.earned)}</div>
        </button>`).join('')
    : `<div class="empty small">Saved pay periods will show up here.</div>`;

  $view.innerHTML = `
    <div class="page-head"><h2>Pay</h2></div>
    <section class="card hero">
      <div class="muted small">Unpaid hours since ${T.fmtDate(r.from)}</div>
      <div class="hero-value">${(ms / 3600000).toFixed(2)} <span>hours</span></div>
      <button class="btn btn-primary btn-lg btn-block" id="calc">Calculate my pay</button>
    </section>

    <h3 class="section-title">Past pay periods</h3>
    <div class="periods">${list}</div>

    <h3 class="section-title">Backup</h3>
    <section class="card">
      <p class="muted small">Your data is saved in this browser only. Download a backup now and then so you don't lose it.</p>
      <div class="row">
        <button class="btn btn-ghost" id="export">Download backup</button>
        <button class="btn btn-ghost" id="import">Restore backup</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </section>`;

  $view.querySelector('#calc').addEventListener('click', openPayCalculator);
  $view.querySelectorAll('.period').forEach((b) =>
    b.addEventListener('click', () => openPeriodDetail(b.dataset.id)));
  $view.querySelector('#export').addEventListener('click', exportBackup);
  const fileInput = $view.querySelector('#import-file');
  $view.querySelector('#import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => importBackup(fileInput.files[0]));
}

/* ---------- sheets (bottom pop-ups) ---------- */

let sheetToken = 0;
let sheetDismiss = null;

function openSheet(html, onMount, onDismiss) {
  sheetToken++;
  sheetDismiss = onDismiss || null;
  $sheetRoot.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grip"></div>${html}</div>`;
  $sheetRoot.querySelector('.sheet-backdrop').addEventListener('click', () => {
    const d = sheetDismiss;
    closeSheet();
    d?.();
  });
  requestAnimationFrame(() => requestAnimationFrame(() => $sheetRoot.classList.add('open')));
  onMount?.($sheetRoot.querySelector('.sheet'));
}

function closeSheet() {
  const t = ++sheetToken;
  sheetDismiss = null;
  $sheetRoot.classList.remove('open');
  setTimeout(() => { if (t === sheetToken) $sheetRoot.innerHTML = ''; }, 280);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $sheetRoot.classList.contains('open')) {
    const d = sheetDismiss;
    closeSheet();
    d?.();
  }
});

function confirmSheet({ title, message, okText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openSheet(`
      <h3>${title}</h3>
      <p class="muted">${message}</p>
      <div class="sheet-actions">
        <button class="btn btn-ghost" data-r="0">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1">${okText}</button>
      </div>`,
    (el) => {
      el.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
        closeSheet();
        resolve(b.dataset.r === '1');
      }));
    },
    () => resolve(false));
  });
}

// Two-tap delete button: first tap arms it, second tap runs `fn`.
function armDelete(btn, fn) {
  let armed = false;
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = 'Tap again to delete';
      btn.classList.add('armed');
      haptic(15);
      setTimeout(() => {
        armed = false;
        btn.textContent = 'Delete';
        btn.classList.remove('armed');
      }, 3000);
    } else {
      fn();
    }
  });
}

/* ---------- add / edit shift ---------- */

function openShiftEditor(id) {
  const s = id ? state.shifts.find((x) => x.id === id) : null;
  const active = !!s && s.end == null;
  const draft = {
    breaks: s && !active ? s.breaks.map((b) => ({ start: T.timeStr(b.start), end: T.timeStr(b.end) })) : [],
  };

  openSheet(`
    <h3>${s ? 'Edit shift' : 'Add shift'}</h3>
    <label class="field"><span>Date</span><input type="date" id="f-date" value="${s ? T.dateKey(s.start) : todayKey()}"></label>
    <div class="row">
      <label class="field"><span>Start</span><input type="time" id="f-start" value="${s ? T.timeStr(s.start) : '09:00'}"></label>
      ${active
        ? `<div class="field"><span>End</span><div class="static">In progress</div></div>`
        : `<label class="field"><span>End</span><input type="time" id="f-end" value="${s?.end ? T.timeStr(s.end) : '17:00'}"></label>`}
    </div>
    ${active
      ? `<p class="muted small">End the shift to edit its breaks and end time.</p>`
      : `<div class="breaks-head"><span>Breaks</span><button class="btn btn-ghost btn-sm" id="add-break">+ Add break</button></div>
         <div id="break-list"></div>`}
    <p class="error" id="f-error" hidden></p>
    <div class="sheet-actions">
      ${s ? `<button class="btn btn-ghost-danger" id="f-delete">Delete</button>` : `<button class="btn btn-ghost" id="f-cancel">Cancel</button>`}
      <button class="btn btn-primary" id="f-save">Save</button>
    </div>`,
  (el) => {
    const q = (sel) => el.querySelector(sel);

    const syncBreaks = () => {
      el.querySelectorAll('.break-row').forEach((row, i) => {
        draft.breaks[i].start = row.querySelector('.b-start').value;
        draft.breaks[i].end = row.querySelector('.b-end').value;
      });
    };

    const drawBreaks = () => {
      const list = q('#break-list');
      if (!list) return;
      list.innerHTML = draft.breaks.length
        ? draft.breaks.map((b, i) => `
            <div class="break-row">
              <input type="time" class="b-start" value="${b.start}">
              <span class="to">to</span>
              <input type="time" class="b-end" value="${b.end}">
              <button class="icon-btn" data-rm="${i}" aria-label="Remove break">×</button>
            </div>`).join('')
        : `<p class="muted small">No breaks</p>`;
      list.querySelectorAll('[data-rm]').forEach((btn) => btn.addEventListener('click', () => {
        syncBreaks();
        draft.breaks.splice(Number(btn.dataset.rm), 1);
        drawBreaks();
      }));
    };
    drawBreaks();

    q('#add-break')?.addEventListener('click', () => {
      syncBreaks();
      const last = draft.breaks[draft.breaks.length - 1];
      const start = last ? T.addMinutes(last.end, 60) : '12:00';
      draft.breaks.push({ start, end: T.addMinutes(start, 30) });
      drawBreaks();
      haptic(8);
    });

    q('#f-cancel')?.addEventListener('click', closeSheet);

    if (s) {
      armDelete(q('#f-delete'), () => {
        state.shifts = state.shifts.filter((x) => x.id !== s.id);
        state.payPeriods.forEach((p) => { p.shiftIds = (p.shiftIds || []).filter((x) => x !== s.id); });
        persist();
        closeSheet();
        render();
        toast('Shift deleted');
      });
    }

    q('#f-save').addEventListener('click', () => {
      syncBreaks();
      const err = (msg) => {
        const e = q('#f-error');
        e.textContent = msg;
        e.hidden = false;
        haptic([20, 40, 20]);
      };
      const date = q('#f-date').value;
      const start = q('#f-start').value;
      if (!date || !start) return err('Pick a date and a start time.');
      const startMs = T.combine(date, start);
      const now = Date.now();
      let result;

      if (active) {
        if (startMs > now) return err('Start time can’t be in the future.');
        if (s.breaks[0] && startMs > s.breaks[0].start) return err('Start time has to be before your first break.');
        result = { ...s, start: startMs };
      } else {
        const end = q('#f-end').value;
        if (!end) return err('Pick an end time.');
        const endMs = T.resolveAfter(date, end, startMs, true);
        if (endMs > now) return err('End time can’t be in the future.');

        const breaks = [];
        for (const [i, b] of draft.breaks.entries()) {
          if (!b.start || !b.end) return err(`Break ${i + 1} needs a start and end time.`);
          const bs = T.resolveAfter(date, b.start, startMs);
          const be = T.resolveAfter(date, b.end, bs, true);
          if (be > endMs) return err(`Break ${i + 1} has to be inside the shift.`);
          breaks.push({ start: bs, end: be });
        }
        breaks.sort((a, b) => a.start - b.start);
        for (let i = 1; i < breaks.length; i++) {
          if (breaks[i].start < breaks[i - 1].end) return err('Two of your breaks overlap.');
        }
        result = { id: s?.id || uid(), start: startMs, end: endMs, breaks };
      }

      const clash = state.shifts.find((x) => x.id !== result.id
        && x.start < (result.end ?? now) && result.start < (x.end ?? now));
      if (clash) {
        return err(`This overlaps your ${T.fmtTime(clash.start)} shift on ${T.fmtDate(T.dateKey(clash.start))}.`);
      }

      if (s) Object.assign(s, result);
      else state.shifts.push(result);
      persist();
      closeSheet();
      haptic(15);
      render();
      toast(s ? 'Shift updated' : 'Shift added');
    });
  });
}

/* ---------- pay ---------- */

function openPayCalculator() {
  const r = defaultRange();
  const lastRate = state.settings.lastRate;

  openSheet(`
    <h3>Calculate pay</h3>
    <div class="row">
      <label class="field"><span>From</span><input type="date" id="p-from" value="${r.from}"></label>
      <label class="field"><span>To</span><input type="date" id="p-to" value="${r.to}"></label>
    </div>
    <div class="summary" id="p-summary"></div>
    <label class="field"><span>Hourly pay</span>
      <div class="money-input"><span>$</span><input type="number" id="p-rate" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${lastRate ?? ''}"></div>
    </label>
    <div class="result" id="p-result"></div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="p-close">Close</button>
      <button class="btn btn-primary" id="p-save" disabled>Save pay period</button>
    </div>`,
  (el) => {
    const q = (sel) => el.querySelector(sel);
    let calc = null;

    const update = () => {
      const from = q('#p-from').value;
      const to = q('#p-to').value;
      const rate = parseFloat(q('#p-rate').value);
      const validRange = from && to && from <= to;
      const paid = paidIds();
      const inRange = validRange ? shiftsInRange(from, to) : [];
      const fresh = inRange.filter((s) => !paid.has(s.id));
      const skipped = inRange.length - fresh.length;
      const act = activeShift();
      const actKey = act && T.dateKey(act.start);
      const activeIn = validRange && act && actKey >= from && actKey <= to;

      const ms = sumWorked(fresh);
      const hours = Math.round(ms / 36000) / 100; // rounded to 2 decimals, like a timesheet
      const days = new Set(fresh.map((s) => T.dateKey(s.start))).size;

      const notes = [];
      if (!validRange) notes.push('The “From” date has to be on or before the “To” date.');
      if (skipped) notes.push(`${skipped} shift${skipped > 1 ? 's were' : ' was'} already paid and left out.`);
      if (activeIn) notes.push('You’re still clocked in. That shift counts once you end it.');

      q('#p-summary').innerHTML = `
        <div class="summary-hours">${hours.toFixed(2)} <span>hours</span></div>
        <div class="muted small">${T.fmtDuration(ms)} · ${fresh.length} shift${fresh.length === 1 ? '' : 's'} on ${days} day${days === 1 ? '' : 's'}</div>
        ${notes.map((n) => `<div class="note">${n}</div>`).join('')}`;

      const valid = validRange && fresh.length > 0 && rate > 0;
      if (valid) {
        const earned = Math.round(hours * rate * 100) / 100;
        calc = { from, to, rate, hours, ms, earned, shiftIds: fresh.map((s) => s.id) };
        q('#p-result').innerHTML = `
          <div class="result-label">You earned</div>
          <div class="result-value">${money.format(earned)}</div>
          <div class="muted small">${hours.toFixed(2)} h × ${money.format(rate)}/h</div>`;
      } else {
        calc = null;
        q('#p-result').innerHTML = `<div class="muted">${fresh.length ? 'Enter your hourly pay to see what you earned.' : 'No hours to pay in these dates.'}</div>`;
      }
      q('#p-save').disabled = !calc;
    };

    ['#p-from', '#p-to', '#p-rate'].forEach((sel) => q(sel).addEventListener('input', update));
    update();

    q('#p-close').addEventListener('click', closeSheet);
    q('#p-save').addEventListener('click', () => {
      if (!calc) return;
      state.payPeriods.push({ id: uid(), createdAt: Date.now(), ...calc });
      state.settings.lastRate = calc.rate;
      persist();
      closeSheet();
      haptic([15, 50, 15]);
      render();
      toast(`Pay period saved · ${money.format(calc.earned)}`);
    });
  });
}

function openPeriodDetail(id) {
  const p = state.payPeriods.find((x) => x.id === id);
  if (!p) return;
  openSheet(`
    <h3>${T.fmtDate(p.from, { weekday: false })} – ${T.fmtDate(p.to, { weekday: false })}</h3>
    <div class="detail">
      <div><span class="muted">Hours</span><strong>${p.hours.toFixed(2)}</strong></div>
      <div><span class="muted">Hourly pay</span><strong>${money.format(p.rate)}</strong></div>
      <div><span class="muted">Shifts</span><strong>${(p.shiftIds || []).length}</strong></div>
      <div class="detail-total"><span>Earned</span><strong>${money.format(p.earned)}</strong></div>
    </div>
    <p class="muted small">Saved ${new Date(p.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
    <div class="sheet-actions">
      <button class="btn btn-ghost-danger" id="d-delete">Delete</button>
      <button class="btn btn-primary" id="d-close">Done</button>
    </div>`,
  (el) => {
    el.querySelector('#d-close').addEventListener('click', closeSheet);
    armDelete(el.querySelector('#d-delete'), () => {
      state.payPeriods = state.payPeriods.filter((x) => x.id !== id);
      persist();
      closeSheet();
      render();
      toast('Pay period deleted. Its shifts count as unpaid again.');
    });
  });
}

/* ---------- backup ---------- */

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `time-keeper-backup-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup downloaded');
}

async function importBackup(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
    if (!Array.isArray(data.shifts) || !Array.isArray(data.payPeriods)) throw new Error('bad shape');
  } catch {
    toast('That file isn’t a Time Keeper backup');
    return;
  }
  const ok = await confirmSheet({
    title: 'Restore this backup?',
    message: `It has ${data.shifts.length} shifts and ${data.payPeriods.length} pay periods. This replaces everything currently in Time Keeper.`,
    okText: 'Restore',
    danger: true,
  });
  if (!ok) return;
  state = normalize(data);
  persist();
  render();
  toast('Backup restored');
}

/* ---------- toast ---------- */

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

/* ---------- boot ---------- */

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  if (tab === b.dataset.tab) return;
  tab = b.dataset.tab;
  haptic(5);
  render();
}));

// Keep other open tabs of the app in sync.
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    state = load();
    render();
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) updateClock(); });
setInterval(updateClock, 1000);
render();
