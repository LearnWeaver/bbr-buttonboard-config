// Web Serial transport. requestPort() must be called from a user gesture.
export class SerialTransport {
  static supported() { return 'serial' in navigator; }

  constructor() { this.port = null; this.lineCb = () => {}; this.closed = false; }
  onLine(cb) { this.lineCb = cb; }

  async open() {
    // Filter by our VID once one is assigned (PROTOCOL.md §8.4); until then, any port.
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });   // ignored by the CDC device, §9.1
    this.writer = this.port.writable.getWriter();
    this._readLoop();
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    let buf = '';
    const reader = this.port.readable.getReader();
    this.reader = reader;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          this.lineCb(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
    } catch (e) {
      if (!this.closed) console.warn('serial read error', e);
    } finally {
      reader.releaseLock();
    }
  }

  async write(s) { await this.writer.write(new TextEncoder().encode(s)); }

  async close() {
    this.closed = true;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
  }
}
