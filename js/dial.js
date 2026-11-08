// The 24-hour watch-face dial on the Clock tab, and the small day timelines in History.
// Noon is at the top, midnight at the bottom, so a daytime shift arcs across the top.

const C = 150;
const R = 128;

const angleOf = (ms, dayStart) => (((ms - dayStart) / 86400000) * 360 + 180) % 360;

function pt(deg, r) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

function arcPath(a0, sweep, r) {
  const s = Math.min(sweep, 359.8);
  const [x0, y0] = pt(a0, r);
  const [x1, y1] = pt(a0 + s, r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${s > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function segPaths(list, dayStart, cls) {
  return list.map(([a, b]) => {
    const sweep = ((b - a) / 86400000) * 360;
    if (sweep <= 0.05) return '';
    return `<path class="${cls}" d="${arcPath(angleOf(a, dayStart), sweep, R)}"/>`;
  }).join('');
}

let ticksCache = '';
function ticks() {
  if (ticksCache) return ticksCache;
  let s = '';
  for (let i = 0; i < 96; i++) {
    const deg = (i / 96) * 360;
    const hour = i % 4 === 0;
    const major = i % 24 === 0;
    const r0 = major ? 99 : hour ? 103 : 107;
    const [x0, y0] = pt(deg, r0);
    const [x1, y1] = pt(deg, 111);
    s += `<line class="${major ? 'tk-major' : hour ? 'tk-hour' : 'tk-min'}" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
  }
  const labels = [['12p', 0], ['6p', 90], ['12a', 180], ['6a', 270]];
  for (const [t, deg] of labels) {
    const [x, y] = pt(deg, 86);
    s += `<text class="tk-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${t}</text>`;
  }
  ticksCache = s;
  return s;
}

export function dialSVG({ work, brk, dayStart, now, state }) {
  const [nx, ny] = pt(angleOf(now, dayStart), R);
  return `
    <svg viewBox="0 0 300 300" class="dial-svg" data-state="${state}" role="img" aria-label="Today's hours on a 24-hour dial">
      <circle class="dial-track" cx="${C}" cy="${C}" r="${R}"/>
      ${ticks()}
      ${segPaths(work, dayStart, 'seg-work')}
      ${segPaths(brk, dayStart, 'seg-break')}
      <circle class="now-halo" cx="${nx.toFixed(2)}" cy="${ny.toFixed(2)}" r="13"/>
      <circle class="now-dot" cx="${nx.toFixed(2)}" cy="${ny.toFixed(2)}" r="5.5"/>
    </svg>`;
}

// A horizontal bar for one day. `range` is [startMs, endMs] of the visible window.
export function timeline(work, brk, [r0, r1]) {
  const span = r1 - r0;
  const seg = (list, cls) => list.map(([a, b]) => {
    const left = Math.max(0, ((a - r0) / span) * 100);
    const width = Math.max(0.8, ((Math.min(b, r1) - Math.max(a, r0)) / span) * 100);
    return `<span class="${cls}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></span>`;
  }).join('');
  return `<div class="tl" aria-hidden="true">${seg(work, 'tl-work')}${seg(brk, 'tl-break')}</div>`;
}
