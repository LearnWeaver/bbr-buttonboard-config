// Configure: the chain on the left, the selected tile drawn as it is laid
// out, an inspector on the right. Replaces the old Tiles + Bind + LEDs tabs,
// which asked three questions about one physical object from three screens.
//
// Two ways to bind, because they answer different questions:
//   - click a key (or a knob), then choose what it reports. This edits the map
//     and pushes it with `map set` (§9.2), the same route leds.js already took.
//     There is no "assign this key" command — `bind` waits for a PRESS.
//   - "Press a key…" / "Turn the knob…" run `bind <btn>` and `bind axis <n>`
//     (§9.6, §15.7) for when you cannot tell which control on the diagram is
//     the one under your hand.
import { state, refreshMap, refreshTiles, setStatus, render as rerender } from '../app.js';
import { geom, encoderNote, displayNote, defaultDebounce, hasDebounce } from '../tilegeom.js';
import { RUMBLE_CODE_MAX, bindFor, bindsOf, withBind, withoutBind,
         ledActionsOf, withLedAction, withoutLedAction, RUMBLE_LED_MAX, LED_FX,
         textsOf, textFor, withText, withoutText, RUMBLE_TEXT_MAX,
         showLegendCall, rawRumbleCall, wireByte, sendValue } from '../rumble.js';
import { XINPUT_SLOTS, padView, tinySlot } from '../xpad.js';
import { attrByte, cssOf, isColor, ascii, unrepresentable, NAMES, CAP_DISP_COLOR, inkPaperOf,
         ditherTo1bpp, imageChunks, strideOf, paint1bpp,
         encodeRgb565, paintRgb565, slotChunks, slotCrc, SLOT_CHUNK } from '../dispattr.js';

export const wide = true;
export const live = true;

const PALETTE = ['D9480F', '2C6E49', '1D4E89', 'A32B2B', '6B7683', 'FFFFFF'];
const FX = ['solid', 'blink', 'fast', 'breathe'];
const AXES = [1, 2, 3, 4];                       // ENC_AXIS_COUNT, §15.5
// Axis counts per click (§15.4). The FRC Driver Station sends each axis to
// the robot as 8 bits, so 256 is one robot-visible step per click; smaller
// values need several clicks per step, larger ones reach the end sooner.
const SCALE_DEFAULT = 256;
const SCALES = [32, 64, 128, 256, 512, 1024, 2048, 4096];

// Selection survives re-renders; it is view state, not board state.
let sel = { addr: null, kind: 'key', idx: 0 };
// With Combo on, clicking a number adds it to the key or takes it away,
// instead of making it the key's only button.
let comboMode = false;

// The FTC Driver Station binds a pad to gamepad 1 or 2 when it sees Start+A or
// Start+B (§8.5): logical 8+1 and 8+2. One key per combo saves two hands.
const FTC_COMBOS = [{ btns: [1, 8], label: 'Start+A', note: 'FTC gamepad 1' },
                    { btns: [2, 8], label: 'Start+B', note: 'FTC gamepad 2' }];

// ---- rumble as a control channel, §8.8 -------------------------------------
//
// The module reports EVERY rumble packet it decodes, bound or not, which is
// what lets this page run the same press-it-and-bind-it flow §9.6 gives keys:
// there is no `bind` command for a code, because there is nothing to wait for
// on the board — the event is already coming. So arming is local, the first
// code that arrives binds, and the live line shows the raw motor bytes so
// someone debugging can see what the robot actually sent rather than what
// this page made of it.
let lastRumble = null;     // {left, right, code, at}
let lastPlayer = null;     // §8.5's player index, the same endpoint's other half
let arming = null;         // {addr, slot, timer} while waiting for a code
let subscribedTo = null;   // the client these listeners are attached to

// The robot-colour picker's code and effect (§8.8 rev 0.33). Page state, not
// map state: nothing is sent until a colour is picked.
let rledCode = 1;
let rledFx = 'solid';
// The code the Messages picker saves the panel's rows to (§8.8 rev 0.36).
let msgCode = 1;

/**
 * Open this screen on one tile, from another screen: the Legends overview
 * links each entry to the inspector that edits it. `kind` is 'disp' for the
 * panel or 'key' for a key's robot colours.
 */
export function focusTile(addr, kind = 'disp', idx = 0) {
  sel = { addr, kind, idx };
}

// 30 s with no code, the same patience §9.6 gives a key press.
const ARM_TIMEOUT_MS = 30000;

const btnLabel = (n) =>
  state.hello?.usb === 'xinput' ? (XINPUT_SLOTS[n - 1] ?? `${n} — no XInput slot`) : `Button ${n}`;

// A key may feed several buttons at once, a combo (§9.7): Start+A on one key
// is how an FTC pad is bound to gamepad 1. buttonsAt lists them in order;
// bindingAt is the lowest, which is also the one whose colour the key wears
// when more than one has a colour.
const buttonsAt = (addr, key) =>
  [...new Set((state.map?.bind ?? []).filter(b => b.addr === addr && b.key === key).map(b => b.btn))].sort((a, b) => a - b);
const bindingAt = (addr, key) => buttonsAt(addr, key)[0];
const sourcesOf = (btn) => (state.map?.bind ?? []).filter(b => b.btn === btn);
const encAt = (addr, idx) => (state.map?.enc ?? []).find(e => e.addr === addr && e.idx === idx);
const axisOwner = (axis) => (state.map?.enc ?? []).find(e => e.axis === axis);

// What this page last put in the boxes for each panel, keyed by address.
//
// It is a DRAFT, not a read-back: §14.4 has no command that asks a tile what
// is on its screen, and the module does not keep a copy either. So the preview
// below is "what you asked for", and it is labelled that way rather than
// pretending to be a mirror.
const drafts = new Map();

const hasPanel = (t) => !!(t?.cols && t?.rows);
// §14.8: the pixel size is the advertisement, so its absence is the answer to
// "can this tile take a picture?" rather than something to infer from the type.
const takesImage = (t) => !!(t?.pxW && t?.pxH);
const isColourPanel = (t) => !!(t?.caps & CAP_DISP_COLOR);

// §14.9: a tile with a picture store reports how many slots it has, the same
// way pxW/pxH report that it takes a streamed picture at all. No capability
// bit, because the store is a part on the tile rather than a mode of the MCU.
const slotCount = (t) => t?.slots ?? 0;

// A picture staged for a panel, keyed by address: the source bitmap, the bytes
// that would go on the wire, and where they are meant to go.
//
// Kept apart from the row draft because §14.8 and §14.9 make the two exclusive
// — a picture owns the panel until CLEAR — and kept at all because the
// encoding is the whole question. Choosing a file does not send it: you see
// what the tile would draw, change format, ink, paper or invert until it looks
// right, and only then spend the bus.
const pictures = new Map();

// What is on the glass, keyed by address: {kind:'stream'|'slot', slot, pic}.
// A draft like the row draft is — §14.4 has no command that asks a tile what
// it is showing — but it is what keeps the panel preview honest about the one
// rule a picture brings with it: it owns the panel until Clear.
const glass = new Map();

// What this page has PUT in each slot, keyed by `${addr}:${slot}`: the name
// and the bytes, which the tile does not keep. Absence here means "this page
// has not filled it", never "the tile's slot is empty" -- that is slotInfo's.
const stored = new Map();
const storedAt = (addr, slot) => stored.get(`${addr}:${slot}`);

// What the tile REPORTS for each slot, from §14.9's INFO, keyed the same way:
// `{empty}` or `{fmt, attr, len, crc}`. Filled by Check slots, and kept in
// step by Store and Erase. The CRC is how a picture this page stored is
// recognised again without reading 32 KB back.
const slotInfo = new Map();
const infoAt = (addr, slot) => slotInfo.get(`${addr}:${slot}`);
const nameFor = (addr, slot) => {
  const st = storedAt(addr, slot), info = infoAt(addr, slot);
  if (st && (!info || (!info.empty && info.crc === st.crc))) return st.name;
  if (!info || info.empty) return null;
  // Not stored from here this session, but perhaps elsewhere on this page.
  for (const v of stored.values()) if (v.crc === info.crc && v.bytes === info.len) return v.name;
  return null;
};

// The two encodings, said the way the choice is actually made.
const FMT = {
  '1bpp':   { label: 'two colours', code: '1bpp' },
  'rgb565': { label: 'full colour', code: 'rgb565' },
};

// Re-derive the wire bytes from the source bitmap. Cheap enough to redo on
// every change of format, ink, paper or invert: 128x128 is 16 K pixels, and
// the point of the preview is that trying things costs nothing.
function reencode(t) {
  const p = pictures.get(t.addr);
  if (!p) return null;
  if (p.fmt === 'rgb565') {
    // FMT 0x02 carries no attribute and the tile is sent a zero one (§14.9):
    // the colour is in the pixels, so paper here is the letterbox and the
    // backdrop for transparency, not an ink/paper pair.
    p.bad = false;
    p.attr = 0;
    p.bytes = encodeRgb565(p.bitmap, t.pxW, t.pxH, { paper: p.bg });
    p.bits = null;
  } else {
    p.bad = unrepresentable(p.ink, p.paper);
    p.attr = p.bad ? 0 : attrByte({ ink: p.ink, paper: p.paper });
    p.bits = ditherTo1bpp(p.bitmap, t.pxW, t.pxH, { invert: p.invert });
    p.bytes = p.bits;
  }
  // Two chunkings, because the two paths are different commands: a streamed
  // picture is IMAGE chunks of whole pixel rows (§14.8), a stored one is DATA
  // chunks of 64 bytes at ascending offsets (§14.9).
  p.rowChunks = p.bits ? imageChunks(p.bits, t.pxW).length : 0;
  p.dataChunks = Math.ceil(p.bytes.length / SLOT_CHUNK);
  p.chunks = p.dest === 'slot' ? p.dataChunks : p.rowChunks;
  return p;
}

function dropPicture(addr) {
  pictures.get(addr)?.bitmap?.close?.();
  pictures.delete(addr);
}

/** Paint one picture — either encoding — onto a canvas at the panel's size. */
function paintPic(canvas, pic, t) {
  if (!pic) return;
  if (pic.fmt === 'rgb565') paintRgb565(canvas, pic.bytes, t.pxW, t.pxH);
  else if (pic.bits) paint1bpp(canvas, pic.bits, t.pxW, t.pxH, pic.attr);
}

// The staged picture goes in the inspector's canvas; whatever owns the glass
// goes in the panel's. They are usually the same bytes and deliberately not
// the same record: staging a second file must not change what the panel is
// still showing.
function paintPictures(root, t) {
  const p = pictures.get(t.addr);
  for (const c of root.querySelectorAll('canvas[data-pic]')) paintPic(c, p, t);
  const on = glass.get(t.addr);
  for (const c of root.querySelectorAll('canvas[data-glass]')) paintPic(c, on?.pic, t);
}

// A frozen copy of the staged bytes. `reencode` replaces the arrays rather
// than writing through them, so a shallow copy of the fields is enough — and
// it has to be a copy, or restaging a file would silently repaint the panel
// preview with bytes the tile has never seen.
const snapshot = (p) => ({ fmt: p.fmt, attr: p.attr, bits: p.bits, bytes: p.bytes });

// A picture now owns the panel (§14.8, §14.9). The rows this page believes it
// drew are no longer on the glass, so forget them — otherwise the next Draw
// would skip the rows it thinks are already there.
function takePanel(t, entry) {
  glass.set(t.addr, entry);
  for (const r of draftFor(t)) delete r.sent;
}

function draftFor(t) {
  let d = drafts.get(t.addr);
  if (!d || d.length !== t.rows) {
    d = Array.from({ length: t.rows }, () => ({ text: '', ink: 'white', paper: 'black', double: false }));
    drafts.set(t.addr, d);
  }
  return d;
}

// A double-height row occupies this row and the next (§14.3), so the next row
// draws nothing of its own. On the last row the bit is ignored rather than
// refused, which is what the tile does too.
function panelRows(t) {
  const d = draftFor(t), out = [];
  for (let r = 0; r < t.rows; r++) {
    const dbl = d[r].double && r + 1 < t.rows;
    out.push({ r, row: d[r], dbl });
    if (dbl) r++;
  }
  return out;
}

function selectedTile() {
  const online = state.tiles.filter(t => t.state !== 'cached');
  if (!online.length) return null;
  return online.find(t => t.addr === sel.addr) ?? online[0];
}

async function pushMap(mutate, msg) {
  const m = structuredClone(state.map ?? { v: 1, bind: [] });
  m.bind = m.bind ?? [];
  mutate(m);
  // §15.7: an entry with neither axis nor cw/ccw binds the encoder to nothing.
  m.enc = (m.enc ?? []).filter(e => e.axis || e.cw || e.ccw);
  if (!m.enc.length) delete m.enc;
  if (!(m.rumble ?? []).length) delete m.rumble;
  if (m.debounce && !Object.keys(m.debounce).length) delete m.debounce;
  try {
    await state.client.mapSet(m);
    await refreshMap();
    setStatus(msg, 'ok');
  } catch (e) {
    setStatus(`Not applied: ${e.message}`, 'fault');
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * What the module does with a code that arrives, mirrored here as a draft.
 *
 * §8.8 gives the config channel no word about the action — the event reports
 * the packet and nothing else — so this is the same kind of belief the rest of
 * the panel preview is: what the board would have done with the map this page
 * is holding. Everything the module drops on the floor is dropped here too: a
 * code with no entry, an absent tile, a tile with no picture store, a slot it
 * does not have. None of them is an error, because a match is not the place to
 * report a configuration error.
 *
 * The one case this page refuses to guess about is a slot whose pixels it has
 * not seen: one it neither stored nor loaded back with §14.9's READ. A preview
 * that switched to a picture it has never seen would be inventing one. The
 * board may well have changed the glass; this says nothing either way.
 */
function rumbleAct(code) {
  let changed = false;
  const b = bindFor(state.map, code);
  const t = b && state.tiles.find(x => x.addr === b.addr);
  const st = t && t.state === 'online' && b.slot < slotCount(t) && storedAt(b.addr, b.slot);
  if (st) { takePanel(t, { kind: 'slot', slot: b.slot, pic: st.pic }); changed = true; }
  // A message (rev 0.36) clears the panel and writes its rows, so the
  // preview becomes those rows -- which this page knows exactly, unlike a
  // picture -- and any picture on the glass goes.
  for (const e of textsOf(state.map, { code })) {
    const tt = state.tiles.find(x => x.addr === e.addr);
    if (!tt || tt.state !== 'online' || !hasPanel(tt)) continue;
    drafts.set(tt.addr, messageRows(tt, e));
    for (const r of drafts.get(tt.addr)) r.sent = true;
    glass.delete(tt.addr);
    changed = true;
  }
  return changed;
}

// ---- messages on rumble codes (§8.8, rev 0.36) ------------------------------
//
// A message is the panel's rows, saved under a code. The editor above IS the
// message editor: write the rows, pick a code, save. Loading one puts it back
// in the rows to change. Colours and double height are kept per row, as the
// attribute byte the firmware stores.

/** The editor's rows as a message: text and one attribute byte per row. */
function rowsAsMessage(t) {
  const rows = Array(t.rows).fill(''), attrs = Array(t.rows).fill(0);
  // panelRows skips the row under a double-height one, which stays blank
  for (const { r, row, dbl } of panelRows(t)) {
    if (unrepresentable(row.ink, row.paper)) return null;
    const a = attrByte({ ink: row.ink, paper: row.paper, double: dbl });
    const text = ascii(row.text).slice(0, t.cols);
    // A row with a visible background is padded to the panel's width, as Draw
    // does, so the colour spans it. Anything else loses its trailing spaces:
    // they cost bytes of the map and draw nothing after a CLEAR.
    rows[r] = a & (0xE0 | 0x01) ? text.padEnd(t.cols) : text.replace(/\s+$/, '');
    attrs[r] = a;
  }
  return { rows, attrs };
}

/** A message as editor rows, the inverse of rowsAsMessage. */
function messageRows(t, e) {
  return Array.from({ length: t.rows }, (_, r) => {
    const a = e.attrs?.[r] ?? 0;
    const { ink, paper } = inkPaperOf(a);
    return { text: e.rows[r] ?? '', ink, paper, double: !!(a & 0x02) };
  });
}

function messageSummary(e) {
  const lines = e.rows.filter(Boolean);
  if (!lines.length) return '<span class="muted">blank panel</span>';
  return `<span class="mono">${esc(lines[0])}</span>${lines.length > 1 ? ` <span class="muted">+${lines.length - 1} row${lines.length > 2 ? 's' : ''}</span>` : ''}`;
}

function inspectMessages(t) {
  const codes = Array.from({ length: RUMBLE_CODE_MAX }, (_, i) => i + 1);
  const mine = textsOf(state.map, { addr: t.addr });
  const full = textsOf(state.map).length >= RUMBLE_TEXT_MAX;
  const pictureHere = (n) => { const b = bindFor(state.map, n); return b && b.addr === t.addr ? b : null; };
  return `
    <div>
      <div class="insp-title">Messages</div>
      <p class="muted small">Save the rows above under a rumble code, and <code>${esc(showLegendCall(msgCode))}</code>
        puts them on this panel during a match. Load one back into the rows to change it.</p>
      ${mine.length ? mine.map(e => `<div class="disprow rumblerow bound" data-code="${e.code}">
        <span class="mono disprow-n">${e.code}</span>
        <span class="small" style="flex:1;min-width:0">${messageSummary(e)}</span>
        <button data-msg-load="${e.code}" title="put this message in the rows above">Load</button>
        <button data-msg-del="${e.code}" title="remove">×</button>
      </div>`).join('') : '<p class="muted small">No messages on this panel yet.</p>'}
      <div class="group" style="margin-top:.4rem">
        <label class="disprow-dbl">code
          <select id="msg-code">
            ${codes.map(n => `<option value="${n}" ${msgCode === n ? 'selected' : ''}>${n}${textFor(state.map, n, t.addr) ? ' ●' : pictureHere(n) ? ' (picture)' : ''}</option>`).join('')}
          </select></label>
        <button id="msg-save" ${full && !textFor(state.map, msgCode, t.addr) ? 'disabled' : ''}>${textFor(state.map, msgCode, t.addr) ? `Replace code ${msgCode}` : `Save as code ${msgCode}`}</button>
      </div>
      ${pictureHere(msgCode) ? `<p class="small notice">Code ${msgCode} shows picture slot ${pictureHere(msgCode).slot} on this panel. Saving a message replaces it.</p>` : ''}
      <p class="muted small">A message clears the panel first, so rows left empty are blank.${full ? ` <strong>The board holds at most ${RUMBLE_TEXT_MAX} messages.</strong>` : ''}</p>
    </div>`;
}

// ---- keeping your place across a rebuild -----------------------------------
//
// `render()` rebuilds `root.innerHTML` wholesale, and the three columns are
// `overflow:auto`, so every rebuild used to throw away the scroll position AND
// the focused control: changing one dropdown in the inspector jumped to the
// top and dropped the keyboard out of the select you had just used. It is not
// specific to any control — every onchange path ends in a rebuild.
//
// The fix is here rather than in each handler, so nobody has to remember it.
// What is NOT preserved is a genuine change of context: selecting another
// tile, key, knob or panel starts at the top, because restoring an offset
// from a different view is its own bug. `renderedSel` is what tells the two
// apart — the handlers mutate `sel` before they re-render, so a mismatch at
// render time means the view changed.
//
// It is a safety net, not a licence: a change that affects one region should
// still patch that region, the way the live rumble line does.
const SCROLLERS = ['.cfg-rail', '.cfg-canvas', '.cfg-inspect'];

let renderedSel = null;     // the selection the DOM currently in the root was built for
let pendingRestore = null;  // a snapshot taken before app.js wiped the root

const dashed = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// A selector that finds the same control in the rebuilt DOM. Ids first; then
// the data- attributes the markup already carries (`[data-rbind="7"]`,
// `[data-disp="text"][data-row="3"]`), which are stable across a rebuild in a
// way an index into the tree is not.
function focusKey(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = Object.entries(el.dataset).filter(([, v]) => /^[\w .,:+-]*$/.test(v));
  if (!parts.length) return null;
  return el.tagName.toLowerCase() + parts.map(([k, v]) => `[data-${dashed(k)}="${v}"]`).join('');
}

function snapshotView(root) {
  if (!root) return null;
  const scroll = {};
  for (const s of SCROLLERS) {
    const el = root.querySelector(s);
    if (el) scroll[s] = el.scrollTop;
  }
  const a = document.activeElement;
  let focus = null;
  if (a && a !== document.body && root.contains(a)) {
    const key = focusKey(a);
    // Only a text field has a caret worth restoring, and reading
    // selectionStart on a number input throws in some browsers.
    let start = null, end = null;
    try { if (a.type === 'text' || a.tagName === 'TEXTAREA') { start = a.selectionStart; end = a.selectionEnd; } } catch { /* not a text field */ }
    if (key) focus = { key, start, end };
  }
  // The selection the DOM being snapshotted was BUILT for, not the current
  // one: a click handler has already moved `sel` by the time render runs, and
  // comparing `sel` with itself would preserve the offset across exactly the
  // context change that must not keep it.
  return { scroll, focus, sel: renderedSel && { ...renderedSel } };
}

function restoreView(root, snap) {
  if (!snap?.sel) return;
  // A different tile, key, knob or panel is a new view: start at the top.
  if (snap.sel.addr !== sel.addr || snap.sel.kind !== sel.kind || snap.sel.idx !== sel.idx) return;
  for (const [s, top] of Object.entries(snap.scroll)) {
    const el = root.querySelector(s);
    if (el) el.scrollTop = top;
  }
  if (!snap.focus) return;
  const el = root.querySelector(snap.focus.key);
  if (!el) return;
  el.focus({ preventScroll: true });          // preventScroll: the offsets above are the authority
  if (snap.focus.start != null && el.setSelectionRange) {
    try { el.setSelectionRange(snap.focus.start, snap.focus.end); } catch { /* not selectable */ }
  }
}

// A re-render that goes through app.js — which empties the root before this
// screen's render() runs, so the snapshot has to be taken first. Used for the
// rebuilds nobody asked for: a rumble arriving is not a click.
function rerenderKeepingScroll() {
  pendingRestore = snapshotView(document.querySelector('#screen'));
  rerender();
}

function disarm() {
  if (arming?.timer) clearTimeout(arming.timer);
  arming = null;
}

async function bindCode(code, addr, slot) {
  const prev = bindFor(state.map, code);
  // One entry per code is enforced HERE rather than by the board's `rumble`
  // error: `withBind` replaces whatever was on the code, so the map that goes
  // out can never carry two entries for one number (§9.5).
  await pushMap(m => { m.rumble = withBind(m.rumble, code, addr, slot); },
    `Code ${code} → tile ${addr} slot ${slot}`
    + (prev ? ` (was tile ${prev.addr} slot ${prev.slot})` : '')
    + ` — ${showLegendCall(code)}`);
  if (state.screen === 'configure') rerenderKeepingScroll();
}

function onRumble(e) {
  lastRumble = { left: e.left, right: e.right, code: e.code, at: Date.now() };
  // Code 0 is never a binding and never an action: rumble(0, 0, ms) is how the
  // SDK stops a rumble, and a stop must not change what is on a screen, nor
  // consume the bind someone is waiting to make.
  if (arming && e.code) {
    const a = arming;
    disarm();
    bindCode(e.code, a.addr, a.slot);
    return;
  }
  const changed = e.code ? rumbleAct(e.code) : false;
  if (changed && state.screen === 'configure') rerenderKeepingScroll();
  else patchRumble();
}

function onPlayer(e) {
  lastPlayer = { n: e.n, at: Date.now() };
  patchRumble();
}

function subscribe() {
  if (!state.client || subscribedTo === state.client) return;
  subscribedTo = state.client;
  state.client.on('rumble', onRumble);
  state.client.on('player', onPlayer);
}

const ago = (at) => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 1 ? 'just now' : `${s} s ago`;
};

function liveLine() {
  if (arming) {
    return `<strong>Waiting for a code…</strong> send <code>rumble(c / 15.0, 0, ms)</code> from the robot.`
         + ` The next code that is not zero binds to slot ${arming.slot} of tile ${arming.addr}.`;
  }
  if (!lastRumble) {
    return '<span class="muted">No rumble code received yet. Every code the board receives shows here, bound or not.</span>';
  }
  const { left, right, code, at } = lastRumble;
  return `<strong>code ${code || '0'}</strong> `
       + `<span class="mono">left ${left} · right ${right}</span> `
       + `<span class="muted">${ago(at)}</span>`
       + (code ? '' : ' <span class="muted">— zero stops a rumble and does nothing here</span>');
}

function playerLine() {
  if (!lastPlayer) return '';
  return `<span class="muted">Driver Station assigned <strong>player ${lastPlayer.n}</strong> ${ago(lastPlayer.at)}.</span>`;
}

// Live highlight without a rebuild, for the same reason `tick()` exists: a
// re-render on every packet would land in the middle of someone's click, and
// the SDK can deliver a code every 50 ms.
function patchRumble(root = document.querySelector('#screen')) {
  const live = root?.querySelector('[data-rumble-live]');
  if (!live) return;
  live.innerHTML = liveLine();
  const pl = root.querySelector('[data-rumble-player]');
  if (pl) pl.innerHTML = playerLine();
  for (const el of root.querySelectorAll('[data-code]')) {
    el.classList.toggle('hit', !!lastRumble?.code && +el.dataset.code === lastRumble.code);
  }
}

const KNOB = `<svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
  <circle cx="17" cy="17" r="13" stroke="currentColor" stroke-width="1.5"/>
  <path d="M17 6v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// Per tile, not per key: §4.5's SET_CONFIG carries one value for the tile. The
// map holds only overrides (§9.5), so the default is shown, not stored.
function debounceView(t) {
  const def = defaultDebounce(t.type);
  const over = state.map?.debounce?.[t.addr];
  const cur = over ?? t.debounce ?? def;
  return `<p class="debounce"><label>Debounce
      <input type="number" id="debounce" min="1" max="255" step="1" value="${cur}"> ms</label>
      <span class="muted small">every key on this tile · default ${def} ms</span>
      ${over != null ? '<button id="debounce-reset">Default</button>' : ''}</p>`;
}

function encSummary(e) {
  if (!e) return '—';
  const parts = [];
  if (e.axis) parts.push(`Axis ${e.axis}`);
  if (e.cw || e.ccw) parts.push(`B${e.cw ?? '?'}/B${e.ccw ?? '?'}`);
  return parts.join(' · ');
}

function inspectKey(t) {
  const btns = buttonsAt(t.addr, sel.idx);
  const cur = btns[0];
  const combo = btns.length > 1;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const led = state.map?.led ?? {};
  const ledOf = (btn) => (btn && led.btn?.[btn]) || {};
  const xinput = state.hello?.usb === 'xinput';
  return `
    <div>
      <div class="insp-title">Selected key</div>
      <div class="insp-head"><strong>K${sel.idx + 1}</strong> <span class="mono muted">tile ${t.addr}</span></div>
    </div>

    <div>
      <div class="insp-title">Reports as</div>
      <div class="btngrid">
        ${Array.from({ length: 32 }, (_, i) => i + 1).map(n =>
          `<button class="btncell ${btns.includes(n) ? 'sel' : ''} ${sourcesOf(n).length ? 'used' : ''} ${xinput && n > XINPUT_SLOTS.length ? 'noslot' : ''}"
                   data-btn="${n}" title="${btnLabel(n)}">${n}<small>${tinySlot(n) ?? '&nbsp;'}</small></button>`).join('')}
      </div>
      ${padView({ attr: 'btn',
        cls: n => `${btns.includes(n) ? 'sel' : ''} ${sourcesOf(n).length ? 'used' : ''}`,
        title: n => `Button ${n} · ${XINPUT_SLOTS[n - 1]}` })}
      <p class="muted small">The same 24 buttons where an Xbox pad has them: click either view.
        ${xinput ? 'Buttons 25–32 have no XInput slot, so this board does not send them.'
                 : 'Under <code>frc</code> the numbers are what the robot sees; the pad names what each becomes under <code>xinput</code>.'}</p>
      <p class="muted small">${cur ? btns.map(btnLabel).join(' + ') : 'Not bound. Pick a number, or press the key on the board.'}</p>
      <div class="group" style="margin-top:.4rem">
        <button class="chip ${comboMode ? 'sel' : ''}" id="combo" title="click numbers to add or remove them">Combo</button>
        ${FTC_COMBOS.map(c => `<button class="chip ${same(btns, c.btns) ? 'sel' : ''}" data-combo="${c.btns.join('+')}"
                 title="${c.note}: buttons ${c.btns.join(' + ')}">${c.label}</button>`).join('')}
      </div>
      <p class="muted small">${comboMode
        ? 'Combo is on: each number you click is added to this key or taken off it. One press sends them all together.'
        : 'Combo presses several buttons from one key. Start+A and Start+B are how the FTC Driver Station assigns gamepad 1 and 2.'}</p>
      <button id="press">Press a key…</button>
      <p class="notice small">While the board is waiting for that press it reports every button released, so
        nothing on the robot can fire.</p>
    </div>

    ${combo ? `<div>
      <div class="insp-title">Combo</div>
      <p class="muted small">This key presses ${btns.map(btnLabel).join(' and ')} together. Each of
        those buttons keeps any other keys it has. The key's colour comes from the lowest-numbered one that has one.</p>
    </div>` : `<div>
      <div class="insp-title">Group</div>
      <div class="group">
        ${cur ? sourcesOf(cur).map(s =>
          `<span class="chip">tile ${s.addr} · K${s.key + 1}<button data-un="${s.addr},${s.key}" title="remove">×</button></span>`).join('')
          : '<span class="muted small">Bind this key first.</span>'}
      </div>
      ${cur ? '<p class="muted small">The button is pressed while any of these keys is down.</p>' : ''}
    </div>`}

    <div>
      <div class="insp-title">LED</div>
      ${cur ? `
      <div class="swatches">
        ${PALETTE.map(c => `<button class="ledsw ${ledOf(cur).rgb === c ? 'sel' : ''}" data-rgb="${c}" style="background:#${c}"></button>`).join('')}
        <button class="ledsw off" data-rgb="off" title="off">∅</button>
      </div>
      <div class="group" style="margin-top:.6rem">
        ${FX.map(f => `<button class="chip ${((ledOf(cur).fx) ?? 'solid') === f ? 'sel' : ''}" data-fx="${f}">${f}</button>`).join('')}
      </div>
      <p class="muted small">The colour belongs to the button, so it moves with the button if you bind it to another key.</p>`
      : '<p class="muted small">Bind this key to give it a colour.</p>'}
    </div>
    ${cur ? robotColour(cur) : ''}`;
}

/**
 * Robot colour: rumble codes that recolour this key's button mid-match
 * (§8.8 rev 0.33). The same code that switches a legend can carry these, so
 * `board.showLegend(n)` changes both in one call.
 *
 * Rows are per code and picking a colour replaces that code's entry for this
 * button, so the one-per-(code, btn) rule cannot be broken from here. "normal"
 * is the map's `map`: the code drops the robot's colour and the key goes back
 * to its default above.
 */
function robotColour(btn) {
  const acts = ledActionsOf(state.map, { btn });
  const full = ledActionsOf(state.map).length >= RUMBLE_LED_MAX;
  const codes = Array.from({ length: RUMBLE_CODE_MAX }, (_, i) => i + 1);
  const legendOf = (n) => bindFor(state.map, n);
  const swatch = (rgb) => rgb === 'map' ? '<span class="muted small">normal</span>'
    : `<span class="keycell-led" style="position:static;display:inline-block;background:#${rgb === 'off' ? '000' : rgb}"></span>`;
  return `
    <div>
      <div class="insp-title">Robot colour</div>
      <p class="muted small">A rumble code can recolour this key during a match. It is the same number a
        legend is switched by, so one <code>${esc(showLegendCall(rledCode))}</code> can change both.</p>
      ${acts.map(a => `<div class="disprow rumblerow bound">
        <span class="mono disprow-n">${a.code}</span>
        <span class="small" style="flex:1;min-width:0">${swatch(a.rgb)} ${a.rgb === 'map' ? 'back to the default'
          : a.rgb === 'off' ? 'off' : `#${a.rgb}`}${a.fx ? ` · ${a.fx}` : ''}${legendOf(a.code) ? ' <span class="muted">+ legend</span>' : ''}</span>
        <button data-rled-del="${a.code}" title="remove">×</button>
      </div>`).join('')}
      <div class="group" style="margin-top:.4rem">
        <label class="disprow-dbl">code
          <select id="rled-code">
            ${codes.map(n => `<option value="${n}" ${rledCode === n ? 'selected' : ''}>${n}${legendOf(n) ? ' (legend)' : ''}${acts.some(a => a.code === n) ? ' ●' : ''}</option>`).join('')}
          </select></label>
        <label class="disprow-dbl">effect
          <select id="rled-fx">
            ${LED_FX.map(f => `<option value="${f}" ${rledFx === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select></label>
      </div>
      <div class="swatches" style="margin-top:.4rem">
        ${PALETTE.map(c => `<button class="ledsw" data-rled-rgb="${c}" style="background:#${c}" ${full ? 'disabled' : ''}></button>`).join('')}
        <button class="ledsw off" data-rled-rgb="off" title="off" ${full ? 'disabled' : ''}>∅</button>
        <button class="chip" data-rled-rgb="map" title="back to the default colour" ${full ? 'disabled' : ''}>normal</button>
      </div>
      <p class="muted small">A code changes only the keys it names. The FTC SDK ignores a code sent less than 50 ms
        after another, so if a code is meant to put things back, give it a <em>normal</em> entry for every key the
        other codes recolour. Robot colours last until the board is reset or unplugged.${full ? ` <strong>The board holds at most ${RUMBLE_LED_MAX} robot colours.</strong>` : ''}</p>
    </div>`;
}

// The panel as it would look. Cells are 3:4 on both panels built so far — a
// 6x8 font on disp1, 12x16 on screenkey1 — so one aspect ratio serves both.
function panelView(t) {
  const sel_ = sel.kind === 'disp';
  const on = glass.get(t.addr);
  // A picture owns the panel until CLEAR (§14.8, §14.9) whether it was streamed
  // or shown from a slot, so the preview shows it instead of the rows: leaving
  // the grid up would claim text is on a screen the picture is covering.
  if (on) {
    return `<button class="panel ${sel_ ? 'sel' : ''}" data-disp-sel="1"
                    style="aspect-ratio:${t.pxW} / ${t.pxH}">
      <canvas class="panel-pic" data-glass="1" width="${t.pxW}" height="${t.pxH}"></canvas>
    </button>`;
  }
  return `<button class="panel ${sel_ ? 'sel' : ''}" data-disp-sel="1"
                  style="aspect-ratio:${t.cols * 3} / ${t.rows * 4}">
    <div class="panel-grid" style="grid-template-rows:repeat(${t.rows},1fr)">
      ${panelRows(t).map(({ r, row, dbl }) => {
        const bad = unrepresentable(row.ink, row.paper);
        const { ink, paper } = bad
          ? { ink: '#000', paper: '#000' }
          : cssOf(attrByte({ ink: row.ink, paper: row.paper }));
        return `<div class="panel-row" style="grid-row:span ${dbl ? 2 : 1};background:${paper};color:${ink}">
          <span style="font-size:${dbl ? 1.7 : 1}em">${ascii(row.text).replace(/</g, '&lt;') || '&nbsp;'}</span>
        </div>`;
      }).join('')}
    </div>
  </button>`;
}

// The Picture half of the display inspector. Separate from inspectDisp because
// it is a second thing you can put on the same panel, with its own staging.
//
// Two ways to put a picture on a panel, and the difference is the point:
//
//   - **stream it** (§14.8). 1 bpp, two colours, ~180 ms of auxiliary slot
//     EVERY time it is drawn. Nothing is kept anywhere; the panel's own memory
//     holds it until CLEAR.
//   - **store it in a slot** (§14.9). 2-4 s ONCE, at configuration time, and
//     after that a legend change is a single SHOW frame. Because the picture
//     no longer crosses the bus to be shown, it can be full-colour RGB565 —
//     the objection to 16 bits a pixel was always the bus, never the tile.
function inspectPicture(t, colour) {
  const p = pictures.get(t.addr);
  const slots = slotCount(t);
  const on = glass.get(t.addr);
  // RGB565 is a slot-only format, and only on a colour panel: there is no
  // streamed form of it (§14.8 carries 1 bpp and nothing else) and a mono
  // panel has nothing to do with it.
  const canColour = slots > 0 && colour;
  const pick = (id, value) => `<select id="${id}">
      ${NAMES.map(c => `<option value="${c}" ${value === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select>`;
  const bytesLine = (p) => `${(p.bytes.length / 1024).toFixed(1)} KB`;

  return `
    <div>
      <div class="insp-title">Picture</div>
      <input type="file" id="disp-img" accept="image/*">
      ${p ? `
      <canvas class="picprev" data-pic="1" width="${t.pxW}" height="${t.pxH}"></canvas>
      <p class="muted small">${p.name.replace(/</g, '&lt;')} — ${bytesLine(p)}.
        This is how it will look on the tile, at ${t.pxW} × ${t.pxH}.</p>

      ${slots ? `<div>
        <label class="pickrow">how
          <select id="disp-dest">
            <option value="stream" ${p.dest === 'stream' ? 'selected' : ''}>send it now — two colours, sent again every time</option>
            <option value="slot" ${p.dest === 'slot' ? 'selected' : ''}>store it on the tile — shown instantly later</option>
          </select></label>
      </div>` : ''}

      ${p.dest === 'slot' ? `<div>
        <label class="pickrow">into slot
          <select id="disp-slot">
            ${Array.from({ length: slots }, (_, n) => `<option value="${n}" ${p.slot === n ? 'selected' : ''}>slot ${n}${(infoAt(t.addr, n) ? !infoAt(t.addr, n).empty : storedAt(t.addr, n)) ? ' — in use' : ''}</option>`).join('')}
          </select></label>
        ${canColour ? `<label class="pickrow">colours
          <select id="disp-fmt">
            ${Object.entries(FMT).map(([k, v]) => `<option value="${k}" ${p.fmt === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select></label>` : ''}
      </div>` : ''}

      <div class="group">
        ${p.fmt === 'rgb565'
          ? `<label class="disprow-dbl">background ${pick('disp-img-bg', p.bg)}</label>`
          : `<label class="disprow-dbl"><input type="checkbox" id="disp-inv" ${p.invert ? 'checked' : ''}> invert</label>
             ${colour ? pick('disp-img-ink', p.ink) + pick('disp-img-paper', p.paper) : ''}`}
      </div>
      ${p.bad ? '<p class="small fault">Black on black cannot be drawn. Pick another colour.</p>' : ''}

      <div class="group" style="margin-top:.5rem">
        ${p.dest === 'slot'
          ? `<button id="disp-pic-store">Store in slot ${p.slot}</button>`
          : `<button id="disp-pic-send" ${p.bad ? 'disabled' : ''}>${on?.kind === 'stream' ? 'Send again' : 'Send picture'}</button>`}
        <button id="disp-pic-drop">Discard</button>
      </div>

      ${p.dest === 'slot'
        ? `<p class="muted small">Storing takes ${p.fmt === 'rgb565' ? 'a few seconds' : 'about a second'}, once.
             If it is interrupted, the slot is left <strong>empty</strong>, never half drawn.</p>`
        : `<p class="muted small">Change the colours here as often as you like. <strong>Send picture</strong>
             takes about 0.2 s, every time it is sent.</p>`}
      ` : ''}

      <p class="muted small">A picture sent now is drawn in <strong>two colours</strong> and has to be sent
        again each time. ${slots
          ? `A stored picture stays on the tile${canColour ? ', can be <strong>full colour</strong>,' : ''} and is shown instantly.`
          : 'This tile cannot store pictures.'}</p>
      <p class="muted small">A picture stays on the panel until you press <strong>Clear</strong>; text is not drawn over it.</p>
    </div>

    ${slots ? `
    <div>
      <div class="insp-title">Slots</div>
      <p class="muted small">The tile keeps ${slots} picture${slots === 1 ? '' : 's'}. Showing one is instant, so a legend can
        change as often as you like.</p>
      <button id="slot-check">Check slots</button>
      ${Array.from({ length: slots }, (_, n) => {
        const st = storedAt(t.addr, n), info = infoAt(t.addr, n), name = nameFor(t.addr, n);
        const live = on?.kind === 'slot' && on.slot === n;
        const fmt = info && !info.empty ? info.fmt : st?.fmt;
        const len = info && !info.empty ? info.len : st?.bytes;
        const what = info?.empty
          ? '<span class="muted">empty</span>'
          : fmt
            ? `${name ? esc(name) : '<span class="muted">a picture</span>'} — ${FMT[fmt].label}, ${(len / 1024).toFixed(1)} KB`
            : '<span class="muted">not checked</span>';
        const filled = info ? !info.empty : !!st;
        return `<div class="disprow">
          <span class="mono muted disprow-n">${n}</span>
          <span class="small" style="flex:1">${what}${live ? ' · on the panel' : ''}</span>
          <button data-slot-show="${n}" ${info?.empty ? 'disabled' : ''}>Show</button>
          <button data-slot-load="${n}" ${filled ? '' : 'disabled'} title="read it back into the picture above">Load</button>
          <button data-slot-erase="${n}">Erase</button>
        </div>`;
      }).join('')}
      <p class="muted small"><strong>Check slots</strong> asks the tile what each slot holds.
        <strong>Load</strong> copies a picture back into the editor above, so you can change it or store it again
        without the original file. A colour picture takes several seconds to load.</p>
    </div>` : ''}`;
}

/**
 * Legend codes: the rumble bindings of §8.8, for a tile that has a picture
 * store to bind them to.
 *
 * Why this panel exists at all: a board in `xinput` is single-interface and
 * has no config channel (§8.3), so during a match nothing here can reach it —
 * except the XInput OUT endpoint, where `gamepad.rumble()` lands. That is too
 * narrow for text, but it carries a number, and a stored picture is switched
 * by a number (§14.9). Load the legends now; switch them mid-match with one
 * call.
 *
 * Three things this panel owes the person using it:
 *
 *   - **one entry per code.** §9.5 allows exactly one, and the board answers
 *     `rumble` to a map with two. Rows are per-code and binding replaces, so
 *     a duplicate cannot be built here in the first place.
 *   - **bind by doing.** The module reports every packet it decodes, bound or
 *     not, for precisely this (§8.8) — so arming is local and the first code
 *     that arrives takes the binding, exactly as "Press a key…" does.
 *   - **the call, not the arithmetic.** Nobody should compute c / 15.0 by
 *     hand. The block at the bottom is what goes in the OpMode.
 */
function inspectRumble(t) {
  const slots = slotCount(t);
  const mock = !!state.transport?.isMock;
  const bound = [...bindsOf(state.map)].sort((a, b) => a.code - b.code);
  const codes = Array.from({ length: RUMBLE_CODE_MAX }, (_, i) => i + 1);

  const row = (n) => {
    const b = bindFor(state.map, n);
    const here = b && b.addr === t.addr;
    const name = b && nameFor(b.addr, b.slot);
    const info = b && infoAt(b.addr, b.slot);
    const hit = lastRumble?.code === n;
    const msg = textFor(state.map, n, t.addr);
    const what = !b
      ? (msg ? `<span class="muted">message:</span> ${messageSummary(msg)}` : '<span class="muted">unbound</span>')
      : here
        ? `slot ${b.slot} — ${name ? esc(name) : info?.empty ? '<span class="muted">empty</span>'
            : info ? '<span class="muted">a picture</span>' : '<span class="muted">not checked</span>'}`
        : `<span class="muted">tile ${b.addr} · slot ${b.slot}</span>`;
    return `<div class="disprow rumblerow ${b ? 'bound' : ''} ${hit ? 'hit' : ''}" data-code="${n}">
      <span class="mono disprow-n">${n}</span>
      <span class="small" style="flex:1;min-width:0">${what}</span>
      <select data-rbind="${n}" title="${b && !here ? `bound to tile ${b.addr}; choosing a slot moves it here` : `slot on tile ${t.addr}`}">
        <option value="">—</option>
        ${Array.from({ length: slots }, (_, s) =>
          `<option value="${s}" ${here && b.slot === s ? 'selected' : ''}>slot ${s}</option>`).join('')}
      </select>
    </div>`;
  };

  const calls = bound.map(b => {
    const name = nameFor(b.addr, b.slot);
    return `${showLegendCall(b.code).padEnd(22)}// tile ${b.addr}, slot ${b.slot}${name ? ` — ${name}` : ''}`;
  }).join('\n');

  return `
    <div>
      <div class="insp-title">Legend codes</div>
      <p class="muted small">During a match the robot can reach the board only through
        <code>gamepad.rumble()</code>. Bind a rumble code to a stored picture, and one call switches this
        key's legend.</p>

      <div class="rumblelive" data-rumble-live>${liveLine()}</div>
      <p class="small" data-rumble-player>${playerLine()}</p>

      <div class="group">
        <button id="rumble-arm">${arming ? 'Cancel' : 'Bind the next code…'}</button>
        <label class="disprow-dbl">into slot
          <select id="rumble-armslot">
            ${Array.from({ length: slots }, (_, s) =>
              `<option value="${s}" ${(arming?.slot ?? 0) === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select></label>
      </div>
      <p class="muted small">The buttons keep working while this page waits for a code.</p>

      ${codes.map(row).join('')}
      <p class="muted small">Codes 1–15. <strong>Zero is never a binding</strong> —
        <code>rumble(0, 0, ms)</code> is how the FTC SDK stops a rumble, and that must not change
        what is on a screen. A code that is not bound, or whose slot is empty, does nothing.</p>

      <div class="insp-title" style="margin-top:.75rem">In the OpMode</div>
      ${bound.length ? `<pre class="ftccall">${esc(calls)}</pre>
      <div class="group">
        <button id="rumble-copy">Copy</button>
        <span class="muted small">${bound.length} code${bound.length === 1 ? '' : 's'} bound</span>
      </div>
      <p class="muted small">These use the <code>ButtonBoard</code> helper class. Without it, the same
        call is <code>${esc(rawRumbleCall(bound[0].code))}</code>.</p>`
      : '<p class="muted small">Bind a code and the exact call to put in the OpMode appears here.</p>'}

      ${mock ? `
      <div class="insp-title" style="margin-top:.75rem">Send a rumble code (demo board)</div>
      <div class="btngrid">
        ${codes.map(n => `<button class="btncell" data-rfire="${n}" title="rumble(${n}/15.0, 0, ms) → byte ${wireByte(n)}">${n}</button>`).join('')}
      </div>
      <div class="group" style="margin-top:.4rem">
        <button data-rfire="0" title="rumble(0, 0, ms)">stop (0)</button>
        <input type="number" id="rumble-raw" min="0" max="255" value="130" style="width:5rem">
        <button data-rfire="raw">send byte</button>
      </div>
      <p class="muted small">Sends a code to the demo board the way the robot would.</p>
      <p class="notice small">A real board receives rumble codes only in <code>xinput</code> mode, and this
        page cannot connect to it then. On a real board, choose a slot for each code from the list above
        instead of <strong>Bind the next code</strong>.</p>` : ''}
    </div>`;
}

function inspectDisp(t) {
  const colour = isColourPanel(t);
  // A mono tile refuses every colour bit (§14.7), so do not offer them: the
  // refusal would be an `args` indistinguishable from a bad row.
  const choices = colour ? NAMES : ['black', 'white'];
  const rows = panelRows(t);

  const pick = (kind, r, value) => `<select data-disp="${kind}" data-row="${r}">
      ${choices.map(c => `<option value="${c}" ${value === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select>`;

  return `
    <div>
      <div class="insp-title">Panel</div>
      <div class="insp-head"><strong>${t.cols} × ${t.rows}</strong>
        <span class="mono muted">${colour ? 'colour' : 'mono'} · tile ${t.addr}</span></div>
      <p class="muted small">Text longer than ${t.cols} characters is cut off.</p>
    </div>

    <div>
      <div class="insp-title">Rows</div>
      ${rows.map(({ r, row, dbl }) => `
        <div class="disprow ${dbl ? 'dbl' : ''}">
          <span class="mono muted disprow-n">${dbl ? `${r}+${r + 1}` : r}</span>
          <input type="text" data-disp="text" data-row="${r}" maxlength="${t.cols}"
                 value="${row.text.replace(/"/g, '&quot;')}" placeholder="row ${r}">
          <label class="disprow-dbl" title="double height: uses this row and the next">
            <input type="checkbox" data-disp="double" data-row="${r}" ${row.double ? 'checked' : ''}>2×</label>
          ${pick('ink', r, row.ink)}${pick('paper', r, row.paper)}
          ${unrepresentable(row.ink, row.paper) ? '<span class="small fault">black on black</span>' : ''}
        </div>`).join('')}
      <p class="muted small">${colour
        ? 'Pick a text colour and a background colour for each row.'
        : 'This panel is black and white only. Pick white on black or black on white for each row.'}</p>
    </div>

    <div>
      <div class="insp-title">Send</div>
      <div class="group">
        <button id="disp-send">Draw</button>
        <button id="disp-clear">Clear</button>
      </div>
      <p class="muted small"><strong>Draw</strong> updates every row at once, so the panel never shows a
        half-finished change.</p>
    </div>

    ${inspectMessages(t)}
    ${takesImage(t) ? inspectPicture(t, colour) : ''}
    ${slotCount(t) ? inspectRumble(t) : ''}

    <div>
      <div class="insp-title">Contrast</div>
      <input type="range" id="disp-contrast" min="0" max="255" value="${draftFor(t).contrast ?? 143}" style="width:100%">
      <p class="muted small">On a backlit panel this sets the backlight, so 0 is dark. It applies straight away.</p>
    </div>`;
}

function inspectEnc(t) {
  const e = encAt(t.addr, sel.idx) ?? {};
  const pos = t.encPos?.[sel.idx];
  const xinput = state.hello?.usb === 'xinput';
  const pulsed = !e.axis && (e.cw || e.ccw);

  const pick = (which) => `<select data-dir="${which}">
      <option value="">—</option>
      ${Array.from({ length: 32 }, (_, i) => i + 1).map(n =>
        `<option value="${n}" ${e[which] === n ? 'selected' : ''}>${n} · ${btnLabel(n)}</option>`).join('')}
    </select>`;

  return `
    <div>
      <div class="insp-title">Selected encoder</div>
      <div class="insp-head"><strong>ENC${sel.idx + 1}</strong> <span class="mono muted">tile ${t.addr}</span></div>
      <p class="muted small">Position <span class="mono">${pos ?? '—'}</span>
        <button id="zero" ${e.axis ? '' : 'disabled'}>Zero</button></p>
    </div>

    <div>
      <div class="insp-title">Axis</div>
      <div class="group">
        <button class="chip ${!e.axis ? 'sel' : ''}" data-axis="0">none</button>
        ${AXES.map(a => {
          const owner = axisOwner(a);
          const mine = owner && owner.addr === t.addr && owner.idx === sel.idx;
          const taken = owner && !mine;
          return `<button class="chip ${mine ? 'sel' : ''} ${taken ? 'taken' : ''}" data-axis="${a}"
                    title="${taken ? `already axis ${a} on tile ${owner.addr} ENC${owner.idx + 1}` : `axis ${a}`}">${a}</button>`;
        }).join('')}
      </div>
      <p class="muted small">The board has four axes in total, so two encoder tiles use them all.
        ${xinput ? 'This board is in <code>xinput</code>, which has no axes at all — the buttons below are what it will use.' : ''}</p>
      <p><label><input type="checkbox" id="invert" ${e.invert ? 'checked' : ''}> Invert — counter-clockwise counts up</label></p>
      <p><label>Scale <select id="scale">
        ${[...new Set([...SCALES, e.scale ?? SCALE_DEFAULT])].sort((a, b) => a - b).map(v =>
          `<option value="${v}" ${(e.scale ?? SCALE_DEFAULT) === v ? 'selected' : ''}>${v} · ${Math.floor(32767 / v)} clicks to full${v === SCALE_DEFAULT ? ' (default)' : ''}</option>`).join('')}
      </select></label></p>
      <p class="muted small">How far one click moves the axis. The FRC Driver Station sends axes to the robot at
        8 bits, so at 256 every click is one step the robot sees; below 256 it takes several clicks per step.
        Changing it zeroes the position.</p>
      <button id="turn">Turn the knob…</button>
    </div>

    <div>
      <div class="insp-title">Direction buttons</div>
      <div class="dirpick"><span class="muted small">clockwise</span> ${pick('cw')}</div>
      <div class="dirpick"><span class="muted small">anticlockwise</span> ${pick('ccw')}</div>
      <p class="muted small">${xinput
        ? 'Required here: in <code>xinput</code> a knob can only send a short button press for each click.'
        : pulsed
          ? 'With no axis, this knob sends a short button press for each click in <code>frc</code> too.'
          : 'Optional under <code>frc</code>, where the axis is used instead. Set them anyway and the same setup works in both modes.'}</p>
      ${e.axis && (e.cw || e.ccw) ? '<p class="muted small">Both set: the axis is used here, the buttons under <code>xinput</code>.</p>' : ''}
    </div>`;
}

export function render(root) {
  subscribe();
  // Where the reader was, before any of this is torn down. A rebuild reached
  // through app.js has already emptied the root, so that path leaves its
  // snapshot in `pendingRestore` instead.
  const snap = root.querySelector('.cfg') ? snapshotView(root) : pendingRestore;
  pendingRestore = null;
  const tiles = state.tiles.filter(t => t.state !== 'cached');
  const t = selectedTile();
  if (t) sel.addr = t.addr;
  // disp1 has no keys at all (§14.2), so the key inspector would be a dead
  // panel on the one tile whose only control is its screen.
  if (t && sel.kind === 'key' && !t.keys && hasPanel(t)) sel.kind = 'disp';
  if (t && sel.kind === 'disp' && !hasPanel(t)) { sel.kind = 'key'; sel.idx = 0; }

  if (!t) {
    root.innerHTML = `<div style="padding:1.25rem"><p>No tiles found. Check the cables between the main module and the tiles.</p></div>`;
    renderedSel = null;
    return;
  }

  const g = geom(t);
  const led = state.map?.led ?? {};
  const ledOf = (btn) => (btn && led.btn?.[btn]) || {};

  root.innerHTML = `
  <div class="cfg">
    <aside class="cfg-rail">
      <div class="rail-title">Chain</div>
      <div class="rail-list">
        ${tiles.map(x => {
          const xg = geom(x);
          return `<button class="tilecard ${x.addr === t.addr ? 'sel' : ''} ${x.state === 'lost' ? 'lost' : ''}" data-tile="${x.addr}">
            <div class="tilecard-top"><span class="tilecard-name">${xg.name}</span><span class="mono muted">addr ${x.addr}</span></div>
            <div class="mono muted tilecard-sub">${x.type} · ${x.keys} key${x.keys === 1 ? '' : 's'}${x.enc ? ` · ${x.enc} enc` : ''}${x.cols ? ` · ${x.cols}×${x.rows}` : ''}${x.state === 'lost' ? ' · lost' : ''}</div>
            <div class="tilecard-dots">
              ${Array.from({ length: x.keys }, (_, k) =>
                `<span class="dot ${bindingAt(x.addr, k) ? 'bound' : ''} ${x.pressed?.includes(k) ? 'down' : ''}"
                       data-dot="${x.addr},${k}" style="border-radius:${xg.shape === 'round' ? '999px' : '3px'}"></span>`).join('')}
              ${Array.from({ length: x.enc ?? 0 }, (_, i) =>
                `<span class="dot ring ${encAt(x.addr, i) ? 'bound' : ''}"></span>`).join('')}
            </div>
          </button>`;
        }).join('')}
      </div>
      <div class="rail-foot muted">If a tile stops answering, its buttons read as released.</div>
    </aside>

    <section class="cfg-canvas">
      <div class="cfg-head">
        <h2>${g.name} tile</h2>
        <span class="mono muted">${t.type} · uid ${t.uid} · fw ${t.fw}</span>
      </div>
      <p class="muted">${t.keys || t.enc
        ? `Click a key${t.enc ? ' or a knob' : ''} to bind it${hasPanel(t) ? ', or the panel to write to it' : ''}. Controls are laid out as they sit on the tile; K1 is the K1 printed on the tile.`
        : 'This tile has no keys — its panel is the whole of it. Type into the rows and draw.'}</p>

      <div class="tileview">
        <div class="tilestack">
          <div class="keygrid" style="grid-template-columns:repeat(${g.cols},minmax(0,1fr))">
            ${Array.from({ length: t.keys }, (_, k) => {
              const bs = buttonsAt(t.addr, k);
              const b = bs[0];
              const rgb = bs.map(x => ledOf(x).rgb).find(Boolean);
              return `<button class="keycell ${sel.kind === 'key' && k === sel.idx ? 'sel' : ''} ${b ? 'bound' : ''} ${t.pressed?.includes(k) ? 'down' : ''}"
                              data-key="${k}" style="border-radius:${g.shape === 'round' ? '999px' : '4px'}${g.cells ? `;grid-row:${g.cells[k][0]};grid-column:${g.cells[k][1]}` : ''}">
                <span class="keycell-k">K${k + 1}</span>
                <span class="keycell-b">${b ? `B${bs.join('+')}` : '—'}</span>
                ${rgb ? `<span class="keycell-led" style="background:#${rgb}"></span>` : ''}
              </button>`;
            }).join('')}
          </div>
          ${t.enc ? `<div class="encstrip">
            ${Array.from({ length: t.enc }, (_, i) => {
              const e = encAt(t.addr, i);
              return `<button class="knob ${sel.kind === 'enc' && i === sel.idx ? 'sel' : ''} ${e ? 'bound' : ''}" data-enc="${i}">
                ${KNOB}
                <span class="keycell-k">ENC${i + 1}</span>
                <span class="knob-b">${encSummary(e)}</span>
              </button>`;
            }).join('')}
          </div>` : ''}
          ${hasPanel(t) ? panelView(t) : ''}
        </div>
      </div>
      ${hasDebounce(t) ? debounceView(t) : ''}
      ${encoderNote(t) ? `<p class="muted small">${encoderNote(t)}</p>` : ''}
      ${displayNote(t) ? `<p class="muted small">${displayNote(t)}</p>` : ''}

      <div class="legend muted">
        <span class="swatch"></span>unbound
        <span class="swatch bound"></span>bound
        <span class="swatch sel"></span>selected
        <span class="swatch down"></span>pressed now
      </div>
    </section>

    <aside class="cfg-inspect">
      ${sel.kind === 'disp' ? inspectDisp(t) : sel.kind === 'enc' ? inspectEnc(t) : inspectKey(t)}
    </aside>
  </div>`;

  // The canvases are in the DOM now but carry no pixels until something puts
  // them there, and a re-render makes new ones every time.
  paintPictures(root, t);

  // Back where you were: the three columns' scroll offsets and the control
  // that had focus, unless the selection itself changed.
  restoreView(root, snap);
  renderedSel = { ...sel };

  root.onchange = async (e) => {
    const el = e.target;
    if (el.id === 'debounce') {
      const v = Math.round(+el.value);
      if (!(v >= 1 && v <= 255)) { setStatus('Debounce is 1 to 255 ms', 'fault'); return render(root); }
      const def = defaultDebounce(t.type);
      await pushMap(m => {
        m.debounce = { ...(m.debounce ?? {}) };
        if (v === def) delete m.debounce[t.addr]; else m.debounce[t.addr] = v;
      }, `Debounce ${v} ms on tile ${t.addr}${v === def ? ' (default)' : ''} (unsaved)`);
      await refreshTiles({ rerender: false });
      return render(root);
    }
    if (el.id === 'scale') {
      const v = +el.value;
      await pushMap(m => {
        m.enc = m.enc ?? [];
        const cur = m.enc.find(x => x.addr === t.addr && x.idx === sel.idx);
        if (cur) cur.scale = v;
        else m.enc.push({ addr: t.addr, idx: sel.idx, invert: false, scale: v });
      }, `Scale ${v} — ${Math.floor(32767 / v)} clicks to full (unsaved)`);
      return render(root);
    }
    if (el.id === 'invert') {
      await pushMap(m => {
        m.enc = m.enc ?? [];
        const cur = m.enc.find(x => x.addr === t.addr && x.idx === sel.idx);
        if (cur) cur.invert = el.checked;
        else m.enc.push({ addr: t.addr, idx: sel.idx, invert: el.checked });
      }, el.checked ? 'Rotation inverted' : 'Rotation normal');
      return render(root);
    }
    if (el.id === 'disp-contrast') {
      draftFor(t).contrast = +el.value;
      try {
        await state.client.dispContrast(t.addr, +el.value);
        setStatus(`Contrast ${el.value} on tile ${t.addr}`, 'ok');
      } catch (err) { setStatus(`Display: ${err.message}`, 'fault'); }
      return;                                  // no re-render: it would drop the slider
    }
    // Choosing a file stages and dithers it; nothing goes near the bus until
    // Send picture. The old behaviour sent on the change event, which spent
    // the slot before anyone could see what the dither had done to the image.
    if (el.id === 'disp-img') {
      const file = el.files?.[0];
      el.value = '';
      if (!file) return;
      try {
        const bitmap = await createImageBitmap(file);
        dropPicture(t.addr);
        pictures.set(t.addr, {
          bitmap, name: file.name, invert: false,
          // Streaming is the default even on a tile with slots: it is the
          // cheaper thing to try, and spending 2-4 s of bus is a decision
          // someone should make rather than fall into. 1 bpp for the same
          // reason — the format follows the destination, since RGB565 exists
          // only in a slot (§14.9).
          dest: 'stream', fmt: '1bpp', slot: 0,
          // The letterbox and the backdrop for transparency in RGB565. Black
          // because the panel's own paper is black and a bar that matches the
          // bezel reads as no bar at all.
          bg: 'black',
          // Black on white, which is not the text default and should not be:
          // a set bit is ink and the dither sets the DARK pixels, so white ink
          // would hand back a photographic negative of the file. This pairing
          // reproduces the picture's own tonality.
          //
          // It costs no colour bit either. Black ink has no palette index, so
          // §14.7 reaches it through inverse, and white is index 0's own
          // resolution — the pair comes out as ATTR 1, which a panel without
          // CAP_DISP_COLOR accepts as readily as a colour one.
          ink: 'black', paper: 'white',
        });
        reencode(t);
        setStatus(`${file.name} dithered to ${t.pxW} × ${t.pxH} — check it, then send or store it`, 'ok');
      } catch (err) { setStatus(`Picture: ${err.message}`, 'fault'); }
      return render(root);
    }

    // Format, destination, ink, paper and invert only ever touch the staged
    // copy: re-encoding is free, and the point of the preview is to try them
    // without the bus.
    if (['disp-inv', 'disp-img-ink', 'disp-img-paper', 'disp-img-bg',
         'disp-fmt', 'disp-dest', 'disp-slot'].includes(el.id)) {
      const p = pictures.get(t.addr);
      if (!p) return;
      if (el.id === 'disp-inv') p.invert = el.checked;
      if (el.id === 'disp-img-ink') p.ink = el.value;
      if (el.id === 'disp-img-paper') p.paper = el.value;
      if (el.id === 'disp-img-bg') p.bg = el.value;
      if (el.id === 'disp-fmt') p.fmt = el.value;
      if (el.id === 'disp-slot') p.slot = +el.value;
      if (el.id === 'disp-dest') {
        p.dest = el.value;
        // A streamed picture is 1 bpp and nothing else (§14.8), so switching
        // back to streaming takes the format with it rather than leaving a
        // colour picture staged for a command that cannot carry one.
        if (p.dest === 'stream') p.fmt = '1bpp';
      }
      reencode(t);
      return render(root);
    }
    // A code's slot. Choosing one binds it to THIS tile, which is also how a
    // code bound to another tile is moved here; the empty option clears it.
    // Either way the code can only have the one entry (§9.5).
    if (el.dataset.rbind) {
      const code = +el.dataset.rbind;
      if (el.value === '') {
        await pushMap(m => { m.rumble = withoutBind(m.rumble, code); }, `Code ${code} unbound`);
        return render(root);
      }
      return bindCode(code, t.addr, +el.value);
    }
    if (el.id === 'rumble-armslot') {
      if (arming) arming.slot = +el.value;
      return;                              // no re-render: it would drop the picker
    }
    if (el.id === 'rled-code') { rledCode = +el.value; return render(root); }   // the call text follows
    if (el.id === 'msg-code') { msgCode = +el.value; return render(root); }     // the button follows
    if (el.id === 'rled-fx') { rledFx = el.value; return; }
    if (el.dataset.disp) {
      const d = draftFor(t), r = +el.dataset.row;
      if (el.dataset.disp === 'text')   d[r].text = ascii(el.value);
      if (el.dataset.disp === 'ink')    d[r].ink = el.value;
      if (el.dataset.disp === 'paper')  d[r].paper = el.value;
      if (el.dataset.disp === 'double') d[r].double = el.checked;
      return render(root);
    }
    if (el.dataset.dir) {
      const n = el.value ? +el.value : undefined;
      await pushMap(m => {
        m.enc = m.enc ?? [];
        let cur = m.enc.find(x => x.addr === t.addr && x.idx === sel.idx);
        if (!cur) { cur = { addr: t.addr, idx: sel.idx }; m.enc.push(cur); }
        if (n) cur[el.dataset.dir] = n; else delete cur[el.dataset.dir];
      }, n ? `${el.dataset.dir === 'cw' ? 'Clockwise' : 'Anticlockwise'} → ${btnLabel(n)}` : 'Direction button cleared');
      return render(root);
    }
  };

  root.onclick = async (e) => {
    const el = e.target.closest('[data-tile],[data-key],[data-enc],[data-disp-sel],[data-btn],[data-combo],#combo,[data-un],[data-rgb],[data-fx],[data-axis],#press,#turn,#zero,#disp-send,#disp-clear,#disp-pic-send,#disp-pic-drop,#disp-pic-store,[data-slot-show],[data-slot-erase],[data-rfire],#rumble-arm,#rumble-copy,[data-rled-rgb],[data-rled-del],#debounce-reset,#slot-check,[data-slot-load],#msg-save,[data-msg-load],[data-msg-del]');
    if (!el) return;

    if (el.id === 'debounce-reset') {
      await pushMap(m => { m.debounce = { ...(m.debounce ?? {}) }; delete m.debounce[t.addr]; },
        `Debounce on tile ${t.addr} back to the default, ${defaultDebounce(t.type)} ms (unsaved)`);
      await refreshTiles({ rerender: false });
      return render(root);
    }

    // Bind by doing (§8.8). Nothing goes to the board: the event is already
    // coming, bound or not, so arming is this page's own state and the first
    // code that is not zero takes the binding.
    if (el.id === 'rumble-arm') {
      if (arming) {
        disarm();
        setStatus('Waiting for a code cancelled', 'ok');
      } else {
        const slot = +(root.querySelector('#rumble-armslot')?.value ?? 0);
        arming = { addr: t.addr, slot, timer: setTimeout(() => {
          disarm();
          setStatus('No rumble code in 30 s — stopped waiting', 'fault');
          if (state.screen === 'configure') rerenderKeepingScroll();
        }, ARM_TIMEOUT_MS) };
        setStatus(`Send the code you want on slot ${slot} — rumble(c / 15.0, 0, ms)…`, 'fault');
      }
      return render(root);
    }

    if (el.id === 'msg-save') {
      const msg = rowsAsMessage(t);
      if (!msg) return setStatus('Black on black cannot be drawn', 'fault');
      const had = textFor(state.map, msgCode, t.addr), pic = bindFor(state.map, msgCode);
      await pushMap(m => { m.rumble = withText(m.rumble, msgCode, t.addr, msg.rows, msg.attrs); },
        `Code ${msgCode} → this message on tile ${t.addr}${had ? ' (replaced)' : ''}`
        + (pic && pic.addr === t.addr ? ` instead of picture slot ${pic.slot}` : '') + ` — ${showLegendCall(msgCode)}`);
      return render(root);
    }
    if (el.dataset.msgLoad) {
      const e2 = textFor(state.map, +el.dataset.msgLoad, t.addr);
      if (e2) {
        drafts.set(t.addr, messageRows(t, e2));
        msgCode = e2.code;
        setStatus(`Code ${e2.code}'s message is in the rows. Draw shows it; Replace saves your changes`, 'ok');
      }
      return render(root);
    }
    if (el.dataset.msgDel) {
      const code = +el.dataset.msgDel;
      await pushMap(m => { m.rumble = withoutText(m.rumble, code, t.addr); }, `Code ${code}'s message on tile ${t.addr} removed`);
      return render(root);
    }

    if (el.id === 'rumble-copy') {
      const text = root.querySelector('.ftccall')?.textContent ?? '';
      try { await navigator.clipboard.writeText(text); setStatus('OpMode calls copied', 'ok'); }
      catch { setStatus('Copy refused by the browser — select the block instead', 'fault'); }
      return;
    }

    // Mock only: put a packet on the fake board's OUT endpoint. It comes back
    // as an `ev:rumble` like any other, so nothing below this line knows the
    // difference between this and a Driver Station.
    if (el.dataset.rfire != null) {
      const tr = state.transport;
      if (!tr?.isMock) return;
      if (el.dataset.rfire === 'raw') {
        const v = Math.min(255, Math.max(0, Math.trunc(+root.querySelector('#rumble-raw').value || 0)));
        tr.rumbleBytes(v, 0);
      } else {
        tr.rumble(sendValue(+el.dataset.rfire), 0);
      }
      return;
    }

    if (el.dataset.tile) { sel = { addr: +el.dataset.tile, kind: 'key', idx: 0 }; return render(root); }
    if (el.dataset.key)  { sel.kind = 'key'; sel.idx = +el.dataset.key; return render(root); }
    if (el.dataset.enc)  { sel.kind = 'enc'; sel.idx = +el.dataset.enc; return render(root); }
    if (el.dataset.dispSel) { sel.kind = 'disp'; return render(root); }

    if (el.id === 'disp-send') {
      const d = draftFor(t);
      const bad = panelRows(t).find(({ row }) => unrepresentable(row.ink, row.paper));
      if (bad) return setStatus('Black on black cannot be drawn', 'fault');
      try {
        let n = 0;
        for (const { r, row, dbl } of panelRows(t)) {
          // Pad to the panel width: the tile writes exactly the characters it
          // is given and never blanks the rest of a row itself (§14.4), so the
          // trailing spaces are what erase whatever was longer before.
          const text = ascii(row.text).slice(0, t.cols).padEnd(t.cols, ' ');
          const attr = attrByte({ ink: row.ink, paper: row.paper, double: dbl });
          // Only what changed. A row costs an auxiliary slot (§3.2), and the
          // style is part of the key so a recolour still redraws.
          const key = `${attr}:${text}`;
          if (d[r].sent === key) continue;
          await state.client.dispText(t.addr, r, text, { attr });
          d[r].sent = key;
          n++;
        }
        if (n) await state.client.dispShow(t.addr);
        setStatus(n ? `Sent ${n} row${n === 1 ? '' : 's'} to tile ${t.addr}` : 'Panel already matches', 'ok');
      } catch (err) { setStatus(`Display: ${err.message}`, 'fault'); }
      return;
    }

    if (el.id === 'disp-pic-send') {
      const p = pictures.get(t.addr), d = draftFor(t);
      if (!p || p.bad || !p.bits) return;
      try {
        const chunks = imageChunks(p.bits, t.pxW);
        // A picture is ~180 ms of auxiliary slot (§3.2 carries one command per
        // poll cycle), so it gets a count rather than one hopeful line before
        // a silence.
        let n = 0;
        for (const { row, hex } of chunks) {
          setStatus(`Sending picture to tile ${t.addr} — ${Math.round(100 * ++n / chunks.length)} %`, 'ok');
          await state.client.dispImage(t.addr, row, p.attr, hex);
        }
        takePanel(t, { kind: 'stream', pic: snapshot(p) });
        setStatus(`Picture sent to tile ${t.addr}`, 'ok');
      } catch (err) { setStatus(`Picture: ${err.message}`, 'fault'); }
      return render(root);
    }

    // §14.9: BEGIN, every DATA chunk at an ascending offset, END with the CRC.
    // The one operation on this page measured in seconds, so it counts chunks
    // off as it goes — a colour picture is 512 of them.
    if (el.id === 'disp-pic-store') {
      const p = pictures.get(t.addr);
      if (!p || p.bad) return;
      const slot = p.slot, fmt = p.fmt;
      const chunks = slotChunks(p.bytes);
      const crc = slotCrc(p.bytes);
      // Erased at BEGIN and not a picture again until END passes, so this
      // page's record of the slot goes now rather than at the end: if the
      // store stops anywhere in between, the slot really is empty.
      stored.delete(`${t.addr}:${slot}`);
      slotInfo.delete(`${t.addr}:${slot}`);
      if (glass.get(t.addr)?.kind === 'slot' && glass.get(t.addr).slot === slot) glass.delete(t.addr);
      try {
        setStatus(`Storing ${p.name} in tile ${t.addr} slot ${slot}…`, 'ok');
        await state.client.dispSlotStore(t.addr, slot, FMT[fmt].code, p.attr, chunks, crc,
          (done, total, n) => {
            // Every chunk is a DOM write otherwise, and 512 of them in a row
            // is the one place this page could make itself the bottleneck.
            const at = Math.round(done / 64);
            if (at % 8 && done < total) return;
            setStatus(`Storing in tile ${t.addr} slot ${slot} — ${Math.round(100 * done / total)} %`, 'ok');
          });
        stored.set(`${t.addr}:${slot}`, { name: p.name, fmt, bytes: p.bytes.length, crc, pic: snapshot(p) });
        slotInfo.set(`${t.addr}:${slot}`, { empty: false, fmt, attr: p.attr, len: p.bytes.length, crc });
        setStatus(`Slot ${slot} on tile ${t.addr} holds ${p.name}. Press Show to put it on the panel`, 'ok');
      } catch (err) {
        // `flash` (and `crc`, which a stricter sender may see) is the one
        // error that does not mean "it did not go": it means the bytes
        // arrived changed, and §14.9 leaves the slot empty for it.
        setStatus(['flash', 'crc'].includes(err.message)
          ? `Slot ${slot} on tile ${t.addr}: the picture arrived damaged, so the slot was left empty. Try again`
          : `Slot ${slot}: ${err.message} — the slot stays empty until a store finishes`, 'fault');
      }
      return render(root);
    }

    if (el.dataset.slotShow != null) {
      const slot = +el.dataset.slotShow, st = storedAt(t.addr, slot);
      try {
        await state.client.dispSlotShow(t.addr, slot);
        // One frame, read from the tile's own flash. What it looks like is
        // only known when this page is the one that filled the slot.
        takePanel(t, { kind: 'slot', slot, pic: st?.pic });
        setStatus(`Tile ${t.addr} showing slot ${slot}${st ? ` — ${st.name}` : ''}`, 'ok');
      } catch (err) {
        if (err.message === 'args') slotInfo.set(`${t.addr}:${slot}`, { empty: true });
        setStatus(err.message === 'args'
          ? `Slot ${slot} on tile ${t.addr} is empty, so there is nothing to show`
          : `Slot ${slot}: ${err.message}`, 'fault');
      }
      return render(root);
    }

    // INFO for every slot (§14.9): one frame each, so a whole store is checked
    // in well under a second.
    if (el.id === 'slot-check') {
      try {
        for (let n = 0; n < slotCount(t); n++) {
          setStatus(`Checking tile ${t.addr} slot ${n} of ${slotCount(t)}…`, 'ok');
          const r = await state.client.dispSlotInfo(t.addr, n);
          slotInfo.set(`${t.addr}:${n}`, r.empty ? { empty: true }
            : { empty: false, fmt: r.fmt, attr: r.attr, len: r.len, crc: r.crc });
        }
        const used = Array.from({ length: slotCount(t) }, (_, n) => infoAt(t.addr, n)).filter(i => !i.empty).length;
        setStatus(`Tile ${t.addr}: ${used} of ${slotCount(t)} slots hold a picture`, 'ok');
      } catch (err) {
        setStatus(err.message === 'args'
          ? `Tile ${t.addr} cannot report its slots: update its firmware on the Firmware tab`
          : `Check slots: ${err.message}`, 'fault');
      }
      return render(root);
    }

    // READ a stored picture back into the editor (§14.9), so it can be
    // recoloured, re-encoded or stored again without the file it came from.
    if (el.dataset.slotLoad != null) {
      const slot = +el.dataset.slotLoad, key = `${t.addr}:${slot}`;
      try {
        setStatus(`Reading tile ${t.addr} slot ${slot}…`, 'ok');
        const r = await state.client.dispSlotReadAll(t.addr, slot, (done, total) => {
          if (done % 1024 && done < total) return;
          setStatus(`Reading tile ${t.addr} slot ${slot} — ${Math.round(100 * done / total)} %`, 'ok');
        });
        if (!r) {
          slotInfo.set(key, { empty: true });
          setStatus(`Slot ${slot} on tile ${t.addr} is empty`, 'ok');
          return render(root);
        }
        slotInfo.set(key, { empty: false, fmt: r.fmt, attr: r.attr, len: r.len, crc: r.crc });
        // The editor works from a bitmap, so paint the stored pixels into one.
        // A 1 bpp picture is painted black on white: the dither sets the dark
        // pixels, so re-encoding gives back exactly the stored bits, and its
        // own ink and paper come back as the editor's choices.
        const canvas = new OffscreenCanvas(t.pxW, t.pxH);
        if (r.fmt === 'rgb565') paintRgb565(canvas, r.bytes, t.pxW, t.pxH);
        else paint1bpp(canvas, r.bytes, t.pxW, t.pxH, attrByte({ ink: 'black', paper: 'white' }));
        const bitmap = await createImageBitmap(canvas);
        const name = nameFor(t.addr, slot) ?? `slot ${slot} of tile ${t.addr}`;
        const { ink, paper } = r.fmt === '1bpp' ? inkPaperOf(r.attr) : { ink: 'black', paper: 'white' };
        dropPicture(t.addr);
        pictures.set(t.addr, { bitmap, name, invert: false, dest: 'slot', fmt: r.fmt, slot, bg: 'black', ink, paper });
        reencode(t);
        stored.set(key, { name, fmt: r.fmt, bytes: r.len, crc: r.crc,
                          pic: { fmt: r.fmt, attr: r.attr, bits: r.fmt === '1bpp' ? r.bytes : null, bytes: r.bytes } });
        setStatus(`Loaded slot ${slot} from tile ${t.addr}. Change it, then store it again`, 'ok');
      } catch (err) {
        setStatus(err.message === 'args'
          ? `Tile ${t.addr} cannot load slots: update its firmware on the Firmware tab`
          : `Load slot ${slot}: ${err.message}`, 'fault');
      }
      return render(root);
    }

    if (el.dataset.slotErase != null) {
      const slot = +el.dataset.slotErase;
      try {
        await state.client.dispSlotErase(t.addr, slot);
        stored.delete(`${t.addr}:${slot}`);
        slotInfo.set(`${t.addr}:${slot}`, { empty: true });
        const on = glass.get(t.addr);
        if (on?.kind === 'slot' && on.slot === slot) glass.delete(t.addr);
        setStatus(`Slot ${slot} on tile ${t.addr} erased`, 'ok');
      } catch (err) { setStatus(`Slot ${slot}: ${err.message}`, 'fault'); }
      return render(root);
    }

    if (el.id === 'disp-pic-drop') {
      // Only the staged copy: what is on the glass stays there until Clear.
      dropPicture(t.addr);
      setStatus('Picture discarded — the panel keeps whatever it is showing', 'ok');
      return render(root);
    }

    if (el.id === 'disp-clear') {
      const d = draftFor(t);
      for (const row of d) { row.text = ''; row.double = false; delete row.sent; }
      // CLEAR is what takes the panel back from a picture, streamed or stored
      // (§14.8, §14.9), so the preview stops claiming one is there. The staged
      // copy and the slots both survive: clearing the glass is not a reason to
      // make you pick the file again, and it is not an erase.
      glass.delete(t.addr);
      try {
        await state.client.dispClear(t.addr);
        await state.client.dispShow(t.addr);
        setStatus(`Panel on tile ${t.addr} cleared`, 'ok');
      } catch (err) { setStatus(`Display: ${err.message}`, 'fault'); }
      return render(root);
    }

    if (el.dataset.axis) {
      const a = +el.dataset.axis;
      const owner = axisOwner(a);
      if (a && owner && !(owner.addr === t.addr && owner.idx === sel.idx)) {
        return setStatus(`Axis ${a} is already tile ${owner.addr} ENC${owner.idx + 1}`, 'fault');
      }
      await pushMap(m => {
        m.enc = m.enc ?? [];
        let cur = m.enc.find(x => x.addr === t.addr && x.idx === sel.idx);
        if (!cur) { cur = { addr: t.addr, idx: sel.idx, invert: false }; m.enc.push(cur); }
        if (a) cur.axis = a; else delete cur.axis;
      }, a ? `ENC${sel.idx + 1} → axis ${a}` : `ENC${sel.idx + 1} off the axes`);
      return render(root);
    }

    if (el.id === 'zero') {
      const cur = encAt(t.addr, sel.idx);
      try { await state.client.encZero(cur?.axis); setStatus(`Axis ${cur.axis} zeroed`, 'ok'); }
      catch (err) { setStatus(`Zero: ${err.message}`, 'fault'); }
      await refreshTiles({ rerender: false });
      return render(root);
    }

    if (el.id === 'turn') {
      const cur = encAt(t.addr, sel.idx);
      const axis = cur?.axis ?? AXES.find(a => !axisOwner(a));
      if (!axis) return setStatus('All four axes are taken', 'fault');
      setStatus(`Turn the knob you want as axis ${axis}…`, 'fault');
      try {
        const r = await state.client.bindAxis(axis);
        setStatus(`Axis ${axis} ← tile ${r.addr} ENC${r.idx + 1}`, 'ok');
        sel = { addr: r.addr, kind: 'enc', idx: r.idx };
      } catch (err) { setStatus(`Bind: ${err.message}`, 'fault'); }
      await refreshMap(); await refreshTiles({ rerender: false });
      return render(root);
    }

    if (el.id === 'combo') { comboMode = !comboMode; return render(root); }

    if (el.dataset.combo) {
      const want = el.dataset.combo.split('+').map(Number);
      await pushMap(m => {
        m.bind = m.bind.filter(b => !(b.addr === t.addr && b.key === sel.idx));
        for (const n of want) m.bind.push({ btn: n, addr: t.addr, key: sel.idx });
      }, `K${sel.idx + 1} → ${want.map(btnLabel).join(' + ')}`);
      return render(root);
    }

    if (el.dataset.btn) {
      const n = +el.dataset.btn;
      const was = buttonsAt(t.addr, sel.idx);
      const here = b => b.addr === t.addr && b.key === sel.idx;
      if (comboMode) {
        const on = was.includes(n);
        await pushMap(m => {
          if (on) m.bind = m.bind.filter(b => !(here(b) && b.btn === n));
          else m.bind.push({ btn: n, addr: t.addr, key: sel.idx });
        }, `K${sel.idx + 1} → ${(on ? was.filter(x => x !== n) : [...was, n].sort((a, b) => a - b)).map(btnLabel).join(' + ') || 'unbound'}`);
        return render(root);
      }
      const only = was.length === 1 && was[0] === n;
      await pushMap(m => {
        m.bind = m.bind.filter(b => !here(b));
        if (!only) m.bind.push({ btn: n, addr: t.addr, key: sel.idx });
      }, only ? `K${sel.idx + 1} unbound` : `K${sel.idx + 1} → ${btnLabel(n)}`);
      return render(root);
    }

    if (el.dataset.un) {
      const [addr, key] = el.dataset.un.split(',').map(Number);
      await pushMap(m => { m.bind = m.bind.filter(b => !(b.addr === addr && b.key === key)); }, 'Source removed');
      return render(root);
    }

    if (el.dataset.rledRgb) {
      const btn = bindingAt(t.addr, sel.idx); if (!btn) return;
      const rgb = el.dataset.rledRgb, code = rledCode;
      await pushMap(m => { m.rumble = withLedAction(m.rumble, code, btn, rgb, rledFx); },
        `Code ${code} → ${rgb === 'map' ? 'default colour' : rgb === 'off' ? 'LED off' : `#${rgb}`} on ${btnLabel(btn)} (unsaved)`);
      return render(root);
    }
    if (el.dataset.rledDel) {
      const btn = bindingAt(t.addr, sel.idx); if (!btn) return;
      const code = +el.dataset.rledDel;
      await pushMap(m => { m.rumble = withoutLedAction(m.rumble, code, btn); },
        `Code ${code} no longer recolours ${btnLabel(btn)} (unsaved)`);
      return render(root);
    }

    if (el.dataset.rgb) {
      const btn = bindingAt(t.addr, sel.idx); if (!btn) return;
      await pushMap(m => {
        m.led = m.led ?? {}; m.led.btn = m.led.btn ?? {};
        if (el.dataset.rgb === 'off') delete m.led.btn[btn];
        else m.led.btn[btn] = { ...(m.led.btn[btn] ?? {}), rgb: el.dataset.rgb };
      }, 'LED colour set (unsaved)');
      return render(root);
    }

    if (el.dataset.fx) {
      const btn = bindingAt(t.addr, sel.idx); if (!btn) return;
      await pushMap(m => {
        m.led = m.led ?? {}; m.led.btn = m.led.btn ?? {};
        m.led.btn[btn] = { ...(m.led.btn[btn] ?? {}), fx: el.dataset.fx };
      }, `LED effect ${el.dataset.fx} (unsaved)`);
      return render(root);
    }

    if (el.id === 'press') {
      // A combo key re-binds as the same combo: `bind 8+1` (§9.2).
      const btns = buttonsAt(t.addr, sel.idx);
      const want = btns.length > 1 ? btns : [btns[0] ?? nextFreeButton()];
      const name = want.map(btnLabel).join(' + ');
      setStatus(`Press the key you want as ${name}…`, 'fault');
      try {
        const r = want.length > 1 ? await state.client.bindCombo(want) : await state.client.bind(want[0]);
        setStatus(`${name} ← tile ${r.addr} K${r.key + 1}`, 'ok');
        sel = { addr: r.addr, kind: 'key', idx: r.key };
      } catch (err) { setStatus(`Bind: ${err.message}`, 'fault'); }
      await refreshMap(); await refreshTiles({ rerender: false });
      return render(root);
    }
  };
}

function nextFreeButton() {
  const used = new Set((state.map?.bind ?? []).map(b => b.btn));
  for (let n = 1; n <= 32; n++) if (!used.has(n)) return n;
  return 1;
}

// Live pressed indicators and encoder positions without rebuilding the screen:
// a 250 ms full re-render would fight every click and drop the inspector.
export function tick(root) {
  // The rumble line ages ("2 s ago") and the highlight follows the last code,
  // both patched rather than rebuilt for the same reason as everything else
  // here: a re-render fights the click someone is in the middle of.
  patchRumble(root);
  for (const el of root.querySelectorAll('[data-dot]')) {
    const [addr, key] = el.dataset.dot.split(',').map(Number);
    const t = state.tiles.find(x => x.addr === addr);
    el.classList.toggle('down', !!t?.pressed?.includes(key));
  }
  const t = selectedTile();
  if (!t) return;
  for (const el of root.querySelectorAll('[data-key]')) {
    el.classList.toggle('down', !!t.pressed?.includes(+el.dataset.key));
  }
  if (sel.kind === 'enc' && t.encPos) {
    const out = root.querySelector('.insp-head + p .mono');
    if (out) out.textContent = t.encPos[sel.idx] ?? '—';
  }
}
