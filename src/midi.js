// The midi personality's actions (PROTOCOL.md §8.10, rev 0.50): the map's
// `midi` section, what each logical button sends as a note, a controller or a
// program change, and an encoder's relative CC. The grammar and canonical form
// mirror firmware/core/midiout.c; the tests (tools/test_web.mjs) hold them
// together. Platform-free, so the mock validates with it too.

export const MIDI_ACTION_MAX = 16;              // protocol.h MIDI_ACTION_MAX
export const KINDS = [['note', 'Note'], ['cc', 'Controller (CC)'], ['pc', 'Program change']];

/** Parse one action as midiout.c does: { kind: 'none'|'note'|'cc'|'pc', num, ch (1..16) } or null. */
export function parseMidi(input) {
  const s = String(input ?? '').toLowerCase();
  if (s === '') return { kind: 'none' };
  if (s.length > MIDI_ACTION_MAX) return null;
  const m = /^(note|cc|pc):(0|[1-9][0-9]{0,2})(?:@([1-9][0-9]?))?$/.exec(s);
  if (!m || +m[2] > 127 || (m[3] !== undefined && +m[3] > 16)) return null;
  return { kind: m[1], num: +m[2], ch: m[3] === undefined ? 1 : +m[3] };
}

/** The canonical string of a parsed action, '' for none: "note:60", "cc:64@2". */
export function formatMidi(a) {
  if (!a || a.kind === 'none') return '';
  return `${a.kind}:${a.num}${a.ch && a.ch !== 1 ? `@${a.ch}` : ''}`;
}

/** canonicalMidi(s): the form the board hands back, or null if s is not an action. */
export function canonicalMidi(s) {
  const a = parseMidi(s);
  return a ? formatMidi(a) : null;
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** A note number's name, middle C (60) as C4, the way most programs other than Ableton and FL call it. */
export const noteName = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/** How an action reads on the page: "Note C4 (60)", "CC 64, channel 2". */
export function midiText(s) {
  const a = parseMidi(s);
  if (!a || a.kind === 'none') return 'nothing';
  const ch = a.ch !== 1 ? `, channel ${a.ch}` : '';
  if (a.kind === 'note') return `Note ${noteName(a.num)} (${a.num})${ch}`;
  if (a.kind === 'cc') return `CC ${a.num}${ch}`;
  return `Program ${a.num}${ch}`;
}

/** The action button `btn` sends under midi in this map, canonical, or ''. */
export const midiOf = (map, btn) => map?.midi?.[btn] ?? '';

/** The map with button `btn` sending `action` under midi; '' removes it, and an empty section goes. Throws if not an action. */
export function withMidi(map, btn, action) {
  const c = canonicalMidi(action);
  if (c === null) throw new Error(`"${action}" is not a note, a CC or a program change`);
  const m = structuredClone(map ?? { v: 1, bind: [] });
  m.midi = { ...(m.midi ?? {}) };
  if (c) m.midi[btn] = c; else delete m.midi[btn];
  if (!Object.keys(m.midi).length) delete m.midi;
  return m;
}

/** map.c's check of a `midi` section: { err: 'midi', btn } or { canonical }. */
export function midiCheck(sec) {
  if (sec === undefined) return { canonical: undefined };
  if (typeof sec !== 'object' || sec === null || Array.isArray(sec)) return { err: 'midi' };
  const out = {};
  for (const [k, v] of Object.entries(sec)) {
    const btn = /^\d+$/.test(k) ? +k : NaN;
    if (!(btn >= 1 && btn <= 32)) return { err: 'midi' };
    const c = typeof v === 'string' ? canonicalMidi(v) : null;
    if (c === null) return { err: 'midi', btn };
    if (c) out[btn] = c;
  }
  const keys = Object.keys(out).map(Number).sort((a, b) => a - b);
  return { canonical: keys.length ? Object.fromEntries(keys.map(b => [b, out[b]])) : undefined };
}

/** An encoder entry's `midi`, canonical, or null when it is not a CC (map.c refuses it as `enc`). */
export function encMidiCheck(v) {
  const c = typeof v === 'string' ? canonicalMidi(v) : null;
  return c !== null && (c === '' || c.startsWith('cc:')) ? c : null;
}
