// Haptic feedback.
// Android and other browsers: navigator.vibrate().
// iPhone (iOS 18+): Safari has no vibrate(), but tapping an <input type="checkbox" switch>
// plays the system haptic, so we click a hidden one.

const PREF = 'timekeeper.haptics';

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
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
const iosTaps = { success: 2, warning: 2, error: 3 };

function iosTap() {
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
    if (kind === 'tick') {
      const now = performance.now();
      if (now - lastTick < 28) return;
      lastTick = now;
    }
    if (isIOS) {
      iosTap();
      const extra = (iosTaps[kind] || 1) - 1;
      for (let i = 1; i <= extra; i++) setTimeout(iosTap, i * 110);
    } else if ('vibrate' in navigator) {
      navigator.vibrate(patterns[kind] ?? 10);
    }
  } catch { /* not supported */ }
}
