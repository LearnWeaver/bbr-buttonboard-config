// Line-protocol client for the config channel (PROTOCOL.md §9.1).
// Transport-agnostic: give it anything with write(string) and an onLine(cb).
// One command in flight at a time; events ({"ev":...}) are fanned out to
// listeners whether or not a command is pending.

// One auxiliary command leaves the module per poll cycle (§3.2): the host
// simulator measures 5.7 ms a command on a four-tile chain, so a queue that
// answered `busy` has room again a few milliseconds later. Waiting rather than
// spinning keeps the retries off the config channel, where they would compete
// with the very traffic that has to drain. Slightly under a slot rather than
// over it, so a waiting chunk goes out on the first cycle with room: the
// simulator sends a whole 32-chunk picture in 172 ms this way, against the
// ~180 ms floor the slot itself imposes.
const DISP_BUSY_WAIT_MS = 5;
// Bounded by attempts rather than by wall clock, because wall clock is not the
// browser's to give: a hidden tab has its timers throttled to one wake a
// minute, so a deadline would fail a send for being backgrounded rather than
// for anything the bus did. An attempt is a real unit of effort either way --
// each one costs a round trip and an answer -- so counting them bounds the
// retries whether the page is in front of someone or not.
const DISP_BUSY_TRIES = 400;

export class ProtocolClient {
  constructor(transport) {
    this.t = transport;
    this.pending = null;          // {resolve, reject, events:[]}
    this.queue = [];
    this.xfer = false;            // true during a FLASH_PAGE transfer, §9.4
    this.listeners = new Map();   // ev name -> Set(cb)
    this.log = [];
    transport.onLine((line) => this._onLine(line));
  }

  on(ev, cb) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev).add(cb);
    return () => this.listeners.get(ev).delete(cb);
  }

  // Sends a command line; resolves with the terminal {"ok":true,...} object
  // plus `events` (lines that arrived during the command). Rejects on ok:false.
  // `lock` marks a command that owns the link until it says otherwise: the
  // flash header, after which only hex chunks may be written (§9.4).
  send(line, { timeoutMs = 5000, lock = false } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ line, resolve, reject, timeoutMs, lock });
      this._pump();
    });
  }

  _pump() {
    // Nothing may be written between `flash` and its hex chunks: §9.4 says a
    // non-hex line aborts the transfer with err "hex". A queued command — the
    // `tiles` that app.js sends on the ev:tile the transfer itself emits —
    // would otherwise be pumped the moment the flash header is acknowledged.
    if (this.pending || this.xfer || this.queue.length === 0) return;
    const job = this.queue.shift();
    if (job.lock) this.xfer = true;   // armed as it goes out, not before
    job.events = [];
    job.timer = setTimeout(() => {
      this.pending = null;
      job.reject(new Error(`timeout: ${job.line}`));
      this._pump();
    }, job.timeoutMs);
    this.pending = job;
    if (job.line === null) return;          // wait-only job: terminal line comes from an in-flight transfer
    this._log('>', job.line);
    this.t.write(job.line + '\n');
  }

  _onLine(raw) {
    const line = raw.replace(/\r$/, '');
    if (!line) return;
    this._log('<', line);
    let msg;
    try { msg = JSON.parse(line); } catch { return; }   // garbage: ignore, §9.1

    if ('ev' in msg) {
      if (this.pending) this.pending.events.push(msg);
      const set = this.listeners.get(msg.ev);
      if (set) for (const cb of set) cb(msg);
      const any = this.listeners.get('*');
      if (any) for (const cb of any) cb(msg);
      return;
    }
    if ('ok' in msg && this.pending) {
      const job = this.pending;
      clearTimeout(job.timer);
      this.pending = null;
      msg.events = job.events;
      msg.ok ? job.resolve(msg) : job.reject(Object.assign(new Error(msg.err || 'error'), { response: msg }));
      this._pump();
    }
  }

  _log(dir, text) {
    this.log.push(`${dir} ${text}`);
    if (this.log.length > 500) this.log.shift();
    const set = this.listeners.get('log');
    if (set) for (const cb of set) cb(dir, text);
  }

  // ---- convenience wrappers, one per §9.2 command ----
  hello()             { return this.send('hello'); }
  tiles()             { return this.send('tiles'); }
  stats()             { return this.send('stats'); }
  bind(btn, add=false){ return this.send(add ? `bind ${btn} add` : `bind ${btn}`, { timeoutMs: 35000 }); }
  // A combo, §9.7: the next key pressed feeds exactly these buttons.
  bindCombo(btns)     { return this.send(`bind ${btns.join('+')}`, { timeoutMs: 35000 }); }
  bindCancel()        { return this.send('bind cancel'); }
  unbind(btn, addr, key) { return this.send(addr == null ? `unbind ${btn}` : `unbind ${btn} ${addr} ${key}`); }
  // Encoders, §15.7. `bind axis` waits for a rotation the way `bind` waits
  // for a press, so it gets the same long timeout.
  bindAxis(n)         { return this.send(`bind axis ${n}`, { timeoutMs: 35000 }); }
  unbindAxis(n)       { return this.send(`unbind axis ${n}`); }
  encZero(n)          { return this.send(n == null ? 'enc zero' : `enc zero ${n}`); }
  mapGet()            { return this.send('map get'); }
  mapSet(map)         { return this.send(`map set ${JSON.stringify(map)}`); }
  save()              { return this.send('save', { timeoutMs: 10000 }); }
  led(btn, rgb, fx, press) { return this.send(['led', btn, rgb, fx, press].filter(v => v != null).join(' ')); }
  ledAll(rgb)         { return this.send(`led all ${rgb}`); }
  ledReset()          { return this.send('led reset'); }
  // Display tiles (§14.4). Fire-and-forget: an ok here means the frame was
  // queued for the auxiliary slot, not that the tile has drawn it. Writes
  // accumulate and SHOW commits them, so a multi-row update never tears; the
  // module also auto-commits DISP_SHOW_AUTO_MS after the last write, which is
  // why `show` is separate rather than folded into every write.
  //
  // Every one of them goes through _disp() because every one of them costs a
  // slot in the same queue, and that queue is what `busy` is about.
  dispText(addr, row, text, { col = 0, attr = 0 } = {}) {
    return this._disp(`disp ${addr} text ${row} ${col} ${attr} ${text}`);
  }
  dispBar(addr, row, col, width, value) {
    return this._disp(`disp ${addr} bar ${row} ${col} ${width} ${value}`);
  }
  dispClear(addr)     { return this._disp(`disp ${addr} clear`); }
  dispShow(addr)      { return this._disp(`disp ${addr} show`); }
  dispContrast(addr, level) { return this._disp(`disp ${addr} contrast ${level}`); }
  // One image chunk (§14.8). A picture has no commit: it goes straight at the
  // panel as it arrives, so there is no `show` to follow and none is sent.
  dispImage(addr, row, attr, hex) {
    return this._disp(`disp ${addr} image ${row} ${attr} ${hex}`);
  }

  // Stored pictures (§14.9). A tile that reports `slots` keeps whole pictures
  // in a local flash: BEGIN arms a slot, DATA fills it at strictly ascending
  // offsets, END commits it against a CRC, SHOW puts it on the glass in one
  // frame and ERASE drops it.
  //
  // All five go through _disp() like everything else that costs an auxiliary
  // slot -- and they need it more than anything else does, because a colour
  // picture is 512 DATA lines against a queue eight deep, and because the
  // flash itself NAKs while it is busy: ~0.7 ms after a page program and tens
  // of milliseconds after the erase BEGIN starts. `busy` from either source is
  // backpressure and reads identically here, which is the point.
  //
  // `fmt` is the literal word `1bpp` or `rgb565`; `attr` is §14.7's byte and
  // MUST be 0 for rgb565, which carries its colour in the pixels.
  dispSlotBegin(addr, slot, fmt, attr = 0) {
    return this._disp(`disp ${addr} slot ${slot} begin ${fmt} ${attr}`);
  }
  dispSlotData(addr, slot, off, hex) {
    return this._disp(`disp ${addr} slot ${slot} data ${off} ${hex}`);
  }
  // `crc16` is decimal, CRC-16/CCITT-FALSE over every data byte (dispattr.js
  // `slotCrc`). A mismatch is `err crc` and leaves the slot EMPTY, not half
  // written: §14.9 writes the header last and that is the commit.
  dispSlotEnd(addr, slot, crc16) {
    return this._disp(`disp ${addr} slot ${slot} end ${crc16}`);
  }
  dispSlotShow(addr, slot)  { return this._disp(`disp ${addr} slot ${slot} show`); }
  dispSlotErase(addr, slot) { return this._disp(`disp ${addr} slot ${slot} erase`); }

  /**
   * Load a whole picture into a slot: BEGIN, every DATA chunk, END.
   *
   * `onProgress(done, total)` is called per chunk because this is the one
   * config-channel operation measured in seconds -- 512 chunks of a colour
   * picture is 2-4 s of auxiliary slot (§14.9) -- and a UI with no progress
   * line during it looks hung. It is spent once, at configuration time; what
   * it buys is a legend change that costs a single SHOW frame afterwards.
   */
  async dispSlotStore(addr, slot, fmt, attr, chunks, crc16, onProgress = () => {}) {
    // `chunks` and `crc16` come from dispattr.js rather than being derived
    // here: this file stays free of anything that needs a canvas, and the CRC
    // has exactly one implementation per language for a reason.
    const total = chunks.reduce((n, c) => n + c.hex.length / 2, 0);
    await this.dispSlotBegin(addr, slot, fmt, attr);
    let done = 0;
    for (const { off, hex } of chunks) {
      await this.dispSlotData(addr, slot, off, hex);
      done += hex.length / 2;
      onProgress(done, total, chunks.length);
    }
    return this.dispSlotEnd(addr, slot, crc16);
  }

  /**
   * One `disp` line, re-sent while the module answers `busy`.
   *
   * `busy` on a display command means the module's command queue is full
   * (TILESM_CMD_QUEUE, 8) — it is backpressure, not a fault, and the firmware
   * says so: the auxiliary slot carries one command per poll cycle (§3.2), so
   * the queue drains at a few hundred a second while a USB round trip lets a
   * caller push thousands. Anything that sends more than eight lines in a row
   * outruns the bus and gets refused partway: a 128 px picture is 32 chunks
   * (§14.8), and an eight-row panel is eight writes and a SHOW.
   *
   * Treating that refusal as an error is what made a picture arrive with its
   * bottom two thirds missing. Nothing else can be done with it either — the
   * command was never queued, so re-sending it is the only way the frame ever
   * reaches the tile.
   */
  async _disp(line, { tries = DISP_BUSY_TRIES } = {}) {
    for (let n = 1; ; n++) {
      try { return await this.send(line); }
      catch (e) {
        // `busy` is the only retryable answer: every other err is a rejection
        // of the command itself and would be rejected again just as fast.
        if (e.message !== 'busy') throw e;
        if (n >= tries) throw new Error(`bus busy: ${tries} attempts and the queue never had room`);
        await new Promise(r => setTimeout(r, DISP_BUSY_WAIT_MS));
      }
    }
  }
  powerBudget(mA)     { return this.send(`power budget ${mA}`); }
  usb(mode)           { return this.send(`usb ${mode}`); }
  // The main module's status pixel (§8.6): a white flash per press. Saved by `save`.
  pixel(on)           { return this.send(`pixel ${on ? 'on' : 'off'}`); }
  // Test pattern (§9.10). Ends by itself if this page closes the port.
  test(mode, arg)     { return this.send(['test', mode, arg].filter(v => v != null).join(' ')); }
  reset(factory=false){ return this.send(factory ? 'reset factory' : 'reset'); }
  boot()              { return this.send('boot'); }

  // Tile firmware transfer (PROTOCOL.md §9.4). `image` is a Uint8Array, crc16
  // is upper-case hex. Progress events drive flow control: the next chunk is
  // written only after the board acknowledges the previous one.
  async flash(addr, image, crc16, onProgress = () => {}) {
    let ready;
    try {
      ready = await this.send(`flash ${addr} ${image.length} ${crc16}`, { timeoutMs: 10000, lock: true });
    } catch (e) {
      this.xfer = false; this._pump();
      throw e;
    }
    const chunk = ready.chunk ?? 64;
    let sent = 0;
    // The terminal ok line for the whole transfer arrives after the last
    // progress event. This job becomes `pending` directly rather than going
    // through the queue, which `xfer` is holding shut.
    const done = new Promise((resolve, reject) => {
      const job = { line: null, resolve, reject, events: [] };
      job.timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`timeout: flash ${addr}`));
      }, 120000);
      this.pending = job;
    });
    const off = this.on('progress', (ev) => {
      onProgress(ev.done, ev.total);
      if (sent < image.length) sendChunk();
    });
    const sendChunk = () => {
      const part = image.subarray(sent, sent + chunk);
      sent += part.length;
      this.t.write(Array.from(part, b => b.toString(16).padStart(2, '0')).join('').toUpperCase() + '\n');
    };
    sendChunk();
    try { return await done; } finally { off(); this.xfer = false; this._pump(); }
  }
}

// Build a group view of a map: btn -> [{addr,key}, ...]   (PROTOCOL.md §9.7)
export function groupsOf(map) {
  const g = new Map();
  for (const b of map?.bind ?? []) {
    if (!g.has(b.btn)) g.set(b.btn, []);
    g.get(b.btn).push({ addr: b.addr, key: b.key });
  }
  return g;
}
