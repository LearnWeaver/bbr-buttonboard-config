// Rumble as a control channel, PROTOCOL.md §8.8 — the browser's half of
// `firmware/core/rumble.c`, and the arithmetic nobody should do by hand.
//
// An `xinput` board is single-interface and has no config channel (§8.3), so
// during a match the XInput OUT endpoint is the only door and
// `gamepad.rumble(left, right, ms)` is the sanctioned OpMode call that knocks
// on it. It cannot carry text. It carries a number, and a stored picture
// (§14.9) or a prewritten message (rev 0.36) is switched by a number.
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

// Three kinds of entry share the section (§8.8): a **legend** names
// {code, addr, slot}, a **message** (rev 0.36) names {code, addr, rows[,
// attrs]}, and an **LED action** (rev 0.33) names {code, btn, rgb[, fx]}.
// Every helper below works on one kind and carries the others through
// untouched — a legend helper that dropped a code's LED entries would be a
// map edit nobody asked for.
export const isLedEntry = (e) => e != null && typeof e === 'object' && ('btn' in e || 'rgb' in e);
export const isTextEntry = (e) => e != null && typeof e === 'object' && !isLedEntry(e) && ('rows' in e || 'attrs' in e);
const isLegend = (e) => !isLedEntry(e) && !isTextEntry(e);
const allOf = (list) => (Array.isArray(list) ? list : []);

// The section's legend entries.
export const bindsOf = (map) => allOf(map?.rumble).filter(isLegend);

// Most LED entries a map may carry: MAP_RUMBLE_LED_MAX in firmware/core/map.h.
export const RUMBLE_LED_MAX = 32;
export const LED_FX = ['solid', 'blink', 'fast', 'breathe'];
// Messages: MAP_RUMBLE_TEXT_MAX, and DISP_MAX_ROWS / DISP_MAX_COLS from
// shared/protocol.h. The panel clips a message to its own size.
export const RUMBLE_TEXT_MAX = 32;
export const TEXT_ROWS_MAX = 8;
export const TEXT_COLS_MAX = 32;
// MAP_JSON_MAX: the canonical map JSON, NUL included, has to fit one flash
// record, and `map set` refuses one that would not with `line_too_long`.
export const MAP_JSON_MAX = 4064;
export const mapFits = (map) => JSON.stringify(map).length < MAP_JSON_MAX;

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
  const seen = new Set(), seenLed = new Set(), seenText = new Set(), legendAt = new Set();
  let leds = 0, texts = 0;
  for (const b of list) {
    if (!b || typeof b !== 'object') return 'rumble';
    const { code } = b;
    if (!Number.isInteger(code) || code < 1 || code > RUMBLE_CODE_MAX) return 'rumble';
    if (isLedEntry(b)) {
      // an LED action: one kind or the other, one per (code, btn)
      const { btn, rgb, fx } = b;
      if ('addr' in b || 'slot' in b || 'rows' in b || 'attrs' in b) return 'rumble';
      if (!Number.isInteger(btn) || btn < 1 || btn > 32) return 'rumble';
      if (!(rgb === 'off' || rgb === 'map' || (typeof rgb === 'string' && /^[0-9a-fA-F]{6}$/.test(rgb)))) return 'rumble';
      if (fx !== undefined && !LED_FX.includes(fx)) return 'rumble';
      if (seenLed.has(`${code}:${btn}`)) return 'rumble';
      seenLed.add(`${code}:${btn}`);
      if (++leds > RUMBLE_LED_MAX) return 'rumble';
      continue;
    }
    const { addr } = b;
    if (!Number.isInteger(addr) || addr < 1 || addr > 31) return 'rumble';
    if (isTextEntry(b)) {
      // a message: rows of printable ASCII, attrs one per row if given, one
      // per (code, tile), and not on a tile the code shows a picture on
      const { rows, attrs } = b;
      if ('slot' in b) return 'rumble';
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > TEXT_ROWS_MAX) return 'rumble';
      if (!rows.every(r => typeof r === 'string' && r.length <= TEXT_COLS_MAX && /^[ -~]*$/.test(r))) return 'rumble';
      if (attrs !== undefined && (!Array.isArray(attrs) || attrs.length !== rows.length ||
          !attrs.every(a => Number.isInteger(a) && a >= 0 && a <= 255))) return 'rumble';
      if (seenText.has(`${code}:${addr}`)) return 'rumble';
      seenText.add(`${code}:${addr}`);
      if (++texts > RUMBLE_TEXT_MAX) return 'rumble';
      continue;
    }
    const { slot } = b;
    if (!Number.isInteger(slot) || slot < 0 || slot > 254) return 'rumble';
    if (seen.has(code)) return 'rumble';       // at most one legend per code
    seen.add(code);
    legendAt.add(`${code}:${addr}`);
  }
  for (const k of seenText) if (legendAt.has(k)) return 'rumble';
  return null;
}

/**
 * The section in the firmware's canonical order (map.c): legend entries
 * first, then messages, then LED actions. Each kind is sorted here — legends
 * by code, messages by code then tile, LED actions by code then button — so
 * `map get` comes back in the order the inspector lists them, and a map this
 * page sends is the map it reads back.
 */
const canonical = (list) => [
  ...allOf(list).filter(isLegend).sort((a, b) => a.code - b.code),
  ...allOf(list).filter(isTextEntry).sort((a, b) => a.code - b.code || a.addr - b.addr),
  ...allOf(list).filter(isLedEntry).sort((a, b) => a.code - b.code || a.btn - b.btn),
];

/**
 * The list with `code`'s legend bound to (addr, slot) — replacing whatever
 * legend was on that code, because one per code is the rule and the UI
 * enforces it here rather than letting the board reject the map. The code's
 * LED actions and its messages for other tiles stay; a message for the same
 * tile goes, since the two would race for one panel.
 */
export function withBind(list, code, addr, slot) {
  return canonical([...allOf(list).filter(b => !(isLegend(b) && b.code === code) &&
    !(isTextEntry(b) && b.code === code && b.addr === addr)), { code, addr, slot }]);
}

export function withoutBind(list, code) {
  return canonical(allOf(list).filter(b => !(isLegend(b) && b.code === code)));
}

// ---- messages (§8.8, rev 0.36) ---------------------------------------------

/** A map's messages, optionally only one tile's or one code's. */
export function textsOf(map, { addr, code } = {}) {
  return allOf(map?.rumble).filter(e => isTextEntry(e) &&
    (addr === undefined || e.addr === addr) && (code === undefined || e.code === code));
}

export const textFor = (map, code, addr) => textsOf(map, { code, addr })[0] ?? null;

/**
 * The list with `code` writing `rows` (and `attrs`, one per row) to tile
 * `addr`, replacing that pair's message and any picture legend the code had
 * on the same tile. Trailing blank rows are dropped, and `attrs` too when
 * every row is plain, which is how the firmware emits it.
 */
export function withText(list, code, addr, rows, attrs = []) {
  let n = rows.length;
  while (n > 1 && !rows[n - 1] && !(attrs[n - 1] ?? 0)) n--;
  const e = { code, addr, rows: rows.slice(0, n) };
  const a = Array.from({ length: n }, (_, i) => attrs[i] ?? 0);
  if (a.some(Boolean)) e.attrs = a;
  return canonical([...allOf(list).filter(x =>
    !(isTextEntry(x) && x.code === code && x.addr === addr) &&
    !(isLegend(x) && x.code === code && x.addr === addr)), e]);
}

export function withoutText(list, code, addr) {
  return canonical(allOf(list).filter(x => !(isTextEntry(x) && x.code === code && x.addr === addr)));
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

/** Every code the map gives any action at all, ascending. */
export function usedCodes(map) {
  return [...new Set(allOf(map?.rumble).map(e => e.code))].filter(c => c >= 1 && c <= RUMBLE_CODE_MAX).sort((a, b) => a - b);
}

// The call underneath it, for someone who has not copied the wrapper in — and
// for anyone checking the arithmetic against §8.8's table.
export const rawRumbleCall = (code, ms = 100) =>
  `gamepad1.rumble(${code} / 15.0, 0, ${ms});   // byte ${wireByte(code)}`;
