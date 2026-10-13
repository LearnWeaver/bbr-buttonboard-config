// WebHID transport for the vendor HID interface (PROTOCOL.md §9.8).
// Reserved until Phase 0.1 clears the extra interface. Carries the same line
// stream as CDC: 64-byte reports, byte 0 = length, bytes 1..63 = stream.
export class HidTransport {
  static supported() { return 'hid' in navigator; }
  constructor() { this.lineCb = () => {}; this.buf = ''; }
  onLine(cb) { this.lineCb = cb; }

  async open() {
    const [dev] = await navigator.hid.requestDevice({ filters: [{ usagePage: 0xFF42, usage: 0x01 }] });
    if (!dev) throw new Error('no device chosen');
    this.dev = dev;
    await dev.open();
    dev.addEventListener('inputreport', (e) => {
      const d = new Uint8Array(e.data.buffer);
      const len = d[0];
      this.buf += new TextDecoder().decode(d.subarray(1, 1 + len));
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { this.lineCb(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1); }
    });
  }

  async write(s) {
    const bytes = new TextEncoder().encode(s);
    for (let off = 0; off < bytes.length; off += 63) {
      const chunk = bytes.subarray(off, off + 63);
      const report = new Uint8Array(64);
      report[0] = chunk.length;
      report.set(chunk, 1);
      await this.dev.sendReport(0, report);
    }
  }

  async close() { await this.dev?.close(); }
}
