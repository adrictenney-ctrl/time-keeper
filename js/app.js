import { load, save, uid, normalize, empty, STORAGE_KEY } from './store.js';
import * as T from './time.js';
import { haptic, hapticsOn, setHaptics } from './haptics.js';
import * as Sync from './sync.js';
import { timePicker, datePicker } from './wheel.js';
import { dialSVG, timeline } from './dial.js';

let state = load();
let tab = 'clock';

const $ = (sel, el = document) => el.querySelector(sel);
const $view = $('#view');
const $sheetRoot = $('#sheet-root');
const $toast = $('#toast');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const todayKey = () => T.dateKey(Date.now());
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* ======================= data helpers ======================= */

const live = (list) => list.filter((x) => !x.deleted);
const shifts = () => live(state.shifts);
const periods = () => live(state.payPeriods);
const stamp = (r) => { r.updatedAt = Date.now(); return r; };

function tombstone(list, id) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list[i] = { id, deleted: true, updatedAt: Date.now() };
}

function persist() {
  save(state);
  scheduleSync();
}

function activeShift() {
  return shifts().find((s) => s.end == null) || null;
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
  return new Set(periods().flatMap((p) => p.shiftIds || []));
}

function sumWorked(list, now = Date.now()) {
  return list.reduce((t, s) => t + T.workedMs(s, now), 0);
}

function lastPeriod() {
  return [...periods()].sort((a, b) => b.to.localeCompare(a.to))[0] || null;
}

function defaultRange() {
  const today = todayKey();
  const lp = lastPeriod();
  let from;
  if (lp) from = T.addDays(lp.to, 1);
  else if (shifts().length) from = T.dateKey(Math.min(...shifts().map((s) => s.start)));
  else from = T.addDays(today, -13);
  if (from > today) from = today;
  return { from, to: today };
}

function shiftsInRange(from, to, { includeActive = false } = {}) {
  return shifts().filter((s) => {
    if (!includeActive && s.end == null) return false;
    const k = T.dateKey(s.start);
    return k >= from && k <= to;
  });
}

function shiftsOn(key) {
  return shifts().filter((s) => T.dateKey(s.start) === key).sort((a, b) => a.start - b.start);
}

// Work and break intervals of a shift.
function intervals(s, now = Date.now()) {
  const work = [];
  const brk = [];
  const end = s.end ?? now;
  let cur = s.start;
  for (const b of [...s.breaks].sort((x, y) => x.start - y.start)) {
    const be = b.end ?? now;
    if (b.start > cur) work.push([cur, b.start]);
    brk.push([b.start, be]);
    cur = Math.max(cur, be);
  }
  if (end > cur) work.push([cur, end]);
  return { work, brk };
}

function dayIntervals(list, now) {
  const work = [];
  const brk = [];
  for (const s of list) {
    const iv = intervals(s, now);
    work.push(...iv.work);
    brk.push(...iv.brk);
  }
  return { work, brk };
}

/* ======================= sync ======================= */

let syncing = false;
let syncAgain = false;
let syncTimer;
let syncState = Sync.isConfigured() ? 'ok' : 'off';

function setSyncState(s) {
  syncState = s;
  const pill = $('#sync-pill');
  pill.dataset.sync = s;
  $('#sync-text').textContent = {
    off: 'Not synced', ok: 'Synced', syncing: 'Syncing', error: 'Sync failed', auth: 'Reconnect',
  }[s];
  const box = $('#sync-status');
  if (box) box.textContent = syncStatusLine();
}

function syncStatusLine() {
  if (syncState === 'syncing') return 'Syncing now…';
  if (syncState === 'error') return 'Last sync failed. It will try again on its own.';
  if (syncState === 'auth') return 'GitHub stopped accepting the token. Connect again with a new one.';
  const t = Sync.lastSynced();
  return t ? `Last synced ${new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Connected';
}

function scheduleSync(delay = 1200) {
  if (!Sync.isConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  if (!Sync.isConfigured()) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSyncState('syncing');
  try {
    const remote = await Sync.pull();
    const merged = Sync.merge(state, remote || empty());
    const m = Sync.canon(merged);
    if (m !== Sync.canon(state)) {
      const before = Sync.canon({ shifts: live(state.shifts), payPeriods: live(state.payPeriods) });
      state = merged;
      save(state);
      const after = Sync.canon({ shifts: live(state.shifts), payPeriods: live(state.payPeriods) });
      if (before !== after) render();
    }
    if (!remote || m !== Sync.canon(remote)) await Sync.push(merged);
    Sync.markSynced();
    setSyncState('ok');
  } catch (e) {
    console.warn('Sync failed', e);
    setSyncState(e.status === 401 ? 'auth' : 'error');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; syncNow(); }
  }
}

/* ======================= clock actions ======================= */

function startShift() {
  if (activeShift()) return;
  state.shifts.push(stamp({ id: uid(), start: Date.now(), end: null, breaks: [] }));
  persist();
  haptic('heavy');
  render();
}

function pauseShift() {
  const s = activeShift();
  if (!s || openBreak(s)) return;
  s.breaks.push({ start: Date.now(), end: null });
  stamp(s);
  persist();
  haptic('medium');
  render();
}

function resumeShift() {
  const s = activeShift();
  const b = openBreak(s);
  if (!b) return;
  b.end = Date.now();
  stamp(s);
  persist();
  haptic('medium');
  render();
}

async function endShift() {
  const s = activeShift();
  if (!s) return;
  haptic('light');
  const ok = await confirmSheet({
    title: 'End this shift?',
    message: `You’ve worked ${T.fmtDuration(T.workedMs(s))} since ${T.fmtTime(s.start)}.`,
    okText: 'End shift',
    danger: true,
  });
  if (!ok) return;
  const now = Date.now();
  const b = openBreak(s);
  if (b) b.end = now;
  s.end = now;
  stamp(s);
  persist();
  haptic('success');
  render();
  toast(`Shift saved · ${T.fmtDuration(T.workedMs(s))}`);
}

/* ======================= rendering ======================= */

const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5.5" width="4" height="13" rx="1.2"/><rect x="13.5" y="5.5" width="4" height="13" rx="1.2"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>',
};

function render() {
  document.querySelectorAll('.tab').forEach((b, i) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
    if (on) $('.tab-indicator').style.transform = `translateX(${i * 100}%)`;
  });
  $view.dataset.tab = tab;
  if (tab === 'clock') renderClock();
  else if (tab === 'history') renderDays();
  else renderPay();
}

function setHTML(sel, html) {
  const el = $(sel, $view);
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

/* ---------- Clock ---------- */

function renderClock() {
  const st = status();
  let actions;
  if (st === 'idle') {
    actions = `<button class="btn btn-brass btn-hero" data-act="start">${ICON.play}<span>Start shift</span></button>`;
  } else if (st === 'working') {
    actions = `
      <button class="btn btn-quiet btn-hero" data-act="pause">${ICON.pause}<span>Take a break</span></button>
      <button class="btn btn-stop btn-round" data-act="end" aria-label="End shift">${ICON.stop}</button>`;
  } else {
    actions = `
      <button class="btn btn-brass btn-hero" data-act="resume">${ICON.play}<span>Back to work</span></button>
      <button class="btn btn-stop btn-round" data-act="end" aria-label="End shift">${ICON.stop}</button>`;
  }

  const r = defaultRange();
  $view.innerHTML = `
    <section class="clock" data-state="${st}">
      <p class="clock-date">${T.fmtLongDate(todayKey())}</p>
      <div class="dial">
        <div id="dial-svg"></div>
        <div class="dial-center">
          <div class="readout" id="readout"></div>
          <div class="readout-label" id="readout-label"></div>
        </div>
      </div>
      <div class="clock-actions">${actions}</div>
    </section>
    <section class="tally">
      <div class="tally-item">
        <div class="tally-value" id="t-today">0m</div>
        <div class="tally-label">worked today</div>
      </div>
      <div class="tally-rule" aria-hidden="true"></div>
      <div class="tally-item">
        <div class="tally-value" id="t-period">0m</div>
        <div class="tally-label">unpaid since ${T.fmtDate(r.from, { weekday: false })}</div>
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
  const st = status();
  const tk = todayKey();

  const ro = T.fmtReadout(s ? T.workedMs(s, now) : 0);
  setHTML('#readout', `<span class="ro-main">${ro.main}</span><span class="ro-sec">${ro.sec}</span>`);

  let label = 'Off the clock';
  if (st === 'working') label = `Working since ${T.fmtTime(s.start)}`;
  if (st === 'break') {
    const m = Math.floor((now - openBreak(s).start) / 60000);
    label = m < 1 ? 'On break · just started' : `On break · ${T.fmtDuration(now - openBreak(s).start)}`;
  }
  setHTML('#readout-label', label);

  const today = shifts().filter((x) => x.start < T.dayStartMs(T.addDays(tk, 1)) && (x.end ?? now) > T.dayStartMs(tk));
  const { work, brk } = dayIntervals(today, now);
  setHTML('#dial-svg', dialSVG({ work, brk, dayStart: T.dayStartMs(tk), now, state: st }));

  setHTML('#t-today', T.fmtDuration(sumWorked(shiftsOn(tk), now)));
  const r = defaultRange();
  const paid = paidIds();
  const unpaid = shiftsInRange(r.from, r.to, { includeActive: true }).filter((x) => !paid.has(x.id));
  setHTML('#t-period', T.fmtDuration(sumWorked(unpaid, now)));
}

/* ---------- Days ---------- */

function weekLabel(ws) {
  const thisWeek = T.weekStart(todayKey());
  if (ws === thisWeek) return 'This week';
  if (ws === T.addDays(thisWeek, -7)) return 'Last week';
  return `${T.fmtDate(ws, { weekday: false })} – ${T.fmtDate(T.addDays(ws, 6), { weekday: false })}`;
}

function dayWindow(list, key, now) {
  const d0 = T.dayStartMs(key);
  let lo = d0 + 7 * 3600000;
  let hi = d0 + 19 * 3600000;
  for (const s of list) {
    lo = Math.min(lo, s.start);
    hi = Math.max(hi, s.end ?? now);
  }
  const H = 3600000;
  return [d0 + Math.floor((lo - d0) / H) * H, d0 + Math.ceil((hi - d0) / H) * H];
}

function renderDays() {
  const now = Date.now();
  const paid = paidIds();
  const keys = [...new Set(shifts().map((s) => T.dateKey(s.start)))].sort().reverse();

  const weeks = new Map();
  for (const k of keys) {
    const ws = T.weekStart(k);
    if (!weeks.has(ws)) weeks.set(ws, []);
    weeks.get(ws).push(k);
  }

  let body = '';
  if (!keys.length) {
    body = `
      <div class="empty">
        <p class="empty-title">No days yet</p>
        <p class="empty-text">Start a shift on the Clock, or add a day you already worked.</p>
        <button class="btn btn-brass" id="empty-add">${ICON.plus}<span>Add a day</span></button>
      </div>`;
  }

  for (const [ws, dayKeys] of weeks) {
    const weekMs = dayKeys.reduce((t, k) => t + sumWorked(shiftsOn(k), now), 0);
    body += `
      <section class="week">
        <div class="week-head"><h3>${weekLabel(ws)}</h3><span>${T.fmtDuration(weekMs)}</span></div>
        <div class="week-days">`;
    for (const k of dayKeys) {
      const list = shiftsOn(k);
      const ms = sumWorked(list, now);
      const { work, brk } = dayIntervals(list, now);
      const first = list[0];
      const last = list[list.length - 1];
      const isLive = list.some((s) => s.end == null);
      const allPaid = list.every((s) => paid.has(s.id));
      const brkMs = list.reduce((t, s) => t + T.breakMs(s, now), 0);
      const d = T.parseKey(k);
      const span = `${T.fmtTime(first.start)} – ${last.end == null ? 'now' : T.fmtTime(last.end)}`;
      const meta = brkMs >= 60000 ? `${span} · ${T.fmtDuration(brkMs)} break` : span;
      body += `
        <button class="day" data-key="${k}">
          <div class="day-date">
            <span class="day-wd">${d.toLocaleDateString([], { weekday: 'short' })}</span>
            <span class="day-num">${d.getDate()}</span>
          </div>
          <div class="day-body">
            <div class="day-line">
              <span class="day-hours">${T.fmtDuration(ms)}</span>
              ${isLive ? '<span class="chip chip-live">Live</span>' : allPaid ? '<span class="chip chip-paid">Paid</span>' : ''}
            </div>
            ${timeline(work, brk, dayWindow(list, k, now))}
            <div class="day-meta">${meta}</div>
          </div>
        </button>`;
    }
    body += `</div></section>`;
  }

  $view.innerHTML = `
    <div class="page-head">
      <h2>Days</h2>
      <button class="btn btn-quiet btn-small" id="add-day">${ICON.plus}<span>Add</span></button>
    </div>
    ${body}`;

  $('#add-day', $view).addEventListener('click', () => openShiftEditor({ date: todayKey() }));
  $('#empty-add', $view)?.addEventListener('click', () => openShiftEditor({ date: todayKey() }));
  $view.querySelectorAll('.day').forEach((b) =>
    b.addEventListener('click', () => { haptic('light'); openDay(b.dataset.key); }));
}

function openDay(key) {
  const now = Date.now();
  const list = shiftsOn(key);
  if (!list.length) { render(); return; }
  const paid = paidIds();
  const { work, brk } = dayIntervals(list, now);
  const ms = sumWorked(list, now);

  const rows = list.map((s) => {
    const b = T.breakMs(s, now);
    const live = s.end == null;
    return `
      <button class="row-btn" data-id="${s.id}">
        <div class="row-main">
          <div class="row-title">${T.fmtTime(s.start)} – ${live ? 'now' : T.fmtTime(s.end)}${!live && T.dateKey(s.end) !== key ? ' <span class="chip">next day</span>' : ''}</div>
          <div class="row-sub">${s.breaks.length ? `${s.breaks.length} break${s.breaks.length > 1 ? 's' : ''}, ${T.fmtDuration(b)}` : 'No breaks'}${paid.has(s.id) ? ' · paid' : ''}</div>
        </div>
        <div class="row-value">${T.fmtDuration(T.workedMs(s, now))}</div>
        ${ICON.chevron}
      </button>`;
  }).join('');

  openSheet(`
    <div class="sheet-head">
      <h3>${T.fmtLongDate(key)}</h3>
      <p class="sheet-sub">${T.fmtDuration(ms)} worked</p>
    </div>
    <div class="day-sheet-tl">${timeline(work, brk, dayWindow(list, key, now))}
      <div class="tl-scale"><span>${T.fmtTime(dayWindow(list, key, now)[0])}</span><span>${T.fmtTime(dayWindow(list, key, now)[1])}</span></div>
    </div>
    <div class="group">${rows}</div>
    <button class="btn btn-quiet btn-block" id="day-add">${ICON.plus}<span>Add time to this day</span></button>`,
  (el) => {
    el.querySelectorAll('.row-btn').forEach((b) =>
      b.addEventListener('click', () => openShiftEditor({ id: b.dataset.id, back: key })));
    $('#day-add', el).addEventListener('click', () => openShiftEditor({ date: key, back: key }));
  });
}

/* ---------- Pay ---------- */

function renderPay() {
  const r = defaultRange();
  const paid = paidIds();
  const unpaid = shiftsInRange(r.from, r.to).filter((s) => !paid.has(s.id));
  const ms = sumWorked(unpaid);
  const list = [...periods()].sort((a, b) => b.to.localeCompare(a.to));
  const total = list.reduce((t, p) => t + p.earned, 0);

  $view.innerHTML = `
    <div class="page-head"><h2>Pay</h2></div>
    <section class="pay-hero">
      <div class="pay-hours"><span class="ph-num">${T.hours2(ms).toFixed(2)}</span><span class="ph-unit">hours</span></div>
      <p class="pay-caption">${unpaid.length
        ? `Not paid yet, from ${unpaid.length} shift${unpaid.length === 1 ? '' : 's'} since ${T.fmtDate(r.from)}.`
        : `Nothing to pay yet. Hours you work after ${T.fmtDate(T.addDays(r.from, -1), { weekday: false })} land here.`}</p>
      <button class="btn btn-brass btn-hero btn-block" id="calc">Calculate my pay</button>
    </section>

    <section class="periods">
      <div class="week-head"><h3>Past pay periods</h3>${list.length ? `<span>${money.format(total)} total</span>` : ''}</div>
      ${list.length
        ? `<div class="group">${list.map((p) => `
            <button class="row-btn" data-id="${p.id}">
              <div class="row-main">
                <div class="row-title">${T.fmtDate(p.from, { weekday: false })} – ${T.fmtDate(p.to, { weekday: false })}</div>
                <div class="row-sub">${p.hours.toFixed(2)} hours at ${money.format(p.rate)}</div>
              </div>
              <div class="row-value row-money">${money.format(p.earned)}</div>
              ${ICON.chevron}
            </button>`).join('')}</div>`
        : `<p class="quiet-note">When you calculate and save your pay, each pay period is kept here.</p>`}
    </section>`;

  $('#calc', $view).addEventListener('click', () => { haptic('light'); openPayCalculator(); });
  $view.querySelectorAll('.row-btn').forEach((b) =>
    b.addEventListener('click', () => openPeriodDetail(b.dataset.id)));
}

/* ======================= sheets ======================= */

let sheetToken = 0;
let sheetDismiss = null;

function openSheet(html, onMount, onDismiss) {
  sheetToken++;
  const wasOpen = $sheetRoot.classList.contains('open');
  sheetDismiss = onDismiss || null;
  $sheetRoot.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet${wasOpen ? ' swap' : ''}" role="dialog" aria-modal="true">
      <div class="sheet-grab"><div class="sheet-grip"></div></div>
      <div class="sheet-body">${html}</div>
    </div>`;
  const sheet = $('.sheet', $sheetRoot);
  $('.sheet-backdrop', $sheetRoot).addEventListener('click', dismissSheet);
  enableDrag(sheet);
  if (wasOpen) $sheetRoot.classList.add('open');
  else requestAnimationFrame(() => requestAnimationFrame(() => $sheetRoot.classList.add('open')));
  onMount?.($('.sheet-body', sheet));
}

function dismissSheet() {
  const d = sheetDismiss;
  closeSheet();
  d?.();
}

function closeSheet() {
  const t = ++sheetToken;
  sheetDismiss = null;
  const sheet = $('.sheet', $sheetRoot);
  if (sheet) sheet.style.transform = '';
  $sheetRoot.classList.remove('open');
  setTimeout(() => { if (t === sheetToken) $sheetRoot.innerHTML = ''; }, 320);
}

// Drag the sheet down by its handle to close it.
function enableDrag(sheet) {
  const grab = $('.sheet-grab', sheet);
  let y0 = null;
  let dy = 0;
  grab.addEventListener('pointerdown', (e) => {
    y0 = e.clientY;
    dy = 0;
    sheet.classList.add('dragging');
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    sheet.classList.remove('dragging');
    if (dy > 110) dismissSheet();
    else sheet.style.transform = '';
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $sheetRoot.classList.contains('open')) dismissSheet();
});

function confirmSheet({ title, message, okText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openSheet(`
      <div class="sheet-head"><h3>${title}</h3><p class="sheet-sub">${message}</p></div>
      <div class="sheet-actions">
        <button class="btn btn-quiet" data-r="0">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-brass'}" data-r="1">${okText}</button>
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

// Two-tap delete: the first tap arms it, the second runs `fn`.
function armDelete(btn, fn, label = 'Delete') {
  let armed = false;
  let timer;
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.querySelector('span').textContent = 'Tap again to delete';
      btn.classList.add('armed');
      haptic('warning');
      timer = setTimeout(() => {
        armed = false;
        btn.querySelector('span').textContent = label;
        btn.classList.remove('armed');
      }, 3000);
    } else {
      clearTimeout(timer);
      haptic('heavy');
      fn();
    }
  });
}

/* ---------- picker rows (tap a value to open a wheel under it) ---------- */

function pickerRows(root, getters) {
  let openKey = null;
  const closeAll = () => {
    root.querySelectorAll('.ppanel.open').forEach((p) => {
      p.classList.remove('open');
      const inner = p.firstElementChild;
      setTimeout(() => { if (!p.classList.contains('open')) inner.innerHTML = ''; }, 260);
    });
    root.querySelectorAll('[data-pick].on').forEach((b) => b.classList.remove('on'));
    openKey = null;
  };
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick]');
    if (!btn || !root.contains(btn)) return;
    const key = btn.dataset.pick;
    const was = openKey;
    closeAll();
    if (was === key) return;
    const panel = root.querySelector(`.ppanel[data-panel="${key}"]`);
    const inner = panel.firstElementChild;
    inner.innerHTML = '';
    const g = getters(key);
    if (g.type === 'date') datePicker(inner, g.value, (v) => { g.set(v); btn.querySelector('.pval').textContent = T.relDay(v); }, g.opts);
    else timePicker(inner, g.value, (v) => { g.set(v); btn.querySelector('.pval').textContent = T.fmtTimeStr(v); });
    panel.classList.add('open');
    btn.classList.add('on');
    openKey = key;
    haptic('light');
  });
  return { closeAll };
}

/* ---------- add / edit time ---------- */

function openShiftEditor({ id = null, date = null, back = null } = {}) {
  const s = id ? shifts().find((x) => x.id === id) : null;
  const active = !!s && s.end == null;
  const lastRateTimes = state.settings.lastTimes || { start: '09:00', end: '17:00' };
  const draft = {
    date: s ? T.dateKey(s.start) : (date || todayKey()),
    start: s ? T.timeStr(s.start) : lastRateTimes.start,
    end: s?.end ? T.timeStr(s.end) : lastRateTimes.end,
    breaks: s && !active ? s.breaks.map((b) => ({ start: T.timeStr(b.start), end: T.timeStr(b.end) })) : [],
  };
  const goBack = () => { if (back && shiftsOn(back).length) openDay(back); else closeSheet(); };

  const breakRows = () => draft.breaks.map((b, i) => `
    <div class="brk">
      <span class="brk-label">Break ${draft.breaks.length > 1 ? i + 1 : ''}</span>
      <button class="chip-btn" data-pick="b${i}s"><span class="pval">${T.fmtTimeStr(b.start)}</span></button>
      <span class="brk-to">to</span>
      <button class="chip-btn" data-pick="b${i}e"><span class="pval">${T.fmtTimeStr(b.end)}</span></button>
      <button class="icon-btn icon-remove" data-rm="${i}" aria-label="Remove break ${i + 1}">${ICON.minus}</button>
    </div>
    <div class="ppanel" data-panel="b${i}s"><div></div></div>
    <div class="ppanel" data-panel="b${i}e"><div></div></div>`).join('');

  const body = () => `
    <div class="sheet-head">
      <h3>${s ? 'Edit time' : 'Add time'}</h3>
      <p class="sheet-sub" id="f-total"></p>
    </div>
    <div class="group form">
      ${s ? `<div class="prow static"><span>Day</span><span class="pval">${T.relDay(draft.date)}</span></div>`
        : `<button class="prow" data-pick="date"><span>Day</span><span class="pval">${T.relDay(draft.date)}</span></button>
           <div class="ppanel" data-panel="date"><div></div></div>`}
      <button class="prow" data-pick="start"><span>Started</span><span class="pval">${T.fmtTimeStr(draft.start)}</span></button>
      <div class="ppanel" data-panel="start"><div></div></div>
      ${active
        ? `<div class="prow static"><span>Ended</span><span class="pval muted">Still working</span></div>`
        : `<button class="prow" data-pick="end"><span>Ended</span><span class="pval">${T.fmtTimeStr(draft.end)}</span></button>
           <div class="ppanel" data-panel="end"><div></div></div>`}
    </div>
    ${active ? `<p class="quiet-note">End the shift to change its breaks and end time.</p>` : `
      <div class="group form breaks">
        ${breakRows()}
        <button class="add-row" id="add-break">${ICON.plus}<span>Add a break</span></button>
      </div>`}
    <p class="error" id="f-error" hidden></p>
    <div class="sheet-actions">
      ${s ? `<button class="btn btn-danger-quiet" id="f-delete"><span>Delete</span></button>`
        : `<button class="btn btn-quiet" id="f-cancel">Cancel</button>`}
      <button class="btn btn-brass" id="f-save">Save</button>
    </div>`;

  // Turn the draft into real timestamps, or return an error message.
  function build() {
    const startMs = T.combine(draft.date, draft.start);
    const now = Date.now();
    if (active) {
      if (startMs > now) return { error: 'The start time can’t be in the future.' };
      if (s.breaks[0] && startMs > s.breaks[0].start) return { error: 'The start time has to be before your first break.' };
      return { result: { ...s, start: startMs } };
    }
    const endMs = T.resolveAfter(draft.date, draft.end, startMs, true);
    if (endMs > now) return { error: 'The end time can’t be in the future.' };
    const breaks = [];
    for (const [i, b] of draft.breaks.entries()) {
      const bs = T.resolveAfter(draft.date, b.start, startMs);
      const be = T.resolveAfter(draft.date, b.end, bs, true);
      if (be > endMs) return { error: `Break ${i + 1} has to be between the start and end times.` };
      breaks.push({ start: bs, end: be });
    }
    breaks.sort((a, b) => a.start - b.start);
    for (let i = 1; i < breaks.length; i++) {
      if (breaks[i].start < breaks[i - 1].end) return { error: 'Two breaks overlap. Change one of them.' };
    }
    const result = { id: s?.id || uid(), start: startMs, end: endMs, breaks };
    const clash = shifts().find((x) => x.id !== result.id && x.start < result.end && result.start < (x.end ?? now));
    if (clash) {
      return { error: `This overlaps your ${T.fmtTime(clash.start)} shift on ${T.relDay(T.dateKey(clash.start))}.`, result };
    }
    return { result };
  }

  openSheet('<div id="editor"></div>', (el) => {
    const host = $('#editor', el);
    let pickers;

    const updateTotal = () => {
      const { result } = build();
      const t = $('#f-total', host);
      if (!result) { t.textContent = ''; return; }
      const ms = T.workedMs(result);
      const next = result.end && T.dateKey(result.end) !== draft.date ? ' · ends the next day' : '';
      t.textContent = `${T.fmtDuration(ms)} worked${next}`;
      $('#f-error', host).hidden = true;
    };

    const draw = () => {
      host.innerHTML = body();
      pickers = pickerRows(host, (key) => {
        if (key === 'date') return { type: 'date', value: draft.date, set: (v) => { draft.date = v; updateTotal(); } };
        if (key === 'start' || key === 'end') return { type: 'time', value: draft[key], set: (v) => { draft[key] = v; updateTotal(); } };
        const i = Number(key.slice(1, -1));
        const side = key.endsWith('s') ? 'start' : 'end';
        return { type: 'time', value: draft.breaks[i][side], set: (v) => { draft.breaks[i][side] = v; updateTotal(); } };
      });
      host.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
        draft.breaks.splice(Number(b.dataset.rm), 1);
        haptic('light');
        draw();
      }));
      $('#add-break', host)?.addEventListener('click', () => {
        const last = draft.breaks[draft.breaks.length - 1];
        const st = last ? T.addMinutes(last.end, 120) : midpoint(draft.start, draft.end);
        draft.breaks.push({ start: st, end: T.addMinutes(st, 30) });
        haptic('light');
        draw();
      });
      $('#f-cancel', host)?.addEventListener('click', goBack);
      if (s) {
        armDelete($('#f-delete', host), () => {
          tombstone(state.shifts, s.id);
          periods().forEach((p) => {
            if ((p.shiftIds || []).includes(s.id)) {
              p.shiftIds = p.shiftIds.filter((x) => x !== s.id);
              stamp(p);
            }
          });
          persist();
          render();
          goBack();
          toast('Time deleted');
        });
      }
      $('#f-save', host).addEventListener('click', save_);
      updateTotal();
    };

    function save_() {
      pickers.closeAll();
      const { error, result } = build();
      if (error) {
        const e = $('#f-error', host);
        e.textContent = error;
        e.hidden = false;
        haptic('error');
        return;
      }
      if (s) Object.assign(s, result);
      else state.shifts.push(result);
      stamp(s || result);
      if (!active) {
        state.settings = { ...state.settings, lastTimes: { start: draft.start, end: draft.end }, updatedAt: Date.now() };
      }
      persist();
      haptic('success');
      render();
      if (back) openDay(T.dateKey(result.start)); else closeSheet();
      toast(s ? 'Time updated' : 'Time added');
    }

    draw();
  });
}

function midpoint(a, b) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  let x = toMin(a);
  let y = toMin(b);
  if (y <= x) y += 1440;
  const mid = Math.round((x + (y - x) / 2 - 15) / 15) * 15;
  return T.addMinutes('00:00', mid);
}

/* ---------- pay calculator ---------- */

function openPayCalculator() {
  const r = defaultRange();
  const draft = { from: r.from, to: r.to };
  const lastRate = state.settings.lastRate;

  openSheet(`
    <div class="sheet-head"><h3>Calculate pay</h3><p class="sheet-sub">Pick the dates, then enter your hourly pay.</p></div>
    <div class="group form" id="p-dates">
      <button class="prow" data-pick="from"><span>From</span><span class="pval">${T.relDay(draft.from)}</span></button>
      <div class="ppanel" data-panel="from"><div></div></div>
      <button class="prow" data-pick="to"><span>To</span><span class="pval">${T.relDay(draft.to)}</span></button>
      <div class="ppanel" data-panel="to"><div></div></div>
    </div>
    <div class="calc-hours" id="p-hours"></div>
    <label class="rate">
      <span class="rate-label">Hourly pay</span>
      <span class="rate-field"><span class="rate-cur">$</span><input type="text" id="p-rate" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${lastRate != null ? lastRate.toFixed(2) : ''}"></span>
    </label>
    <div class="earned" id="p-earned"></div>
    <div class="sheet-actions">
      <button class="btn btn-quiet" id="p-close">Close</button>
      <button class="btn btn-brass" id="p-save" disabled>Save pay period</button>
    </div>`,
  (el) => {
    let calc = null;
    let shown = 0;
    let anim = 0;

    pickerRows($('#p-dates', el), (key) => ({
      type: 'date', value: draft[key], opts: { days: 400 },
      set: (v) => { draft[key] = v; update(); },
    }));

    const rateInput = $('#p-rate', el);
    rateInput.addEventListener('input', () => {
      const cleaned = rateInput.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').replace(/(\.\d\d)\d+/, '$1');
      if (cleaned !== rateInput.value) rateInput.value = cleaned;
      update();
    });

    function countTo(target) {
      cancelAnimationFrame(anim);
      const node = $('#p-amount', el);
      if (!node) return;
      if (reduceMotion.matches) { node.textContent = money.format(target); shown = target; return; }
      const from = shown;
      const t0 = performance.now();
      const dur = 650;
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const e = 1 - (1 - k) ** 3;
        shown = from + (target - from) * e;
        node.textContent = money.format(shown);
        if (k < 1) anim = requestAnimationFrame(step);
        else shown = target;
      };
      anim = requestAnimationFrame(step);
    }

    function update() {
      const { from, to } = draft;
      const rate = parseFloat(rateInput.value);
      const validRange = from <= to;
      const paid = paidIds();
      const inRange = validRange ? shiftsInRange(from, to) : [];
      const fresh = inRange.filter((s) => !paid.has(s.id));
      const skipped = inRange.length - fresh.length;
      const act = activeShift();
      const actKey = act && T.dateKey(act.start);
      const activeIn = validRange && act && actKey >= from && actKey <= to;
      const ms = sumWorked(fresh);
      const hours = T.hours2(ms);
      const days = new Set(fresh.map((s) => T.dateKey(s.start))).size;

      const notes = [];
      if (!validRange) notes.push('“From” has to be on or before “To”.');
      if (skipped) notes.push(`${skipped} shift${skipped > 1 ? 's were' : ' was'} already paid, so ${skipped > 1 ? 'they’re' : 'it’s'} left out.`);
      if (activeIn) notes.push('You’re still clocked in. That shift counts once you end it.');

      $('#p-hours', el).innerHTML = `
        <div class="ch-main">
          <span class="ch-num">${hours.toFixed(2)}</span><span class="ch-unit">hours</span>
          <button class="copy-btn" data-copy="${hours.toFixed(2)}" aria-label="Copy hours">${ICON.copy}</button>
        </div>
        <div class="ch-sub">${fresh.length ? `${T.fmtDuration(ms)} over ${days} day${days === 1 ? '' : 's'}` : 'No unpaid time in these dates'}</div>
        ${notes.map((n) => `<p class="note">${n}</p>`).join('')}`;

      const valid = validRange && fresh.length > 0 && rate > 0;
      const box = $('#p-earned', el);
      if (valid) {
        const earned = Math.round(hours * rate * 100) / 100;
        calc = { from, to, rate, hours, ms, earned, shiftIds: fresh.map((s) => s.id) };
        if (!box.querySelector('#p-amount')) {
          box.innerHTML = `
            <div class="earned-label">You earned</div>
            <div class="earned-row">
              <span class="earned-amount" id="p-amount">${money.format(shown)}</span>
              <button class="copy-btn" id="p-copy-amt" aria-label="Copy amount">${ICON.copy}</button>
            </div>
            <div class="earned-math" id="p-math"></div>`;
        }
        $('#p-copy-amt', box).dataset.copy = earned.toFixed(2);
        $('#p-math', box).textContent = `${hours.toFixed(2)} hours × ${money.format(rate)}`;
        box.classList.add('on');
        countTo(earned);
      } else {
        calc = null;
        shown = 0;
        box.classList.remove('on');
        box.innerHTML = `<div class="earned-empty">${fresh.length ? 'Enter your hourly pay to see what you earned.' : 'Change the dates to include time you haven’t been paid for.'}</div>`;
      }
      $('#p-save', el).disabled = !calc;
    }

    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        haptic('light');
        toast(`Copied ${btn.dataset.copy}`);
      } catch {
        toast('Couldn’t copy. Select the number and copy it yourself.');
      }
    });

    update();
    $('#p-close', el).addEventListener('click', closeSheet);
    $('#p-save', el).addEventListener('click', () => {
      if (!calc) return;
      state.payPeriods.push(stamp({ id: uid(), createdAt: Date.now(), ...calc }));
      state.settings = { ...state.settings, lastRate: calc.rate, updatedAt: Date.now() };
      persist();
      closeSheet();
      haptic('success');
      render();
      toast(`Pay period saved · ${money.format(calc.earned)}`);
    });
  });
}

function openPeriodDetail(id) {
  const p = periods().find((x) => x.id === id);
  if (!p) return;
  openSheet(`
    <div class="sheet-head">
      <h3>${T.fmtDate(p.from, { weekday: false })} – ${T.fmtDate(p.to, { weekday: false })}</h3>
      <p class="sheet-sub">Saved ${new Date(p.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</p>
    </div>
    <div class="receipt">
      <div class="rc-row"><span>Hours</span><span>${p.hours.toFixed(2)}</span><button class="copy-btn" data-copy="${p.hours.toFixed(2)}" aria-label="Copy hours">${ICON.copy}</button></div>
      <div class="rc-row"><span>Hourly pay</span><span>${money.format(p.rate)}</span><span></span></div>
      <div class="rc-row"><span>Shifts</span><span>${(p.shiftIds || []).length}</span><span></span></div>
      <div class="rc-row rc-total"><span>Earned</span><span>${money.format(p.earned)}</span><button class="copy-btn" data-copy="${p.earned.toFixed(2)}" aria-label="Copy amount">${ICON.copy}</button></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-danger-quiet" id="d-delete"><span>Delete</span></button>
      <button class="btn btn-brass" id="d-close">Done</button>
    </div>`,
  (el) => {
    $('#d-close', el).addEventListener('click', closeSheet);
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      try { await navigator.clipboard.writeText(btn.dataset.copy); haptic('light'); toast(`Copied ${btn.dataset.copy}`); } catch { /* ignore */ }
    });
    armDelete($('#d-delete', el), () => {
      tombstone(state.payPeriods, id);
      persist();
      closeSheet();
      render();
      toast('Pay period deleted. Its shifts count as unpaid again.');
    });
  });
}

/* ---------- settings ---------- */

function openSettings() {
  const connected = Sync.isConfigured();
  openSheet(`
    <div class="sheet-head"><h3>Settings</h3></div>

    <h4 class="group-title">Sync between devices</h4>
    ${connected ? `
      <div class="group">
        <div class="prow static"><span>GitHub account</span><span class="pval">${Sync.account() || 'Connected'}</span></div>
        <div class="prow static"><span>Status</span><span class="pval" id="sync-status">${syncStatusLine()}</span></div>
      </div>
      <div class="sheet-actions tight">
        <button class="btn btn-quiet" id="s-disconnect">Turn off sync</button>
        <button class="btn btn-brass" id="s-sync">Sync now</button>
      </div>`
    : `
      <div class="group pad">
        <p class="help">Your hours are saved to a private gist on your GitHub account. Every device you connect reads and writes the same copy.</p>
        <ol class="steps">
          <li>Open <a href="https://github.com/settings/tokens/new?scopes=gist&description=Time%20Keeper" target="_blank" rel="noopener">GitHub’s new token page</a>. The <b>gist</b> box is already checked.</li>
          <li>Set <b>Expiration</b> to <b>No expiration</b>, then tap <b>Generate token</b>.</li>
          <li>Copy the token and paste it below. Do the same on your other devices.</li>
        </ol>
        <input type="password" id="s-token" class="text-input" placeholder="ghp_…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <p class="error" id="s-error" hidden></p>
        <button class="btn btn-brass btn-block" id="s-connect">Connect</button>
      </div>`}

    <h4 class="group-title">Feel</h4>
    <div class="group">
      <label class="prow toggle">
        <span>Haptics</span>
        <input type="checkbox" switch id="s-haptics" ${hapticsOn() ? 'checked' : ''}>
      </label>
    </div>
    <p class="quiet-note">On iPhone, haptics need iOS 18 or newer.</p>

    <h4 class="group-title">Backup</h4>
    <div class="group">
      <button class="prow" id="s-export"><span>Download a backup</span>${ICON.chevron}</button>
      <button class="prow" id="s-import"><span>Restore from a backup</span>${ICON.chevron}</button>
    </div>
    <input type="file" id="s-file" accept="application/json,.json" hidden>`,
  (el) => {
    $('#s-haptics', el).addEventListener('change', (e) => {
      setHaptics(e.target.checked);
      haptic('medium');
    });
    $('#s-export', el).addEventListener('click', exportBackup);
    const file = $('#s-file', el);
    $('#s-import', el).addEventListener('click', () => file.click());
    file.addEventListener('change', () => importBackup(file.files[0]));

    if (connected) {
      $('#s-sync', el).addEventListener('click', () => { haptic('light'); syncNow(); });
      $('#s-disconnect', el).addEventListener('click', () => {
        Sync.disconnect();
        setSyncState('off');
        haptic('medium');
        toast('Sync is off on this device. Your data stays here.');
        openSettings();
      });
    } else {
      $('#s-connect', el).addEventListener('click', async () => {
        const token = $('#s-token', el).value.trim();
        const err = $('#s-error', el);
        const btn = $('#s-connect', el);
        if (!token) { err.textContent = 'Paste your token first.'; err.hidden = false; haptic('error'); return; }
        btn.disabled = true;
        btn.textContent = 'Connecting…';
        try {
          await Sync.connect(token, state);
          setSyncState('ok');
          await syncNow();
          haptic('success');
          toast('Sync is on');
          openSettings();
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
          btn.disabled = false;
          btn.textContent = 'Connect';
          haptic('error');
        }
      });
    }
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
  const incoming = normalize(data);
  const ok = await confirmSheet({
    title: 'Restore this backup?',
    message: `It has ${live(incoming.shifts).length} shifts and ${live(incoming.payPeriods).length} pay periods. They’ll be combined with what’s already here.`,
    okText: 'Restore',
  });
  if (!ok) return;
  state = Sync.merge(state, incoming);
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

/* ======================= boot ======================= */

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  if (tab === b.dataset.tab) return;
  tab = b.dataset.tab;
  haptic('light');
  render();
  window.scrollTo({ top: 0 });
}));

$('#open-settings').addEventListener('click', () => { haptic('light'); openSettings(); });
$('#sync-pill').addEventListener('click', () => { haptic('light'); openSettings(); });

window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    state = load();
    render();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    updateClock();
    scheduleSync(0);
  }
});
window.addEventListener('online', () => scheduleSync(0));
window.addEventListener('focus', () => scheduleSync(300));

setInterval(updateClock, 1000);
setInterval(() => { if (!document.hidden) scheduleSync(0); }, 30000);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

setSyncState(syncState);
render();
scheduleSync(0);
