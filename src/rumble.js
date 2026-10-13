// Rumble as a control channel, PROTOCOL.md §8.8 — the browser's half of
// `firmware/core/rumble.c`, and the arithmetic nobody should do by hand.
//
// An `xinput` board is single-interface and has no config channel (§8.3), so
// during a match the XInput OUT endpoint is the only door and
// `gamepad.rumble(left, right, ms)` is the sanctioned OpMode call that knocks
// on it. It cannot carry text. It carries a number, and a stored picture
// (§14.9) is switched by a number.
//
// Platform-free on purpose: no DOM, no client. `transport/mock.js` decodes
// with it, `screens/configure.js` binds with it, and `tools/test_web.mjs`
// exercises both. One implementation of the encoding per language, the same
// rule `util.js` follows for the CRC — two clients that disagree about what
// byte 136 means is a bug nobody finds until a panel draws the wrong legend.

// shared/protocol.h. 255 / 15 is 17 exactly, which is the whole reason the
// code is 15 steps of 17 rather than the top four bits: every code arrives in
// the middle of a ±8 band instead of on a bucket boundary, where the SDK's own
// double-to-byte rounding would decide the answer.
export const RUMBLE_CODE_MAX = 15;
export const RUMBLE_CODE_STEP = 17;

// RUMBLE_CODE(v) from shared/protocol.h: ((v) + 17/2) / 17 in C, which is
// integer division of a non-negative value, so Math.floor is the same thing.
export const codeOfByte = (v) => Math.floor((v + (RUMBLE_CODE_STEP >> 1)) / RUMBLE_CODE_STEP);

// The byte a code becomes on the wire, and the double an OpMode passes to get
// it there. `sdkByte` is the SDK's own conversion, copied from
// `Gamepad.RumbleEffect.Builder`: Math.round(Range.scale(clip(v,0,1),0,1,0,255)).
// c/15.0 × 255 is exactly c × 17 in IEEE doubles for every code 1..15, so the
// three agree and `tools/test_web.mjs` asserts that they do.
export const wireByte = (code) => code * RUMBLE_CODE_STEP;
export const sendValue = (code) => code / RUMBLE_CODE_MAX;
export const sdkByte = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);

// XInput OUT packets (§8.5). Built here rather than in the mock so the fake
// board is fed the same bytes a Driver Station would put on the endpoint.
export const rumblePacket = (left, right) => [0x00, 0x08, 0x00, left & 0xff, right & 0xff, 0, 0, 0];
export const playerPacket = (n) => [0x01, 0x03, (n + 1) & 0xff];

/**
 * Decode one OUT packet, exactly as `rumble_decode()` does.
 * Returns {kind:'motor', left, right, code} | {kind:'player', n} | {kind:'none'}.
 * `n` is 0 for an index that is not one of the four player slots (the boot
 * animations, "off"), which §8.5 gives nothing to report.
 */
export function decodeXinputOut(data) {
  const d = Array.from(data ?? []);
  if (d.length < 2) return { kind: 'none' };
  if (d[0] === 0x00 && d[1] === 0x08 && d.length >= 8) {
    return { kind: 'motor', left: d[3], right: d[4], code: codeOfByte(d[3]) };
  }
  if (d[0] === 0x01 && d[1] === 0x03 && d.length >= 3) {
    const nn = d[2];
    return { kind: 'player', n: nn >= 2 && nn <= 5 ? nn - 1 : nn >= 6 && nn <= 9 ? nn - 5 : 0 };
  }
  return { kind: 'none' };
}

// ---- the map's `rumble` section (§9.5) ------------------------------------

// Two kinds of entry share the section (§8.8, rev 0.33): a **legend** names
// {code, addr, slot}, an **LED action** names {code, btn, rgb[, fx]}. Every
// helper below works on one kind and carries the other through untouched —
// a legend helper that dropped a code's LED entries would be a map edit
// nobody asked for.
export const isLedEntry = (e) => e != null && typeof e === 'object' && ('btn' in e || 'rgb' in e);
const allOf = (list) => (Array.isArray(list) ? list : []);

// The section's legend entries.
export const bindsOf = (map) => allOf(map?.rumble).filter(e => !isLedEntry(e));

// Most LED entries a map may carry: MAP_RUMBLE_LED_MAX in firmware/core/map.h.
export const RUMBLE_LED_MAX = 32;
export const LED_FX = ['solid', 'blink', 'fast', 'breathe'];

/**
 * The legend entry a code names, or null.
 *
 * **Code 0 never matches, whatever the table says.** `rumble(0, 0, ms)` is how
 * the SDK stops a rumble, and stopping a rumble must not change what is on a
 * screen (§8.8). `rumble_lookup()` refuses it in the firmware and so does
 * this, rather than trusting every caller to check first.
 */
export function bindFor(map, code) {
  if (!(code >= 1 && code <= RUMBLE_CODE_MAX)) return null;
  return bindsOf(map).find(b => b.code === code) ?? null;
}

/**
 * §9.5's validation of the section, returning the error the board would give
 * (`rumble`) or null. Kept here so the UI can refuse a duplicate before it is
 * sent and the mock can refuse one the way the module does — the same rule
 * from both sides, which is the only way the UI's enforcement is testable.
 */
export function validateBinds(list) {
  if (list == null) return null;
  if (!Array.isArray(list)) return 'rumble';
  const seen = new Set(), seenLed = new Set();
  let leds = 0;
  for (const b of list) {
    if (!b || typeof b !== 'object') return 'rumble';
    const { code } = b;
    if (!Number.isInteger(code) || code < 1 || code > RUMBLE_CODE_MAX) return 'rumble';
    if (isLedEntry(b)) {
      // an LED action: one kind or the other, one per (code, btn)
      const { btn, rgb, fx } = b;
      if ('addr' in b || 'slot' in b) return 'rumble';
      if (!Number.isInteger(btn) || btn < 1 || btn > 32) return 'rumble';
      if (!(rgb === 'off' || rgb === 'map' || (typeof rgb === 'string' && /^[0-9a-fA-F]{6}$/.test(rgb)))) return 'rumble';
      if (fx !== undefined && !LED_FX.includes(fx)) return 'rumble';
      if (seenLed.has(`${code}:${btn}`)) return 'rumble';
      seenLed.add(`${code}:${btn}`);
      if (++leds > RUMBLE_LED_MAX) return 'rumble';
      continue;
    }
    const { addr, slot } = b;
    if (!Number.isInteger(addr) || addr < 1 || addr > 31) return 'rumble';
    if (!Number.isInteger(slot) || slot < 0 || slot > 254) return 'rumble';
    if (seen.has(code)) return 'rumble';       // at most one legend per code
    seen.add(code);
  }
  return null;
}

/**
 * The section in the firmware's canonical order (map.c): legend entries
 * first, then LED actions. Each kind is sorted here — legends by code, LED
 * actions by code then button — so `map get` comes back in the order the
 * inspector lists them, and a map this page sends is the map it reads back.
 */
const canonical = (list) => [
  ...allOf(list).filter(e => !isLedEntry(e)).sort((a, b) => a.code - b.code),
  ...allOf(list).filter(isLedEntry).sort((a, b) => a.code - b.code || a.btn - b.btn),
];

/**
 * The list with `code`'s legend bound to (addr, slot) — replacing whatever
 * legend was on that code, because one per code is the rule and the UI
 * enforces it here rather than letting the board reject the map. The code's
 * LED actions stay.
 */
export function withBind(list, code, addr, slot) {
  return canonical([...allOf(list).filter(b => isLedEntry(b) || b.code !== code), { code, addr, slot }]);
}

export function withoutBind(list, code) {
  return canonical(allOf(list).filter(b => isLedEntry(b) || b.code !== code));
}

// ---- LED actions (§8.8, rev 0.33) ------------------------------------------

/** A map's LED actions, optionally only one button's or one code's. */
export function ledActionsOf(map, { btn, code } = {}) {
  return allOf(map?.rumble).filter(e => isLedEntry(e) &&
    (btn === undefined || e.btn === btn) && (code === undefined || e.code === code));
}

/**
 * The list with `code` setting `btn` to `rgb` (6 hex, `off` or `map`),
 * replacing that pair's entry if it had one. `fx` is dropped when it is
 * `solid` or the colour is `map`, which is how the firmware emits it.
 */
export function withLedAction(list, code, btn, rgb, fx = 'solid') {
  const e = { code, btn, rgb: rgb === 'off' || rgb === 'map' ? rgb : rgb.toUpperCase() };
  if (rgb !== 'map' && fx && fx !== 'solid') e.fx = fx;
  return canonical([...allOf(list).filter(x => !(isLedEntry(x) && x.code === code && x.btn === btn)), e]);
}

export function withoutLedAction(list, code, btn) {
  return canonical(allOf(list).filter(x => !(isLedEntry(x) && x.code === code && x.btn === btn)));
}

/**
 * What a code does to the live LED layer, as `lineproto.c`'s rumble_leds()
 * does it: each entry is `led <btn> <rgb> [fx]`, and `map` drops the button's
 * override. `live` is a Map of btn -> {rgb, fx}; returns the buttons touched.
 */
export function applyLedActions(map, code, live) {
  if (!(code >= 1 && code <= RUMBLE_CODE_MAX)) return [];
  const touched = [];
  for (const e of ledActionsOf(map, { code })) {
    if (e.rgb === 'map') live.delete(e.btn);
    else live.set(e.btn, { rgb: e.rgb === 'off' ? '000000' : e.rgb.toUpperCase(), fx: e.fx ?? 'solid' });
    touched.push(e.btn);
  }
  return touched;
}

// ---- what a team types into an OpMode -------------------------------------

// `robot/ftc/`'s wrapper. A user should never have to compute c / 15.0 by
// hand, which is exactly what the config screen is for.
export const showLegendCall = (code) => `board.showLegend(${code});`;

// The call underneath it, for someone who has not copied the wrapper in — and
// for anyone checking the arithmetic against §8.8's table.
export const rawRumbleCall = (code, ms = 100) =>
  `gamepad1.rumble(${code} / 15.0, 0, ${ms});   // byte ${wireByte(code)}`;
