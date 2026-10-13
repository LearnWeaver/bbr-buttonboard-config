// Fake main module for UI development. Implements enough of PROTOCOL.md §9
// to drive every screen: three tiles, a map with one group, random key
// presses, and bind mode that "presses" a key after a second.
// TILESM_CMD_QUEUE, and the slot period the host simulator measures on a
// four-tile chain (firmware/host/test/test_sim_integration.c).
import { crc16Running } from '../util.js';
import { defaultDebounce } from '../tilegeom.js';
import { decodeXinputOut, rumblePacket, playerPacket, sdkByte, validateBinds,
         bindsOf, applyLedActions } from '../rumble.js';

const AUX_QUEUE_DEPTH = 8;
// RUMBLE_ACT_MIN_US from firmware/core/lineproto.h, in the milliseconds a
// browser counts in. One SHOW per 50 ms, which is also the SDK's own drain
// interval: both ends of the wire agree that newest wins and the floor is the
// same (§8.8).
const RUMBLE_ACT_MIN_MS = 50;
// §14.9's flash is busy for tens of ms after an erase and ~0.7 ms after a page
// program, and it NAKs rather than blocking -- the tile keeps answering POLL
// throughout, which is why the store is a separate part at all.
const FLASH_ERASE_MS = 30;
const FLASH_PROGRAM_MS = 0.7;
// FMT 0x02 is two bytes a pixel; FMT 0x01 is §14.8's 1 bpp encoding.
const SLOT_FMT = { '1bpp': 1, rgb565: 2 };
const AUX_SLOT_MS = 6;

export class MockTransport {
  static supported() { return true; }
  // The one thing a screen may legitimately ask about the transport: the
  // rumble injector below exists here and nowhere else, so Configure offers
  // its control only against the fake board.
  isMock = true;
  constructor() {
    this.lineCb = () => {};
    this.usb = 'frc';
    this.pixel = true;                     // §8.6 status pixel
    this.tiles = [
      { addr: 1, type: 'mx9',  uid: 'A3F2C1', uidFull: '1E2F3A4B5C6D7E8FA3F2C1'.slice(0,20), fw: '1.0.1', proto: 1, keys: 9, leds: 9, caps: 7, state: 'online', crcErr: 0, missed: 0, lastSeen: 3, pressed: [], debounce: 5 },
      { addr: 2, type: 'arc4', uid: '77B01E', uidFull: '00112233445566777B01E0'.slice(0,20), fw: '1.0.1', proto: 1, keys: 4, leds: 0, caps: 3, state: 'online', crcErr: 2, missed: 1, lastSeen: 1, pressed: [], debounce: 20 },
      { addr: 3, type: 'mx9',  uid: '0C9D42', uidFull: 'AABBCCDDEEFF00110C9D42'.slice(0,20), fw: '1.0.0', proto: 1, keys: 9, leds: 0, caps: 3, state: 'lost',   crcErr: 14, missed: 88, lastSeen: 4021, pressed: [], debounce: 5 },
      // CAP_BOOTLOADER | CAP_DEBOUNCE | CAP_ENCODER = 11 (PROTOCOL.md §5, §15)
      { addr: 4, type: 'enc2', uid: '7C11B0', uidFull: 'BEEF00112233445566AA'.slice(0,20), fw: '1.0.0', proto: 1, keys: 2, leds: 0, enc: 2, encPos: [0, 0], caps: 11, state: 'online', crcErr: 0, missed: 0, lastSeen: 2, pressed: [], debounce: 5 },
      // CAP_BOOTLOADER | CAP_DEBOUNCE | CAP_DISPLAY | CAP_DISP_COLOR = 83: the
      // colour key of §14.7, whose panel geometry comes from the descriptor.
      // A mono panel as well as the colour one: the two take different paths
      // through the display UI, since a tile without CAP_DISP_COLOR refuses
      // every colour bit (§14.7) and must not be offered them.
      { addr: 6, type: 'disp1', uid: 'D19A02', uidFull: 'D19A0200112233445566'.slice(0,20), fw: '0.1.0', proto: 1, keys: 0, leds: 0, caps: 19, cols: 21, rows: 4, state: 'online', crcErr: 0, missed: 0, lastSeen: 3, pressed: [], debounce: 20 },
      // `slots` is the §14.9 advertisement: a picture store is a part on the
      // tile, not a capability bit, so its absence is the answer to "can this
      // tile keep a picture?" exactly as pxW/pxH answer "can it take one?".
      { addr: 5, type: 'screenkey1', uid: '5C7E01', uidFull: 'C0FFEE00112233445566'.slice(0,20), fw: '0.1.0', proto: 1, keys: 1, leds: 0, caps: 83, cols: 10, rows: 8, pxW: 128, pxH: 128, slots: 32, state: 'online', crcErr: 0, missed: 0, lastSeen: 2, pressed: [], debounce: 8 },
      // RGB builds of mx4 and mx1 are the same TYPE with CAP_LEDS and an LED
      // per key (board_mx4.h, board_mx1.h): caps 7 = BOOTLOADER | DEBOUNCE | LEDS.
      { addr: 7, type: 'mx4', uid: '4A11C7', uidFull: '4A11C700112233445566'.slice(0,20), fw: '0.1.0', proto: 1, keys: 4, leds: 4, caps: 7, state: 'online', crcErr: 0, missed: 0, lastSeen: 2, pressed: [], debounce: 5 },
      { addr: 8, type: 'mx1', uid: '1B0D58', uidFull: '1B0D5800112233445566'.slice(0,20), fw: '0.1.0', proto: 1, keys: 1, leds: 1, caps: 7, state: 'online', crcErr: 0, missed: 0, lastSeen: 3, pressed: [], debounce: 5 },
      // The 1.8" colour display (board_disp2.h): no keys, 160 x 128 landscape,
      // 13 x 8 cells of the 12x16 font, a picture store like screenkey1's.
      { addr: 9, type: 'disp2', uid: 'D2C0A9', uidFull: 'D2C0A900112233445566'.slice(0,20), fw: '0.1.0', proto: 1, keys: 0, leds: 0, caps: 83, cols: 13, rows: 8, pxW: 160, pxH: 128, slots: 32, state: 'online', crcErr: 0, missed: 0, lastSeen: 2, pressed: [], debounce: 5 },
    ];
    this.map = { v: 1, name: 'mock layout', bind: [
      { btn: 1, addr: 1, key: 0 }, { btn: 1, addr: 1, key: 1 }, { btn: 1, addr: 1, key: 3 }, { btn: 1, addr: 1, key: 4 },   // 2x2 group
      { btn: 2, addr: 1, key: 2 }, { btn: 7, addr: 2, key: 0 }, { btn: 8, addr: 2, key: 1 },
    ], enc: [
      { axis: 1, addr: 4, idx: 0, invert: false, cw: 9, ccw: 10 },
    ],
    // No rumble bindings to start with (§8.8): a code with no entry does
    // nothing, and the panel is the place those get bound by doing.
    rumble: [], debounce: {}, led: { brightness: 64, press: 'FFFFFF', btn: { 1: { rgb: 'FF8800' }, 7: { rgb: '0040FF', fx: 'blink' } }, tile: {} } };
    this.saved = JSON.stringify(this.map);
    this.bindPending = null;
    this.test = 'off';
    this.xfer = null;   // {addr, total, done, crc}
    // The auxiliary command queue, modelled because its absence is what let a
    // client ship that could not send a picture: every `disp` costs a slot in
    // a queue TILESM_CMD_QUEUE deep that drains one command per poll cycle
    // (§3.2), so a caller that sends more than a handful of lines in a row is
    // told `busy` and has to wait. A mock that always says ok teaches the
    // opposite lesson.
    this.auxQueue = 0;
    setInterval(() => { if (this.auxQueue) this.auxQueue--; }, AUX_SLOT_MS);
    // Picture stores, §14.9. `${addr}:${slot}` -> a committed picture, and
    // `writing` is the at-most-one transfer in flight. The two are separate
    // because the commit is the whole point: BEGIN erases the slot, DATA fills
    // a buffer nobody can see, and only END puts the header on the front of
    // it. Anything that stops in between leaves the slot EMPTY.
    this.slots = new Map();
    this.writing = null;      // {addr, slot, fmt, attr, bytes:[], crc, limit}
    // The flash's own backpressure, which is not the aux queue's: ~0.7 ms
    // after a page program and tens of ms after the erase BEGIN starts (§14.9).
    // Modelled because a client that only ever met a full command queue has
    // not met the answer BEGIN gives while the erase runs.
    this.flashBusyUntil = 0;
    // The pending rumble code and the rate limit on acting (§8.8). One code,
    // overwritten by each new packet, because a flood must collapse to the
    // newest — the same buffer lineproto.c keeps, for the same reason.
    this.rumbleCode = 0;
    this.rumbleNextAt = 0;
    this.rumbleTimer = null;
    // The live LED layer of §13.5, by button: what `led <btn>` and a rumble
    // code's LED actions write and `led reset` clears. There is no command
    // that reads it back, so only tests look at it -- but a rumble LED action
    // is only checkable against a layer it can land in.
    this.ledLive = new Map();      // btn -> {rgb, fx}
    setInterval(() => this._tick(), 400);
  }
  onLine(cb) { this.lineCb = cb; }
  async open() {}
  async close() {}
  _emit(obj) { setTimeout(() => this.lineCb(JSON.stringify(obj)), 5); }

  /**
   * Feed the XInput OUT endpoint, the way a Driver Station does (§8.5, §8.8).
   *
   * `left` and `right` are the SDK's doubles, 0..1, converted here with the
   * SDK's own arithmetic rather than with a byte handed in ready-made: the
   * question this fake exists to answer is whether `rumble(c / 15.0, 0, ms)`
   * comes back out as code c, and a mock given the byte cannot answer it.
   * `rumbleBytes` is the raw form, for showing what an arbitrary motor value
   * decodes to.
   *
   * **Where this is less real than the board, stated rather than hidden.** On
   * hardware the OUT endpoint exists only in the `xinput` personality, and
   * `desc_xinput.c` is single-interface today — so a real board that can
   * receive a rumble has no config channel to report it on until Phase 0.5
   * lands the CDC composite §8.3 reserves for it. This mock reports in every
   * personality, because the alternative is a bind-by-doing flow that cannot
   * be exercised at all. Everything else here is the board's own behaviour:
   * the decode, the 50 ms floor, newest-wins, and the silence on a binding
   * that cannot be honoured.
   */
  rumble(left, right = 0) { this.xinputOut(rumblePacket(sdkByte(left), sdkByte(right))); }
  rumbleBytes(left, right = 0) { this.xinputOut(rumblePacket(left, right)); }
  playerLed(n) { this.xinputOut(playerPacket(n)); }

  xinputOut(bytes) {
    const p = decodeXinputOut(bytes);
    if (p.kind === 'motor') {
      // Every decoded packet is reported, bound or not: that is what lets a
      // config app bind by doing, as §9.6's bind mode does for keys.
      this._emit({ ev: 'rumble', left: p.left, right: p.right, code: p.code });
      // Code 0 is never an action, and does not cancel a code already
      // pending either — that code was a deliberate request and a stop says
      // nothing about it (§8.8).
      if (p.code) {
        // A code's LED actions land at once, outside the SHOW window
        // (§8.8 rev 0.33), as lineproto.c's rumble_leds() does.
        applyLedActions(this.map, p.code, this.ledLive);
        this.rumbleCode = p.code;
        this._rumbleService();
      }
    } else if (p.kind === 'player' && p.n) {
      this._emit({ ev: 'player', n: p.n });
    }
    // Anything else is swallowed, as §8.5 already says.
  }

  /**
   * Act on the newest code, at most one SHOW per 50 ms — `rumble_service()`.
   *
   * Nothing here is ever reported as an error. A code with no entry, an entry
   * whose tile is absent or has no picture store, a slot the tile does not
   * have, a slot that was never filled: all do nothing, silently, because a
   * match is not the place to report a configuration error (§8.8). A mock
   * that answered back would teach a client to expect an answer that a board
   * in `xinput` has no channel to give.
   */
  _rumbleService() {
    if (!this.rumbleCode) return;
    const now = performance.now();
    if (now < this.rumbleNextAt) return this._rumbleLater(this.rumbleNextAt - now);
    const b = bindsOf(this.map).find(x => x.code === this.rumbleCode);
    const t = b && this.tiles.find(x => x.addr === b.addr);
    if (b && t && t.state === 'online' && t.slots && b.slot < t.slots) {
      // A SHOW costs an auxiliary slot like every other display op, so a full
      // queue leaves the code pending rather than dropping it.
      if (this.auxQueue >= AUX_QUEUE_DEPTH) return this._rumbleLater(AUX_SLOT_MS);
      this.auxQueue++;
      // §14.9 already makes the tile refuse SHOW on an empty slot, and the
      // refusal has no carrier: the glass keeps whatever was on it.
      if (this.slots.has(`${b.addr}:${b.slot}`)) t.showing = b.slot;
    }
    this.rumbleCode = 0;
    this.rumbleNextAt = now + RUMBLE_ACT_MIN_MS;
  }

  _rumbleLater(ms) {
    if (this.rumbleTimer) return;
    this.rumbleTimer = setTimeout(() => { this.rumbleTimer = null; this._rumbleService(); }, Math.max(1, ms));
  }

  _tick() {
    const t = this.tiles[Math.random() < 0.5 ? 0 : 1];
    t.pressed = Math.random() < 0.5 ? [Math.floor(Math.random() * t.keys)] : [];
    for (const x of this.tiles) if (x.state === 'online') x.lastSeen = Math.floor(Math.random() * 5);
    const e = this.tiles.find(x => x.enc);
    if (e && Math.random() < 0.5) {
      const i = Math.floor(Math.random() * e.enc);
      // §15.4: a click moves the position by the entry's scale, 256 if unset
      const scale = this.map.enc?.find(x => x.addr === e.addr && x.idx === i)?.scale ?? 256;
      e.encPos[i] = Math.max(-32768, Math.min(32767, e.encPos[i] + (Math.random() < 0.5 ? -scale : scale)));
    }
  }

  /**
   * `disp <addr> slot <n> …` — the picture store of §14.9.
   *
   * Strict on purpose. Every rule below is one the firmware enforces and one a
   * client can get wrong quietly:
   *
   *   - **ascending offsets.** `OFF` must equal the number of bytes already
   *     accepted. A repeat of the LAST chunk is acknowledged and discarded,
   *     because `busy` flow control means a sender repeats itself; anything
   *     else is `args`. A picture with a stripe missing is worse than a
   *     refusal, and only the offset check can tell the two apart.
   *   - **the header is written last.** BEGIN drops the slot; DATA fills a
   *     buffer nobody can see; only a passing END publishes it. So a store
   *     that stops anywhere in between — a closed tab, a CRC mismatch, an
   *     ERASE — leaves the slot EMPTY, never a picture with a hole in it.
   *   - **the CRC is checked.** END compares CRC-16/CCITT-FALSE over every
   *     accepted byte, the same function `shared/crc.h` computes. A mismatch
   *     is `crc` and empties the slot.
   *   - **`busy` from two sources.** The auxiliary queue, as everywhere else,
   *     and the flash itself while an erase or a program runs.
   *
   * Stricter than the module in one way worth knowing: `disp` is
   * fire-and-forget, so a real board ACKs a line the moment it is queued and
   * the tile's own NAK -- a bad offset, a failed CRC, a SHOW on an empty slot
   * -- never reaches the config channel. This mock answers with the tile's
   * verdict instead, which is the only way a client's handling of it can be
   * exercised at all. A client must therefore treat these refusals as real
   * and must not depend on getting one.
   */
  _slot(t, a, ok, err, aux) {
    // The store is a part on the tile, so its absence is the whole answer.
    if (!t.slots) return err('args');
    const n = +a[2];
    if (!Number.isInteger(n) || n < 0 || n >= t.slots) return err('args');
    const op = a[3];
    const key = `${t.addr}:${n}`;
    const w = this.writing;
    const mine = w && w.addr === t.addr && w.slot === n;
    // The flash NAKs while it is busy; the arguments are still checked first,
    // exactly as the aux queue is checked last — a malformed line is `args`
    // whether or not the flash happens to be mid-erase.
    const flashBusy = () => performance.now() < this.flashBusyUntil;

    if (op === 'begin') {
      if (a.length !== 6) return err('args');
      const fmt = SLOT_FMT[a[4]], attr = +a[5];
      if (!fmt) return err('args');
      if (!Number.isInteger(attr) || attr < 0 || attr > 255) return err('args');
      // ATTR applies to 1 bpp only; RGB565 carries its colour in the pixels
      // and must be given a zero attribute (§14.9).
      if (fmt === 2 && attr !== 0) return err('args');
      if (fmt === 1) {
        if (attr & 2) return err('args');                                   // DOUBLE means nothing here
        if ((attr & 0xFC) && !(t.caps & (1 << 6))) return err('args');      // §14.7
      }
      if (flashBusy()) return err('busy');
      if (this.auxQueue >= AUX_QUEUE_DEPTH) return err('busy');
      // The erase happens now and the commit does not: whatever was in the
      // slot is gone from this moment, and nothing replaces it until END.
      this.slots.delete(key);
      if (t.showing === n) delete t.showing;
      const limit = fmt === 2 ? t.pxW * t.pxH * 2 : (t.pxW / 8) * t.pxH;
      this.writing = { addr: t.addr, slot: n, fmt, attr, len: 0, last: null, crc: 0xFFFF, limit };
      this.flashBusyUntil = performance.now() + FLASH_ERASE_MS;
      return aux();
    }

    if (op === 'data') {
      if (a.length !== 6) return err('args');
      const off = +a[4], hex = a[5] ?? '';
      if (!Number.isInteger(off) || off < 0) return err('args');
      if (!hex.length || hex.length % 2 || hex.length / 2 > 64) return err('args');
      if (!/^[0-9A-Fa-f]+$/.test(hex)) return err('hex');
      if (!mine) return err('args');                       // no BEGIN armed this slot
      // A repeat of the chunk just accepted: acknowledged and thrown away, so
      // a sender that could not tell whether its last line landed may simply
      // send it again.
      if (w.last !== null && off === w.last) return ok();
      if (off !== w.len) return err('args');               // ascending, no gaps
      const nb = hex.length / 2;
      if (off + nb > w.limit) return err('args');
      if (flashBusy()) return err('busy');
      if (this.auxQueue >= AUX_QUEUE_DEPTH) return err('busy');
      const bytes = new Uint8Array(nb);
      for (let i = 0; i < nb; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      // CRCed as they arrive: §14.9 compares a running value at END rather
      // than reading 32 KB back, which would halt the tile past T_LOST.
      // `crc16Running` rather than `crc16CcittFalse(bytes, w.crc)` so a stale
      // cached util.js fails the import loudly instead of folding every chunk
      // from 0xFFFF and blaming the picture -- see util.js.
      w.crc = crc16Running(w.crc, bytes);
      w.last = off;
      w.len += nb;
      (w.data ??= []).push(bytes);
      this.flashBusyUntil = performance.now() + FLASH_PROGRAM_MS;
      return aux();
    }

    if (op === 'end') {
      if (a.length !== 5) return err('args');
      const want = +a[4];
      if (!Number.isInteger(want) || want < 0 || want > 0xFFFF) return err('args');
      if (!mine) return err('args');
      if (flashBusy()) return err('busy');
      if (this.auxQueue >= AUX_QUEUE_DEPTH) return err('busy');
      this.writing = null;
      if (want !== w.crc) {
        // `flash` is §9.2's code for "it did not read back as it was sent",
        // the one FLASH_PAGE already spends on the same failure. Empty, not
        // partial: the header was never written, so the slot reads 0xFF the
        // way an erased block does.
        this.auxQueue++;
        return err('flash', { slot: n, crc: w.crc });
      }
      this.slots.set(key, { fmt: w.fmt, attr: w.attr, len: w.len, crc: w.crc });
      return aux();
    }

    if (op === 'show') {
      if (a.length !== 4) return err('args');
      const stored = this.slots.get(key);
      if (!stored) return err('args');          // SHOW on an empty slot, §14.9
      if (this.auxQueue >= AUX_QUEUE_DEPTH) return err('busy');
      t.showing = n;                            // owns the panel until CLEAR
      return aux();
    }

    if (op === 'erase') {
      if (a.length !== 4) return err('args');
      if (flashBusy()) return err('busy');
      if (this.auxQueue >= AUX_QUEUE_DEPTH) return err('busy');
      this.slots.delete(key);
      if (mine) this.writing = null;
      if (t.showing === n) delete t.showing;
      this.flashBusyUntil = performance.now() + FLASH_ERASE_MS;
      return aux();
    }
    return err('args');
  }

  async write(s) {
    // Only the line ending comes off. Trailing spaces are SIGNIFICANT (§14.4):
    // they are how a client erases what a longer string left in a display row,
    // and the firmware's parser keeps them (lineproto.c drops \r and nothing
    // else). Trimming here made blank rows fail against the mock alone.
    const line = s.replace(/[\r\n]+$/, ''); const [cmd, ...a] = line.trim().split(' ');
    // Everything after the first n space-separated tokens, verbatim — the rule
    // §14.4 states for `<text…>`.
    const rest = (n) => { let i = 0; for (let k = 0; k < n; k++) { i = line.indexOf(' ', i); if (i < 0) return ''; i++; } return line.slice(i); };
    const ok = (o = {}) => this._emit({ ok: true, ...o });
    const err = (e, o = {}) => this._emit({ ok: false, err: e, ...o });
    if (this.xfer) {   // hex chunk lines during a flash transfer (§9.4)
      if (!/^[0-9A-Fa-f]*$/.test(line) || line.length % 2) { this.xfer = null; return err('hex'); }
      const x = this.xfer; x.done += line.length / 2;
      this._emit({ ev: 'progress', addr: x.addr, done: x.done, total: x.total });
      if (x.done >= x.total) {
        const t = this.tiles.find(t => t.addr === x.addr);
        this.xfer = null;
        setTimeout(() => { t.state = 'online'; t.fw = x.fw; this._emit({ ev: 'tile', addr: t.addr, state: 'online' }); ok({ addr: t.addr, fw: t.fw }); }, 300);
      }
      return;
    }
    switch (cmd) {
      case 'hello': return ok({ product: 'BBR Button Board', fw: '0.1.0-mock', proto: 1, serial: 'E66138528F0B1234', hw: 'A', mapValid: true, tiles: this.tiles.length, mode: 'run', usb: this.usb, usbSaved: this.usb, pixel: this.pixel });
      case 'tiles': return ok({ tiles: this.tiles });
      case 'stats': return ok({ uptime: 12345, pollCycleUs: 4310, bindMode: !!this.bindPending, test: this.test, fault: this.tiles.some(t => t.state === 'lost'), power: { budget: 450, worst: 388, brightness: 64 } });
      case 'map':
        if (a[0] === 'get') return ok({ map: this.map, dirty: JSON.stringify(this.map) !== this.saved });
        if (a[0] === 'set') {
          let m;
          try { m = JSON.parse(line.slice(8)); } catch { return err('args'); }
          // §9.5's rule for the rumble section, refused the way the module
          // refuses it. A UI that lets two entries share a code has to find
          // out somewhere, and a mock that accepts one is the reason it
          // would find out on hardware instead.
          const bad = validateBinds(m.rumble);
          if (bad) return err(bad);
          // map.c: debounce keys are tile addresses 1..31, values 1..255 ms.
          for (const [addr, ms] of Object.entries(m.debounce ?? {}))
            if (!(+addr >= 1 && +addr <= 31) || !Number.isInteger(ms) || ms < 1 || ms > 255) return err('debounce');
          // map.c's canonical emit: legends, then LED actions, each in the
          // order given; hex upper case, 000000 as `off`, `fx` only when it
          // is not solid and never on `map`.
          if (Array.isArray(m.rumble)) {
            const led = (e) => {
              const rgb = e.rgb === 'map' || e.rgb === 'off' ? e.rgb : e.rgb.toUpperCase() === '000000' ? 'off' : e.rgb.toUpperCase();
              return { code: e.code, btn: e.btn, rgb, ...(rgb !== 'map' && e.fx && e.fx !== 'solid' ? { fx: e.fx } : {}) };
            };
            m.rumble = [...bindsOf(m), ...m.rumble.filter(e => !bindsOf(m).includes(e)).map(led)];
          }
          this.map = m;
          // lineproto.c: a tile reports its override, or its type's default.
          for (const t of this.tiles) t.debounce = m.debounce?.[t.addr] ?? defaultDebounce(t.type);
          return ok({ dirty: true });
        }
        return err('args');
      case 'save': this.saved = JSON.stringify(this.map); return ok({ saved: true });
      case 'enc': {
        if (a[0] !== 'zero') return err('args');
        const t = this.tiles.find(x => x.enc);
        if (!t) return ok();
        if (a.length === 1) { t.encPos = t.encPos.map(() => 0); return ok(); }
        const e = this.map.enc?.find(x => x.axis === +a[1]);
        if (e && e.addr === t.addr) t.encPos[e.idx] = 0;
        return ok();
      }
      case 'bind': {
        if (a[0] === 'cancel') { this.bindPending = null; return ok(); }
        if (a[0] === 'axis') {                              // §15.7
          const axis = +a[1];
          if (!(axis >= 1 && axis <= 4)) return err('args');
          this._emit({ ev: 'fault', on: true, why: 'bind' });
          this.bindPending = setTimeout(() => {
            const t = this.tiles.find(x => x.enc);
            const idx = Math.floor(Math.random() * t.enc);
            this.map.enc = (this.map.enc ?? []).filter(x => x.axis !== axis && !(x.addr === t.addr && x.idx === idx));
            this.map.enc.push({ axis, addr: t.addr, idx, invert: false });
            this._emit({ ev: 'enc', addr: t.addr, idx, dir: 1 });
            this._emit({ ev: 'fault', on: false, why: 'none' });
            this.bindPending = null;
            ok({ axis, addr: t.addr, idx });
          }, 1000);
          return;
        }
        if (a[0]?.includes('+')) {                          // a combo, §9.7
          const btns = a[0].split('+').map(Number);
          if (a.length !== 1 || btns.length < 2 || new Set(btns).size !== btns.length ||
              !btns.every(n => Number.isInteger(n) && n >= 1 && n <= 32)) return err('args');
          this._emit({ ev: 'fault', on: true, why: 'bind' });
          this.bindPending = setTimeout(() => {
            const t = this.tiles[0]; const key = Math.floor(Math.random() * t.keys);
            this.map.bind = this.map.bind.filter(b => !(b.addr === t.addr && b.key === key));
            for (const btn of btns) this.map.bind.push({ btn, addr: t.addr, key });
            this._emit({ ev: 'key', addr: t.addr, key });
            this._emit({ ev: 'fault', on: false, why: 'none' });
            this.bindPending = null;
            ok({ btns: [...btns].sort((x, y) => x - y), addr: t.addr, key });
          }, 1000);
          return;
        }
        const btn = +a[0], add = a[1] === 'add';
        if (!(btn >= 1 && btn <= 32)) return err('args');
        this._emit({ ev: 'fault', on: true, why: 'bind' });
        this.bindPending = setTimeout(() => {
          const t = this.tiles[0]; const key = Math.floor(Math.random() * t.keys);
          this.map.bind = this.map.bind.filter(b => !(b.addr === t.addr && b.key === key) && (add || b.btn !== btn));
          this.map.bind.push({ btn, addr: t.addr, key });
          this._emit({ ev: 'key', addr: t.addr, key });
          this._emit({ ev: 'fault', on: false, why: 'none' });
          this.bindPending = null;
          ok({ btn, addr: t.addr, key, sources: this.map.bind.filter(b => b.btn === btn).length });
        }, 1000);
        return;
      }
      case 'unbind': {
        if (a[0] === 'axis') {
          this.map.enc = (this.map.enc ?? []).filter(x => x.axis !== +a[1]);
          return ok();
        }
        const btn = +a[0];
        this.map.bind = this.map.bind.filter(b => b.btn !== btn || (a.length === 3 && !(b.addr === +a[1] && b.key === +a[2])));
        return ok({ sources: this.map.bind.filter(b => b.btn === btn).length });
      }
      case 'flash': {
        const t = this.tiles.find(t => t.addr === +a[0]);
        if (!t || t.state !== 'online') return err('tile');
        t.state = 'boot'; this._emit({ ev: 'tile', addr: t.addr, state: 'boot' });
        // pretend the image's version is one patch newer than what is installed
        const v = t.fw.split('.').map(Number); v[2]++;
        this.xfer = { addr: t.addr, total: +a[1], done: 0, crc: a[2], fw: v.join('.') };
        return ok({ ready: true, chunk: 64 });
      }
      case 'test': {                                   // §9.10
        if (this.bindPending) return err('busy');
        const [mode, arg] = a;
        if (mode === 'off'  && a.length === 1) { this.test = 'off'; return ok({ test: 'off' }); }
        if (mode === 'all'  && a.length === 1) { this.test = 'all'; return ok({ test: 'all' }); }
        if (mode === 'walk' && a.length <= 2) {
          const ms = a.length === 2 ? +arg : 250;
          if (!(ms >= 50 && ms <= 5000)) return err('args');
          this.test = 'walk'; return ok({ test: 'walk', ms });
        }
        if (mode === 'hold' && a.length === 2) {
          const btn = +arg;
          if (!(btn >= 1 && btn <= 32)) return err('args');
          this.test = 'hold'; return ok({ test: 'hold', btn });
        }
        return err('args');
      }
      // Display (§14.4). Validated the way the module validates, so the UI's
      // refusal paths get exercised without a tile: the geometry is the
      // descriptor's, and colour is refused on a panel without bit 6 of caps.
      case 'disp': {
        const t = this.tiles.find(x => x.addr === +a[0]);
        if (!t || !t.cols) return err('args');
        const sub = a[1];
        // Every op below queues a frame for the tile, so every one of them
        // can be refused -- but only after its arguments pass, the way the
        // module refuses: a malformed line never reaches the queue, so it
        // gets `args` whether or not there is room.
        const aux = () => {
          if (this.auxQueue >= AUX_QUEUE_DEPTH) return err('busy');
          this.auxQueue++;
          return ok();
        };
        // CLEAR is what takes the panel back from a picture, stored or
        // streamed (§14.8, §14.9).
        if (sub === 'clear') { delete t.showing; return aux(); }
        if (sub === 'show') return aux();
        if (sub === 'contrast') {
          const v = +a[2];
          return Number.isInteger(v) && v >= 0 && v <= 255 ? aux() : err('args');
        }
        if (sub === 'slot') return this._slot(t, a, ok, err, aux);
        if (sub === 'image') {                        // §14.8
          if (!t.pxW || !t.pxH) return err('args');
          const row = +a[2], attr = +a[3], hex = a[4] ?? '';
          const stride = t.pxW / 8;
          if (!(row >= 0 && row < t.pxH)) return err('args');
          if (!(attr >= 0 && attr <= 255) || (attr & 2)) return err('args');
          if ((attr & 0xFC) && !(t.caps & (1 << 6))) return err('args');
          if (!hex.length || hex.length % 2 || hex.length / 2 > 64) return err('args');
          if (!/^[0-9A-Fa-f]+$/.test(hex)) return err('hex');
          const nb = hex.length / 2;
          if (nb % stride || row + nb / stride > t.pxH) return err('args');
          return aux();
        }
        if (sub === 'text' || sub === 'bar') {
          const row = +a[2], col = +a[3];
          if (!(row >= 0 && row < t.rows) || !(col >= 0 && col < t.cols)) return err('args');
          if (sub === 'bar') {
            const w = +a[4], v = +a[5];
            return w > 0 && w <= t.cols && v >= 0 && v <= 255 ? aux() : err('args');
          }
          const attr = +a[4];
          if (!(attr >= 0 && attr <= 255)) return err('args');
          if ((attr & 0xFC) && !(t.caps & (1 << 6))) return err('args');   // §14.7
          const text = rest(6);            // after `disp <addr> text <row> <col> <attr>`
          if (!text || text.length > 64) return err('args');
          if ([...text].some(c => c < ' ' || c > '~')) return err('args');
          return aux();
        }
        // The short form: `disp <addr> <row> <text...>`, col 0, no attributes.
        const row = +sub;
        if (!(row >= 0 && row < t.rows)) return err('args');
        return aux();
      }
      case 'led': {
        // Only the per-button form and `reset`/`all` touch the layer this
        // fake keeps; `led tile` is accepted and forgotten.
        if (a[0] === 'reset' || a[0] === 'all') { this.ledLive.clear(); return ok(); }
        const btn = +a[0];
        if (Number.isInteger(btn) && btn >= 1 && btn <= 32 && a[1]) {
          if (a[1] !== 'off' && !/^[0-9a-fA-F]{6}$/.test(a[1])) return err('args');
          this.ledLive.set(btn, { rgb: a[1] === 'off' ? '000000' : a[1].toUpperCase(),
                                  fx: ['blink', 'fast', 'breathe'].find(f => a.includes(f)) ?? 'solid' });
        }
        return ok();
      }
      case 'power': return ok({ budget: +a[1] });
      case 'usb': this.usb = a[0]; return ok({ usb: a[0], pending: true });
      case 'pixel':
        if (a.length !== 1 || !['on', 'off'].includes(a[0])) return err('args');
        this.pixel = a[0] === 'on';
        return ok({ pixel: this.pixel });
      case 'reset': case 'boot': return ok();
      default: return err('unknown');
    }
  }
}
