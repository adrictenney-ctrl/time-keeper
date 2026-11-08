// Haptic feedback.
//
// Android and other browsers: navigator.vibrate().
//
// iPhone: Safari has no vibrate(). The only haptic a web page can reach is the tick
// a native <input type="checkbox" switch> plays when it toggles. Since iOS 26.5 that
// tick only plays when a real finger taps the switch's label, so on each tap we slip
// an invisible label (wired to a hidden switch) over the button under the finger.
// The tap lands on the label, the switch toggles and ticks, and we pass the tap on to
// the button as a normal click. On iOS 17.4–26.4, clicking the label from code also
// works, so haptic() still tries that for older phones.

const PREF = 'timekeeper.haptics';

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let enabled = true;
try { enabled = localStorage.getItem(PREF) !== 'off'; } catch { /* private mode */ }

export const hapticsOn = () => enabled;

export function setHaptics(on) {
  enabled = on;
  try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch { /* ignore */ }
}

const patterns = {
  tick: 4,
  light: 10,
  medium: 18,
  heavy: 30,
  success: [12, 70, 20],
  warning: [20, 60, 20],
  error: [30, 50, 30, 50, 30],
};

/* ---------- iPhone: tap overlay ---------- */

// Things that get a tick when tapped.
const TAPPABLE = 'button, .wheel-item, [data-haptic]';

let overlay = null;
let overlayTarget = null;
let removeTimer = 0;
let lastFingerTick = 0;

function buildOverlay() {
  const label = document.createElement('label');
  label.className = 'haptic-overlay';
  label.setAttribute('aria-hidden', 'true');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.append(input);

  label.addEventListener('click', (e) => {
    // The label's own activation sends a click to the switch; ignore that one.
    if (e.target === input) return;
    const target = overlayTarget;
    lastFingerTick = performance.now();
    // Pass the tap on right away, while it still counts as a real tap
    // (copying text, opening the file picker and so on need that).
    if (target && target.isConnected && !target.disabled) target.click();
    // Remove the overlay after the switch has toggled.
    clearTimeout(removeTimer);
    removeTimer = setTimeout(hideOverlay, 0);
  });
  return label;
}

function showOverlay(target) {
  if (!overlay) overlay = buildOverlay();
  const r = target.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  overlayTarget = target;
  Object.assign(overlay.style, {
    left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
  });
  if (!overlay.isConnected) document.body.append(overlay);
  clearTimeout(removeTimer);
}

function hideOverlay() {
  clearTimeout(removeTimer);
  overlay?.remove();
  overlayTarget = null;
}

if (isIOS) {
  document.addEventListener('touchstart', (e) => {
    if (!enabled || e.touches.length > 1) { hideOverlay(); return; }
    const target = e.target.closest?.(TAPPABLE);
    if (!target || target.disabled || target.closest('.haptic-overlay')) { hideOverlay(); return; }
    showOverlay(target);
  }, { capture: true, passive: true });

  // If the touch turned into a scroll (no click came), take the overlay away.
  const later = () => { clearTimeout(removeTimer); removeTimer = setTimeout(hideOverlay, 700); };
  document.addEventListener('touchend', later, { capture: true, passive: true });
  document.addEventListener('touchcancel', hideOverlay, { capture: true, passive: true });
  window.addEventListener('scroll', hideOverlay, { capture: true, passive: true });
}

/* ---------- haptic() ---------- */

// Older iPhones (iOS 17.4–26.4): clicking a switch's label from code plays the tick.
function scriptedIOSTap() {
  const label = document.createElement('label');
  label.ariaHidden = 'true';
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.appendChild(input);
  document.head.appendChild(label);
  label.click();
  label.remove();
}

let lastTick = 0;

export function haptic(kind = 'light') {
  if (!enabled) return;
  try {
    const now = performance.now();
    if (kind === 'tick') {
      if (now - lastTick < 28) return;
      lastTick = now;
    }
    if (isIOS) {
      // A finger tap already ticked for this action.
      if (now - lastFingerTick < 400) return;
      scriptedIOSTap();
    } else if ('vibrate' in navigator) {
      navigator.vibrate(patterns[kind] ?? 10);
    }
  } catch { /* not supported */ }
}
