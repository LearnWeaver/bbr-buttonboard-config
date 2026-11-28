// Seven-segment cells (PROTOCOL.md §14.11), for drawing a seg2's digits the
// way the tile will light them.
//
// TABLE is shared/seg7.h's character table, byte for byte; tools/test_web.mjs
// reads the header and fails if the two ever differ. Bit 0 is segment a (top),
// round clockwise to bit 5 f, bit 6 g, bit 7 the decimal point.

export const SEG_DP = 0x80;

const TABLE = [
  0x00, 0x49, 0x22, 0x49, 0x49, 0x49, 0x49, 0x02,  //   ! " # $ % & '
  0x49, 0x49, 0x49, 0x49, 0x80, 0x40, 0x80, 0x49,  // ( ) * + , - . /
  0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07,  // 0 1 2 3 4 5 6 7
  0x7F, 0x6F, 0x49, 0x49, 0x49, 0x48, 0x49, 0x49,  // 8 9 : ; < = > ?
  0x49, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71, 0x3D,  // @ A B C D E F G
  0x76, 0x30, 0x1E, 0x49, 0x38, 0x49, 0x54, 0x5C,  // H I J K L M N O
  0x73, 0x67, 0x50, 0x6D, 0x78, 0x3E, 0x49, 0x49,  // P Q R S T U V W
  0x49, 0x6E, 0x49, 0x39, 0x49, 0x0F, 0x63, 0x08,  // X Y Z [ \ ] ^ _
  0x49, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71, 0x3D,  // ` a b c d e f g
  0x76, 0x30, 0x1E, 0x49, 0x38, 0x49, 0x54, 0x5C,  // h i j k l m n o
  0x73, 0x67, 0x50, 0x6D, 0x78, 0x1C, 0x49, 0x49,  // p q r s t u v w
  0x49, 0x6E, 0x49, 0x49, 0x49, 0x49, 0x49,        // x y z { | } ~
];
export const SEG7_TABLE = TABLE;

export const segOf = (ch) => {
  const c = ch.charCodeAt(0);
  return c >= 0x20 && c <= 0x7e ? TABLE[c - 0x20] : 0x49;
};

const isPoint = (ch) => ch === '.' || ch === ',';

// TEXT's rule (§14.11): a point straight after a character lights that cell's
// point and takes no cell; at the start, or after another point, it is a
// blank cell with its point lit. `cols` cells from column 0, the rest clipped.
// Inverse lights what the character leaves dark, the point included.
export function seg7Cells(text, cols, { inverse = false } = {}) {
  const cells = Array(cols).fill(inverse ? 0xff : 0);
  let pos = 0, merge = false;
  for (const ch of text) {
    if (isPoint(ch) && merge) {
      if (pos - 1 < cols) cells[pos - 1] ^= SEG_DP;
      merge = false;
      continue;
    }
    if (pos < cols) cells[pos] = segOf(ch) ^ (inverse ? 0xff : 0);
    pos++;
    merge = !isPoint(ch);
  }
  return cells;
}

// The longest start of `text` that fits `cols` cells, padded with spaces to
// fill them: what Draw sends, so the trailing spaces erase a longer old value
// the way they do on a text panel. "1.5" is two cells, not three characters.
export function seg7Fit(text, cols) {
  let out = '', pos = 0, merge = false;
  for (const ch of text) {
    if (isPoint(ch) && merge) { out += ch; merge = false; continue; }
    if (pos >= cols) break;
    out += ch; pos++;
    merge = !isPoint(ch);
  }
  return out + ' '.repeat(cols - pos);
}

// One digit as SVG polygons in a 60 x 100 box, slanted like the module's.
// Unlit segments are drawn faint, as an unlit LED segment shows through.
const W = 60, H = 100, T = 10, SLANT = 0.08;
function bar(x0, y0, x1, y1) {          // a segment from (x0,y0) to (x1,y1), pointed ends
  const h = y0 === y1, t = T / 2;
  const pts = h
    ? [[x0, y0], [x0 + t, y0 - t], [x1 - t, y0 - t], [x1, y0], [x1 - t, y0 + t], [x0 + t, y0 + t]]
    : [[x0, y0], [x0 + t, y0 + t], [x0 + t, y1 - t], [x0, y1], [x0 - t, y1 - t], [x0 - t, y0 + t]];
  return pts.map(([x, y]) => `${(x + (H - y) * SLANT).toFixed(1)},${y}`).join(' ');
}
const L = T / 2 + 2, R = W - T / 2 - 2, TOP = T / 2 + 2, MID = H / 2, BOT = H - T / 2 - 2;
const SEGS = [
  bar(L, TOP, R, TOP),      // a
  bar(R, TOP, R, MID),      // b
  bar(R, MID, R, BOT),      // c
  bar(L, BOT, R, BOT),      // d
  bar(L, MID, L, BOT),      // e
  bar(L, TOP, L, MID),      // f
  bar(L, MID, R, MID),      // g
];

export function seg7Svg(cells, { lit = '#ff2a1a', ghost = 'rgba(255,42,26,0.12)' } = {}) {
  const pitch = W + 22;
  const digits = cells.map((s, i) => `<g transform="translate(${i * pitch + 6},6)">
      ${SEGS.map((p, k) => `<polygon points="${p}" fill="${s & (1 << k) ? lit : ghost}"/>`).join('')}
      <circle cx="${W + 8}" cy="${BOT}" r="${T / 2 + 1}" fill="${s & SEG_DP ? lit : ghost}"/>
    </g>`).join('');
  return `<svg viewBox="0 0 ${cells.length * pitch + 6} ${H + 12}" width="100%" height="100%"
              preserveAspectRatio="xMidYMid meet" role="img" aria-label="seven-segment digits">${digits}</svg>`;
}
