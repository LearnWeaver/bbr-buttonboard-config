// The sim personality (PROTOCOL.md §8.11, rev 0.51): every key its own
// button, numbered tile by tile in address order, and the map's `sim` section
// (the hat and the toggles). The numbering mirrors firmware/core/simout.c, so
// the page shows the number the game will see; tools/test_web.mjs holds the
// type table to simout.c's. Platform-free, so the mock validates with it too.

export const SIM_BUTTONS = 128;
export const SIM_AXES = 8;
export const SIM_TOGGLE_MAX = 32;
export const HAT_DIRS = ['up', 'right', 'down', 'left'];

// [keys, encoders] for a tile not seen since power-up: §8.11's table
export const TYPE_COUNTS = {
  mx9: [9, 0], mx9rgb: [9, 0], mx6: [6, 0], mx6rgb: [6, 0], mx4: [4, 0], arc4: [4, 0], arc8: [8, 0], mx3: [3, 0],
  mx1: [1, 0], enc2: [2, 2], enc1: [1, 1], stick1: [1, 0], screenkey1: [1, 0], disp1: [0, 0], disp2: [0, 0], seg2: [0, 0], seg4: [0, 0],
};

/**
 * Where each tile's buttons start, from `tiles` (every entry is an address
 * that holds a tile, online or cached). -> Map addr -> { first, keys, enc },
 * first 0 when it starts past 128.
 */
export function simLayout(tiles) {
  const out = new Map();
  let next = 1;
  for (const t of [...(tiles ?? [])].sort((a, b) => a.addr - b.addr)) {
    const seen = (t.keys ?? 0) > 0 || (t.enc ?? 0) > 0;
    const [keys, enc] = seen ? [t.keys ?? 0, t.enc ?? 0] : (TYPE_COUNTS[t.type] ?? [0, 0]);
    out.set(t.addr, { first: next <= SIM_BUTTONS ? next : 0, keys, enc });
    next += keys + 2 * enc;
  }
  return out;
}

const nth = (e, off) => (e?.first && e.first + off <= SIM_BUTTONS ? e.first + off : 0);

/** Key k's button on tile addr, 0 if none. */
export function simKeyButton(layout, addr, k) {
  const e = layout.get(addr);
  return e && k < e.keys ? nth(e, k) : 0;
}

/** Encoder idx's turn button (ccw false = clockwise), 0 if none. */
export function simEncButton(layout, addr, idx, ccw) {
  const e = layout.get(addr);
  return e && idx < e.enc ? nth(e, e.keys + 2 * idx + (ccw ? 1 : 0)) : 0;
}

const sim = (map) => map?.sim ?? {};
/** The hat direction ('up'...) button `btn` drives in this map, or null. */
export const hatDirOf = (map, btn) => { const i = (sim(map).hat ?? []).indexOf(btn); return btn && i >= 0 ? HAT_DIRS[i] : null; };
export const isToggle = (map, btn) => (sim(map).toggle ?? []).includes(btn);

// The section as map.c hands it back: no all-zero hat, no empty toggle list, no empty section.
function tidy(m) {
  const s = m.sim ?? {};
  if (s.hat && !s.hat.some(Boolean)) delete s.hat;
  if (s.toggle && !s.toggle.length) delete s.toggle;
  if (Object.keys(s).length) m.sim = s; else delete m.sim;
  return m;
}

/** The map with button `btn` on hat direction `dir` ('up'..., or null to take it off the hat). Not a toggle any more. */
export function withHatDir(map, btn, dir) {
  const m = structuredClone(map ?? { v: 1, bind: [] });
  const s = { ...(m.sim ?? {}) };
  const hat = [...(s.hat ?? [0, 0, 0, 0])].map(b => (b === btn ? 0 : b));
  if (dir) hat[HAT_DIRS.indexOf(dir)] = btn;
  s.hat = hat;
  if (dir) s.toggle = (s.toggle ?? []).filter(b => b !== btn);
  m.sim = s;
  return tidy(m);
}

/** The map with button `btn` a toggle or not. A toggle leaves the hat. */
export function withToggle(map, btn, on) {
  let m = structuredClone(map ?? { v: 1, bind: [] });
  if (on) m = withHatDir(m, btn, null);
  const s = { ...(m.sim ?? {}) };
  const t = (s.toggle ?? []).filter(b => b !== btn);
  if (on) t.push(btn);
  s.toggle = t;
  m.sim = s;
  return tidy(m);
}

/** map.c's check of a `sim` section: { err: 'sim' } or { canonical }. */
export function simCheck(sec) {
  if (sec === undefined) return { canonical: undefined };
  if (typeof sec !== 'object' || sec === null || Array.isArray(sec)) return { err: 'sim' };
  const seen = new Set(), out = {};
  const ok = (b, zero) => Number.isInteger(b) && b <= SIM_BUTTONS && (zero ? b >= 0 : b >= 1);
  if (sec.hat !== undefined) {
    if (!Array.isArray(sec.hat) || sec.hat.length !== 4 || !sec.hat.every(b => ok(b, true))) return { err: 'sim' };
    for (const b of sec.hat) { if (b && seen.has(b)) return { err: 'sim' }; if (b) seen.add(b); }
    if (sec.hat.some(Boolean)) out.hat = [...sec.hat];
  }
  if (sec.toggle !== undefined) {
    if (!Array.isArray(sec.toggle) || sec.toggle.length > SIM_TOGGLE_MAX || !sec.toggle.every(b => ok(b, false))) return { err: 'sim' };
    for (const b of sec.toggle) { if (seen.has(b)) return { err: 'sim' }; seen.add(b); }
    if (sec.toggle.length) out.toggle = [...sec.toggle];
  }
  return { canonical: Object.keys(out).length ? out : undefined };
}
