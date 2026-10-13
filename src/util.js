// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final xor),
// the one `shared/crc.h` and `tools/bb/crc.py` compute. `init` continues a
// running value instead of starting one, which is what a receiver CRCing a
// stored picture as its chunks arrive needs (§14.9) -- the alternative is
// keeping every byte to CRC at the end.
export function crc16CcittFalse(bytes, init = 0xFFFF) {
  let crc = init;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

/**
 * Fold `bytes` into a running `crc`, the accumulation §14.9 commits a slot
 * against. Identical to `crc16CcittFalse(bytes, crc)` and deliberately a
 * SEPARATE EXPORT rather than a second argument nobody has to pass.
 *
 * The site has no build step, so a browser caches each module on its own and
 * `python3 -m http.server` gives it nothing to revalidate against. That made a
 * real bug: `init` arrived here as a backward-compatible extra argument, a tab
 * kept a pre-`init` copy of this file in its HTTP cache, and every caller went
 * on running — folding each chunk from 0xFFFF instead of from the running
 * value, so every store of more than one chunk failed its END with `err flash`
 * and nothing said why. A name a stale copy does not export cannot fail that
 * quietly: the import throws "does not provide an export named crc16Running"
 * and names the file to hard-reload. `tools/webserve.py` is the other half of
 * the fix, and stops the stale copy being served at all.
 */
export const crc16Running = (crc, bytes) => crc16CcittFalse(bytes, crc);

export const hex16 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
export function semverCmp(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
