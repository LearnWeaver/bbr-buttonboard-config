// Analog sticks (PROTOCOL.md §17): the map's `stick` section, the four frc
// axes sticks share with encoders, and §17.3's output arithmetic.
//
// Platform-free: no DOM, no client. Configure edits the map through these and
// pushes it with `map set`; the mock computes a stick's output with the same
// `stickOutput` the firmware's stickout.c implements; `tools/test_web.mjs`
// exercises all of it.

// shared/protocol.h. test_web.mjs reads the header and checks every one.
export const STICK_AXIS_FULL = 32767;
export const STICK_CAL_LO = 0;
export const STICK_CAL_MID = 32768;
export const STICK_CAL_HI = 65535;
export const STICK_CAL_MIN_TRAVEL = 8192;
export const STICK_DEADZONE_FRC = 8;
export const STICK_DEADZONE_XINPUT = 0;
export const STICK_DEADZONE_MAX = 50;

export const AXES = [1, 2, 3, 4];                // ENC_AXIS_COUNT: encoders and sticks share them
export const SIDES = ['left', 'right'];

// Axes come in pairs, 2i and 2i+1 (§17.2), so `axes` 2 is one stick.
export const stickCount = (tile) => Math.floor((tile?.axes ?? 0) / 2);

export const stickAt = (map, addr, idx) =>
  (map?.stick ?? []).find(s => s.addr === addr && (s.idx ?? 0) === idx);

// The personality's deadzone when the entry gives none (§17.3).
export const defaultDeadzone = (usb) => usb === 'xinput' ? STICK_DEADZONE_XINPUT : STICK_DEADZONE_FRC;

/**
 * Who holds frc axis `axis`: `{kind:'enc', addr, idx}`, `{kind:'stick', addr,
 * idx, which:'x'|'y'}` or null. One question for both kinds of control because
 * `dup_axis` spans both (§17.4): an inspector that only looked at encoders
 * would offer an axis a stick already holds, and the board would refuse it.
 */
export function axisOwner(map, axis) {
  const e = (map?.enc ?? []).find(x => x.axis === axis);
  if (e) return { kind: 'enc', addr: e.addr, idx: e.idx };
  for (const s of map?.stick ?? []) {
    if (s.x === axis) return { kind: 'stick', addr: s.addr, idx: s.idx ?? 0, which: 'x' };
    if (s.y === axis) return { kind: 'stick', addr: s.addr, idx: s.idx ?? 0, which: 'y' };
  }
  return null;
}

export const ownerName = (o) => o.kind === 'enc'
  ? `tile ${o.addr} ENC${o.idx + 1}`
  : `tile ${o.addr} stick${o.idx ? ` ${o.idx + 1}` : ''} ${o.which.toUpperCase()}`;

const isOwner = (o, kind, addr, idx) => !!o && o.kind === kind && o.addr === addr && o.idx === idx;

// The stick holding xinput side `side`, or undefined.
export const sideOwner = (map, side) => (map?.stick ?? []).find(s => s.xinput === side);

// An encoder entry with nothing left binds nothing and the board refuses it
// (§15.7). A stick entry with no output is allowed (§17.6), and is kept while
// it carries anything of its own — a calibration, an invert, a deadzone — so
// choosing those before choosing an output is not undone by the next push.
const encLive = (e) => e.axis || e.cw || e.ccw || e.trigger;
const stickLive = (s) => s.x || s.xinput || s.cal || s.invertX || s.invertY || s.deadzone != null;

function tidy(map) {
  if (map.enc) { map.enc = map.enc.filter(encLive); if (!map.enc.length) delete map.enc; }
  if (map.stick) { map.stick = map.stick.filter(stickLive); if (!map.stick.length) delete map.stick; }
  return map;
}

// The entry for (addr, idx), created bare if there is none, as map_stick_get.
function entryOf(map, addr, idx) {
  map.stick = map.stick ?? [];
  let s = map.stick.find(x => x.addr === addr && (x.idx ?? 0) === idx);
  if (!s) { s = { addr, idx, invertX: false, invertY: false }; map.stick.push(s); }
  return s;
}

/**
 * Put stick (addr, idx) on frc axes x and y, taking them off whatever held
 * them: an encoder loses its axis, another stick loses both of its, because x
 * and y go together. The same thing `bind stick <x> <y>` does on the board
 * (map_bind_stick_axes), so a map built here and one built by bind mode agree.
 * Returns a new map; `taken` lists the owners it displaced, for the status line.
 */
export function withStickAxes(map, addr, idx, x, y) {
  const m = structuredClone(map ?? { v: 1, bind: [] });
  const taken = [];
  for (const ax of [x, y]) {
    const o = axisOwner(m, ax);
    if (!o || isOwner(o, 'stick', addr, idx)) continue;
    taken.push(o);
    if (o.kind === 'enc') {
      const e = m.enc.find(v => v.addr === o.addr && v.idx === o.idx);
      delete e.axis;
    } else {
      const s = m.stick.find(v => v.addr === o.addr && (v.idx ?? 0) === o.idx);
      delete s.x; delete s.y;
    }
  }
  const s = entryOf(m, addr, idx);
  s.x = x; s.y = y;
  return { map: tidy(m), taken };
}

// Take stick (addr, idx) off the frc axes, leaving its xinput side.
export function withoutStickAxes(map, addr, idx) {
  const m = structuredClone(map);
  const s = stickAt(m, addr, idx);
  if (s) { delete s.x; delete s.y; }
  return tidy(m);
}

/**
 * Give stick (addr, idx) xinput side `side` ('left' or 'right'), or none with
 * null. A side has one stick (§17.5), so the stick that had it loses it — as
 * `bind stick <side>` does (map_bind_stick_side). `taken` is that stick.
 */
export function withStickSide(map, addr, idx, side) {
  const m = structuredClone(map ?? { v: 1, bind: [] });
  let taken = null;
  if (side) {
    const o = sideOwner(m, side);
    if (o && !(o.addr === addr && (o.idx ?? 0) === idx)) { taken = { addr: o.addr, idx: o.idx ?? 0 }; delete o.xinput; }
    entryOf(m, addr, idx).xinput = side;
  } else {
    const s = stickAt(m, addr, idx);
    if (s) delete s.xinput;
  }
  return { map: tidy(m), taken };
}

// `unbind stick`: no outputs, and the entry goes unless it has a calibration
// to keep (map_unbind_stick), inverts and deadzone with it.
export function withoutStickOutputs(map, addr, idx) {
  const m = structuredClone(map);
  const s = stickAt(m, addr, idx);
  if (s) {
    delete s.x; delete s.y; delete s.xinput;
    if (!s.cal) m.stick = m.stick.filter(v => v !== s);
  }
  return tidy(m);
}

/**
 * Set one of the stick's own fields: `invertX`, `invertY`, or `deadzone`
 * (a percent, or null for the personality's default).
 */
export function withStickField(map, addr, idx, field, value) {
  const m = structuredClone(map ?? { v: 1, bind: [] });
  const s = entryOf(m, addr, idx);
  if (field === 'deadzone' && value == null) delete s.deadzone;
  else s[field] = value;
  return tidy(m);
}

// What the stick does now, in a few words, for the diagram.
export function stickSummary(s) {
  if (!s) return '—';
  const parts = [];
  if (s.xinput) parts.push(s.xinput === 'left' ? 'Left' : 'Right');
  if (s.x) parts.push(`Axes ${s.x}·${s.y}`);
  return parts.join(' · ') || (s.cal ? 'calibrated' : '—');
}

/**
 * §17.3: raw readings [x, y] to the stick's output, X right and Y up, before
 * the personality's sign rule. Integer arithmetic in the same order as
 * stick_apply() in firmware/core/stickout.c, truncating toward zero where C
 * does, so the mock reports what a board would.
 */
export function stickOutput(raw, entry, usb) {
  const full = STICK_AXIS_FULL;
  const clamp = (v) => Math.max(-full, Math.min(full, v));
  const cal = entry?.cal ?? [STICK_CAL_LO, STICK_CAL_MID, STICK_CAL_HI, STICK_CAL_LO, STICK_CAL_MID, STICK_CAL_HI];
  const v = [0, 1].map(a => {
    const [lo, mid, hi] = cal.slice(3 * a, 3 * a + 3), r = raw[a];
    if (r >= mid) return hi > mid ? clamp(Math.trunc((r - mid) * full / (hi - mid))) : 0;
    return mid > lo ? clamp(-Math.trunc((mid - r) * full / (mid - lo))) : 0;
  });
  if (entry?.invertX) v[0] = -v[0];
  if (entry?.invertY) v[1] = -v[1];
  const dz = entry?.deadzone ?? defaultDeadzone(usb);
  if (dz) {
    const d = Math.trunc(dz * full / 100);
    const m = Math.floor(Math.sqrt(v[0] * v[0] + v[1] * v[1]));
    if (m <= d) return [0, 0];
    const num = (m - d) * full, den = (full - d) * m;
    return v.map(x => clamp(Number(BigInt(x) * BigInt(num) / BigInt(den))));
  }
  return v.map(x => x || 0);
}

/**
 * A calibration in progress, as this page sees it: the rest reading taken at
 * `stick cal`, widened by every reading since. The board keeps its own copy
 * and that is the one `stick cal done` writes; this one only drives the
 * progress display, so it is fed from the 250 ms `tiles` poll and can miss an
 * extreme the board caught. That errs the safe way: the page may say "not yet"
 * when the board would accept, never the reverse.
 */
export function calStart(raw) {
  return { rest: [raw[0], raw[1]], lo: [raw[0], raw[1]], hi: [raw[0], raw[1]] };
}
export function calFeed(c, raw) {
  for (let a = 0; a < 2; a++) {
    if (raw[a] < c.lo[a]) c.lo[a] = raw[a];
    if (raw[a] > c.hi[a]) c.hi[a] = raw[a];
  }
  return c;
}
// Per axis, how far each way as a fraction of STICK_CAL_MIN_TRAVEL (capped at 1).
export function calProgress(c) {
  const f = (v) => Math.min(1, v / STICK_CAL_MIN_TRAVEL);
  return [0, 1].map(a => ({ low: f(c.rest[a] - c.lo[a]), high: f(c.hi[a] - c.rest[a]) }));
}
export const calReady = (c) => calProgress(c).every(p => p.low >= 1 && p.high >= 1);
