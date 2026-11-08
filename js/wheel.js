// Scroll-wheel pickers (like the iPhone time picker) with a haptic tick per step.

import { haptic } from './haptics.js';
import * as T from './time.js';

const ITEM = 44; // px per row; must match --wheel-item in CSS
const pad = (n) => String(n).padStart(2, '0');

function wheel(parent, { items, index = 0, loop = false, onChange, cls = '' }) {
  const n = items.length;
  const reps = loop ? 9 : 1;
  const mid = loop ? Math.floor(reps / 2) * n : 0;

  const col = document.createElement('div');
  col.className = `wheel-col ${cls}`;
  const sc = document.createElement('div');
  sc.className = 'wheel-scroll';
  sc.tabIndex = 0;
  let html = '<div class="wheel-pad"></div>';
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < n; i++) html += `<div class="wheel-item" data-i="${i}">${items[i].label}</div>`;
  }
  sc.innerHTML = html + '<div class="wheel-pad"></div>';
  col.append(sc);
  parent.append(col);

  const els = [...sc.querySelectorAll('.wheel-item')];
  const toValue = (pos) => (loop ? ((pos % n) + n) % n : Math.min(n - 1, Math.max(0, pos)));
  let lastPos = mid + index;
  let value = index;
  let settleTimer;
  let raf = 0;

  function paint() {
    raf = 0;
    const center = sc.scrollTop / ITEM;
    const lo = Math.max(0, Math.floor(center) - 4);
    const hi = Math.min(els.length - 1, Math.ceil(center) + 4);
    for (let k = lo; k <= hi; k++) {
      const d = Math.abs(k - center);
      const el = els[k];
      el.style.opacity = String(Math.max(0.12, 1 - d * 0.3));
      el.style.transform = `scale(${Math.max(0.78, 1 - d * 0.07)})`;
      el.classList.toggle('sel', d < 0.5);
    }
  }

  function settle() {
    let pos = Math.round(sc.scrollTop / ITEM);
    if (loop) {
      const home = mid + toValue(pos);
      if (home !== pos) {
        sc.scrollTop = home * ITEM;
        pos = home;
        lastPos = home;
        paint();
      }
    }
  }

  sc.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(paint);
    const pos = Math.round(sc.scrollTop / ITEM);
    if (pos !== lastPos) {
      lastPos = pos;
      const v = toValue(pos);
      if (v !== value) {
        value = v;
        haptic('tick');
        onChange?.(v);
      }
    }
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 160);
  }, { passive: true });

  sc.addEventListener('click', (e) => {
    const item = e.target.closest('.wheel-item');
    if (!item) return;
    sc.scrollTo({ top: els.indexOf(item) * ITEM, behavior: 'smooth' });
  });

  sc.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sc.scrollBy({ top: e.key === 'ArrowDown' ? ITEM : -ITEM, behavior: 'smooth' });
    }
  });

  sc.scrollTop = (mid + index) * ITEM;
  paint();
  return col;
}

function frame(parent, cls) {
  const wrap = document.createElement('div');
  wrap.className = `wheel ${cls}`;
  wrap.innerHTML = '<div class="wheel-band" aria-hidden="true"></div>';
  parent.append(wrap);
  return wrap;
}

// value and onChange use "HH:MM" (24-hour).
export function timePicker(parent, value, onChange) {
  const [h, m] = value.split(':').map(Number);
  let hi = h % 12;
  let mi = m;
  let pi = h >= 12 ? 1 : 0;
  const emit = () => onChange(`${pad(hi + pi * 12)}:${pad(mi)}`);
  const wrap = frame(parent, 'wheel-time');

  wheel(wrap, {
    items: Array.from({ length: 12 }, (_, i) => ({ label: String(i === 0 ? 12 : i) })),
    index: hi, loop: true, cls: 'wc-hour',
    onChange: (i) => { hi = i; emit(); },
  });
  const colon = document.createElement('div');
  colon.className = 'wheel-colon';
  colon.textContent = ':';
  wrap.append(colon);
  wheel(wrap, {
    items: Array.from({ length: 60 }, (_, i) => ({ label: pad(i) })),
    index: mi, loop: true, cls: 'wc-min',
    onChange: (i) => { mi = i; emit(); },
  });
  wheel(wrap, {
    items: [{ label: 'AM' }, { label: 'PM' }],
    index: pi, cls: 'wc-ampm',
    onChange: (i) => { pi = i; emit(); },
  });
}

// value and onChange use "YYYY-MM-DD". Lists past days up to today.
export function datePicker(parent, value, onChange, { days = 120 } = {}) {
  const today = T.dateKey(Date.now());
  let count = days;
  const oldest = T.addDays(today, -(days - 1));
  if (value < oldest) {
    count = Math.round((T.parseKey(today) - T.parseKey(value)) / 86400000) + 8;
  }
  const keys = [];
  for (let i = count - 1; i >= 0; i--) keys.push(T.addDays(today, -i));
  const idx = Math.max(0, keys.indexOf(value));
  const wrap = frame(parent, 'wheel-date');
  wheel(wrap, {
    items: keys.map((k) => ({ label: T.relDay(k) })),
    index: idx < 0 ? keys.length - 1 : idx,
    cls: 'wc-date',
    onChange: (i) => onChange(keys[i]),
  });
}
