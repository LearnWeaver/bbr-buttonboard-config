// The desk personality's actions (PROTOCOL.md §8.9, rev 0.49): the map's `hid`
// section, what each logical button sends as a keyboard chord, a media key or
// a mouse action. The names and the canonical form mirror firmware/core/deskout.c
// exactly, so a map this page writes is the map the board hands back; the
// tests (tools/test_web.mjs) check the two agree. Platform-free, so the mock
// validates with it too.

export const DESK_ACTION_MAX = 32;              // protocol.h DESK_ACTION_MAX

// In canonical order: bit i of the modifier byte
const MODS = ['ctrl', 'shift', 'alt', 'gui', 'rctrl', 'rshift', 'ralt', 'rgui'];
const MOD_ALIASES = { cmd: 'gui', win: 'gui', meta: 'gui', opt: 'alt' };

// Keyboard page usages with a name that is not a letter, digit, f1-f24 or kp0-kp9
const KEYS = {
  enter: 0x28, esc: 0x29, backspace: 0x2A, tab: 0x2B, space: 0x2C, minus: 0x2D, equal: 0x2E,
  lbracket: 0x2F, rbracket: 0x30, backslash: 0x31, semicolon: 0x33, quote: 0x34, grave: 0x35,
  comma: 0x36, period: 0x37, slash: 0x38, capslock: 0x39, printscreen: 0x46, scrolllock: 0x47,
  pause: 0x48, insert: 0x49, home: 0x4A, pgup: 0x4B, delete: 0x4C, end: 0x4D, pgdn: 0x4E,
  right: 0x4F, left: 0x50, down: 0x51, up: 0x52, numlock: 0x53, kp_slash: 0x54, kp_star: 0x55,
  kp_minus: 0x56, kp_plus: 0x57, kp_enter: 0x58, kp_dot: 0x63, menu: 0x65,
};

// Consumer page, with the words the page shows for each
export const MEDIA = [
  ['vol_up', 0x00E9, 'Volume up'], ['vol_down', 0x00EA, 'Volume down'], ['mute', 0x00E2, 'Mute'],
  ['play_pause', 0x00CD, 'Play / pause'], ['prev', 0x00B6, 'Previous track'], ['next', 0x00B5, 'Next track'],
  ['stop', 0x00B7, 'Stop'], ['bright_up', 0x006F, 'Brightness up'], ['bright_down', 0x0070, 'Brightness down'],
  ['calc', 0x0192, 'Calculator'], ['browser', 0x0196, 'Web browser'],
];

export const MOUSE = [
  ['click_left', 'Left click'], ['click_right', 'Right click'], ['click_middle', 'Middle click'],
  ['click_back', 'Back button'], ['click_fwd', 'Forward button'],
  ['scroll_up', 'Scroll up'], ['scroll_down', 'Scroll down'], ['scroll_left', 'Scroll left'], ['scroll_right', 'Scroll right'],
];

/** A named key's Keyboard page usage, or 0. */
function keyUsage(s) {
  if (/^[a-z]$/.test(s)) return 0x04 + s.charCodeAt(0) - 97;
  if (/^[1-9]$/.test(s)) return 0x1E + (+s - 1);
  if (s === '0') return 0x27;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(s);
  if (f) return +f[1] <= 12 ? 0x3A + (+f[1] - 1) : 0x68 + (+f[1] - 13);
  const kp = /^kp([0-9])$/.exec(s);
  if (kp) return kp[1] === '0' ? 0x62 : 0x59 + (+kp[1] - 1);
  return KEYS[s] ?? 0;
}

/** The name of a Keyboard page usage, or null. */
function keyName(u) {
  if (u >= 0x04 && u <= 0x1D) return String.fromCharCode(97 + u - 0x04);
  if (u >= 0x1E && u <= 0x26) return String(u - 0x1E + 1);
  if (u === 0x27) return '0';
  if (u >= 0x3A && u <= 0x45) return `f${u - 0x3A + 1}`;
  if (u >= 0x68 && u <= 0x73) return `f${u - 0x68 + 13}`;
  if (u >= 0x59 && u <= 0x62) return `kp${u === 0x62 ? 0 : u - 0x59 + 1}`;
  return Object.keys(KEYS).find(k => KEYS[k] === u) ?? null;
}

const hex = (v, digits) => '0x' + v.toString(16).padStart(digits, '0');

function hexNum(s, min, max) {
  if (!/^0x[0-9a-f]{1,4}$/.test(s)) return -1;
  const v = parseInt(s.slice(2), 16);
  return v >= min && v <= max ? v : -1;
}

/**
 * Parse one action, as deskout.c's desk_action_parse does. Returns
 * { kind: 'none'|'key'|'cc'|'mouse', mods, usage, name } or null.
 */
export function parseAction(input) {
  const s0 = String(input ?? '');
  if (s0 === '') return { kind: 'none' };
  if (s0.length > DESK_ACTION_MAX || !/^[\x21-\x7E]+$/.test(s0)) return null;
  const s = s0.toLowerCase();
  let a = null;
  if (!s.includes('+')) {
    const m = MEDIA.find(([n]) => n === s);
    if (m) a = { kind: 'cc', usage: m[1] };
    else if (MOUSE.some(([n]) => n === s)) a = { kind: 'mouse', name: s };
    else if (s.startsWith('cc:')) {
      const v = hexNum(s.slice(3), 1, 0x0FFF);
      if (v < 0) return null;
      a = { kind: 'cc', usage: v };
    }
  }
  if (!a) {
    const parts = s.split('+');
    let mods = 0, usage = 0;
    for (const p of parts) {
      if (!p) return null;
      const mi = MODS.indexOf(MOD_ALIASES[p] ?? p);
      if (mi >= 0) {
        if (mods & (1 << mi) || usage) return null;
        mods |= 1 << mi;
        continue;
      }
      let k = 0;
      if (p.startsWith('key:')) k = Math.max(0, hexNum(p.slice(4), 0x04, 0xDD));
      else k = keyUsage(p);
      if (!k || usage) return null;
      usage = k;
    }
    a = { kind: 'key', mods, usage };
  }
  const c = formatAction(a);
  return c && c.length <= DESK_ACTION_MAX ? a : null;
}

/** The canonical string of a parsed action, '' for none. */
export function formatAction(a) {
  if (!a || a.kind === 'none') return '';
  if (a.kind === 'cc') {
    const m = MEDIA.find(([, u]) => u === a.usage);
    return m ? m[0] : `cc:${hex(a.usage, 4)}`;
  }
  if (a.kind === 'mouse') return a.name;
  const parts = MODS.filter((_, i) => a.mods & (1 << i));
  if (a.usage) parts.push(keyName(a.usage) ?? `key:${hex(a.usage, 2)}`);
  return parts.join('+');
}

/** canonical(s): the form the board hands back, or null if s is not an action. */
export function canonical(s) {
  const a = parseAction(s);
  return a ? formatAction(a) : null;
}

// Words for people. "ctrl+shift+m" reads as Ctrl+Shift+M; a Mac's ⌘ is gui.
const PRETTY_MOD = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', gui: 'Win/⌘', rctrl: 'Right Ctrl',
                     rshift: 'Right Shift', ralt: 'Right Alt', rgui: 'Right Win/⌘' };
const PRETTY_KEY = { esc: 'Esc', pgup: 'Page Up', pgdn: 'Page Down', lbracket: '[', rbracket: ']', backslash: '\\',
                     semicolon: ';', quote: "'", grave: '`', comma: ',', period: '.', slash: '/', minus: '-', equal: '=' };

// Longer words for the key picker, where there is room
const KEY_LABELS = { enter: 'Enter / Return', backspace: 'Backspace', delete: 'Delete (forward)', esc: 'Esc',
                     space: 'Space', tab: 'Tab', menu: 'Menu', kp_plus: 'Keypad +', kp_minus: 'Keypad −',
                     kp_star: 'Keypad *', kp_slash: 'Keypad /', kp_dot: 'Keypad .', kp_enter: 'Keypad Enter' };

/** How a canonical action reads on the page: "Ctrl+Shift+M", "Volume up". */
export function actionText(s) {
  if (!s) return 'nothing';
  const m = MEDIA.find(([n]) => n === s);
  if (m) return m[2];
  const ms = MOUSE.find(([n]) => n === s);
  if (ms) return ms[1];
  if (s.startsWith('cc:')) return `media key ${s.slice(3)}`;
  return s.split('+').map(p => PRETTY_MOD[p] ?? PRETTY_KEY[p] ??
    (p.startsWith('key:') ? `key ${p.slice(4)}` : p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join('+');
}

/** The action button `btn` sends under desk in this map, canonical, or ''. */
export function actionOf(map, btn) {
  return map?.hid?.[btn] ?? '';
}

/**
 * The map with button `btn` sending `action` under desk. An empty action
 * removes the entry, and the section goes once it is empty, as map.c's
 * canonical form has it. Throws if `action` is not one.
 */
export function withAction(map, btn, action) {
  const c = canonical(action);
  if (c === null) throw new Error(`"${action}" is not a key, a shortcut or a media key`);
  const m = structuredClone(map ?? { v: 1, bind: [] });
  m.hid = { ...(m.hid ?? {}) };
  if (c) m.hid[btn] = c; else delete m.hid[btn];
  if (!Object.keys(m.hid).length) delete m.hid;
  return m;
}

/**
 * map.c's check of a `hid` section: { err: 'hid', btn } for the first fault,
 * or { canonical } as the module would hand it back.
 */
export function hidCheck(hid) {
  if (hid === undefined) return { canonical: undefined };
  if (typeof hid !== 'object' || hid === null || Array.isArray(hid)) return { err: 'hid' };
  const out = {};
  for (const [k, v] of Object.entries(hid)) {
    const btn = /^\d+$/.test(k) ? +k : NaN;
    if (!(btn >= 1 && btn <= 32)) return { err: 'hid' };
    const c = typeof v === 'string' ? canonical(v) : null;
    if (c === null) return { err: 'hid', btn };
    if (c) out[btn] = c;
  }
  const sorted = Object.fromEntries(Object.keys(out).map(Number).sort((a, b) => a - b).map(b => [b, out[b]]));
  return { canonical: Object.keys(sorted).length ? sorted : undefined };
}

// ---- building a shortcut by clicking ----------------------------------------
//
// For shortcuts that cannot be pressed on the computer the page runs on:
// ⌘Tab leaves the browser, Ctrl+Alt+Delete is the OS's. Modifiers as toggles,
// the key from a list, the same names the board takes.

/** The four modifiers people mean, with the words a Mac and a PC both recognise. */
export const CHORD_MODS = [['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt / Option'], ['gui', 'Cmd / Win']];

/** Every named key, grouped for a picker: [group, [[name, label]...]]. */
export const KEY_GROUPS = [
  ['Letters', 'abcdefghijklmnopqrstuvwxyz'.split('')],
  ['Digits', '1234567890'.split('')],
  ['Function', Array.from({ length: 24 }, (_, i) => `f${i + 1}`)],
  ['Editing', ['enter', 'tab', 'space', 'backspace', 'delete', 'esc', 'insert']],
  ['Arrows and paging', ['up', 'down', 'left', 'right', 'home', 'end', 'pgup', 'pgdn']],
  ['Symbols', ['minus', 'equal', 'lbracket', 'rbracket', 'backslash', 'semicolon', 'quote', 'grave', 'comma', 'period', 'slash']],
  ['Keypad', ['kp0', 'kp1', 'kp2', 'kp3', 'kp4', 'kp5', 'kp6', 'kp7', 'kp8', 'kp9',
              'kp_plus', 'kp_minus', 'kp_star', 'kp_slash', 'kp_dot', 'kp_enter']],
  ['Other', ['capslock', 'numlock', 'scrolllock', 'printscreen', 'pause', 'menu']],
].map(([g, keys]) => [g, keys.map(k => [k, KEY_LABELS[k] ?? actionText(k)])]);

/** A key action's parts: { mods: ['ctrl', ...], key: 'tab' | '' }, or null if it is not a key action. */
export function chordParts(s) {
  const a = parseAction(s);
  if (!a || a.kind !== 'key') return null;
  return { mods: MODS.filter((_, i) => a.mods & (1 << i)), key: a.usage ? (keyName(a.usage) ?? `key:${hex(a.usage, 2)}`) : '' };
}

/** The canonical action from parts, '' when there is neither a modifier nor a key. */
export function chordFrom(mods, key) {
  return canonical([...MODS.filter(m => mods.includes(m)), ...(key ? [key] : [])].join('+')) ?? '';
}

// ---- recording a shortcut from the computer's own keyboard ----------------
//
// KeyboardEvent.code names a key by its PLACE, not its character, which is
// exactly what a USB keyboard sends (§8.9: "keys are positions"). So the
// shortcut recorded here is the one the board will send, on any layout.
const CODE_NAMES = {
  Enter: 'enter', Escape: 'esc', Backspace: 'backspace', Tab: 'tab', Space: 'space', Minus: 'minus',
  Equal: 'equal', BracketLeft: 'lbracket', BracketRight: 'rbracket', Backslash: 'backslash',
  Semicolon: 'semicolon', Quote: 'quote', Backquote: 'grave', Comma: 'comma', Period: 'period',
  Slash: 'slash', CapsLock: 'capslock', PrintScreen: 'printscreen', ScrollLock: 'scrolllock',
  Pause: 'pause', Insert: 'insert', Home: 'home', PageUp: 'pgup', Delete: 'delete', End: 'end',
  PageDown: 'pgdn', ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up',
  NumLock: 'numlock', NumpadDivide: 'kp_slash', NumpadMultiply: 'kp_star', NumpadSubtract: 'kp_minus',
  NumpadAdd: 'kp_plus', NumpadEnter: 'kp_enter', NumpadDecimal: 'kp_dot', ContextMenu: 'menu',
  IntlBackslash: 'key:0x64',
};
const MOD_CODES = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'];

/** The key name for a KeyboardEvent.code, or null (a modifier, or a key the board has no name for). */
export function codeName(code) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^Digit([0-9])$/.exec(code))) return m[1];
  if ((m = /^F([0-9]{1,2})$/.exec(code)) && +m[1] >= 1 && +m[1] <= 24) return `f${+m[1]}`;
  if ((m = /^Numpad([0-9])$/.exec(code))) return `kp${m[1]}`;
  return CODE_NAMES[code] ?? null;
}

export const isModifierCode = (code) => MOD_CODES.includes(code);

/** The modifiers held in a KeyboardEvent, in canonical order. */
export function modsOf(e) {
  return [e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'gui'].filter(Boolean);
}

/** The chord a keydown makes, canonical: modifiers held plus its key. null for a modifier alone or an unknown key. */
export function chordOf(e) {
  if (isModifierCode(e.code)) return null;
  const k = codeName(e.code);
  return k ? canonical([...modsOf(e), k].join('+')) : null;
}
