// Display attributes and the §14.7 palette.
//
// The same encoding as `tools/buttonboard/display.py`, and deliberately so: two
// clients that disagree about what ATTR 13 means is a bug nobody would find
// until a panel drew the wrong thing. Keep them in step.
//
// The two parts of §14.7 that catch people out, handled here so no caller has
// to know them:
//   - palette index 0 is "default", NOT black — white as ink, black as paper.
//     That is what keeps ATTR 0 legible on a colour tile, since ATTR 0 is what
//     every host written before colour existed sends.
//   - black ink has no index at all. It is reached by putting the wanted
//     background in the FOREGROUND field and setting inverse, which swaps the
//     two after the defaults resolve.

import { crc16CcittFalse } from './util.js';

export const CAP_DISPLAY = 1 << 4;
export const CAP_DISP_COLOR = 1 << 6;

export const ATTR_INVERSE = 0x01;
export const ATTR_DOUBLE = 0x02;
export const ATTR_FG_SHIFT = 2;
export const ATTR_BG_SHIFT = 5;
export const ATTR_COLOR_MASK = 0xFC;   // the six bits a mono tile refuses

// Index 1..7 of §14.7's palette. Black is absent because it has no index;
// `attrByte` reaches it through inverse.
export const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const INDEX = { red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7 };

// The palette as CSS, converted from the RGB565 values in core/skfont.c so the
// preview below is the colour the tile actually draws.
const CSS = ['#000000', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'];

// White in the foreground field is index 0's own resolution, so spell it that
// way: it renders the same, costs no colour bit, and therefore still reaches a
// monochrome tile instead of being refused for asking a mono panel for colour.
const fgIndex = (name) => (name === 'white' ? 0 : INDEX[name] ?? 0);

/** True if this pairing cannot be drawn at all. Black on black is the only one. */
export function unrepresentable(ink, paper) {
  return ink === 'black' && paper === 'black';
}

/** The ATTR byte of DISPLAY TEXT (§14.3, §14.7) for an ink/paper pairing. */
export function attrByte({ ink = 'white', paper = 'black', double = false } = {}) {
  let value = 0, inverse = false;
  if (ink === 'black') {
    if (paper === 'black') throw new Error('black on black cannot be drawn');
    // No black index: ask for the paper colour in the foreground field and let
    // inverse swap it into the ink.
    value = fgIndex(paper) << ATTR_FG_SHIFT;
    inverse = true;
  } else {
    value = fgIndex(ink) << ATTR_FG_SHIFT;
    if (paper !== 'black') value |= (INDEX[paper] ?? 0) << ATTR_BG_SHIFT;
  }
  if (inverse) value |= ATTR_INVERSE;
  if (double) value |= ATTR_DOUBLE;
  return value;
}

/** True if this ATTR needs CAP_DISP_COLOR — i.e. a mono tile would refuse it. */
export const isColor = (attr) => !!(attr & ATTR_COLOR_MASK);

/** The ink/paper an ATTR byte resolves to, as CSS. Mirrors sk_color565(). */
export function cssOf(attr) {
  const f = (attr >> ATTR_FG_SHIFT) & 7, b = (attr >> ATTR_BG_SHIFT) & 7;
  let ink = f === 0 ? CSS[7] : CSS[f];          // default foreground is white
  let paper = b === 0 ? CSS[0] : CSS[b];        // default background is black
  if (attr & ATTR_INVERSE) [ink, paper] = [paper, ink];
  return { ink, paper };
}

/**
 * The ink and paper names an ATTR byte resolves to: `attrByte` backwards, for
 * a picture read back from a slot (§14.9 READ) rather than chosen here.
 */
export function inkPaperOf(attr) {
  const f = (attr >> ATTR_FG_SHIFT) & 7, b = (attr >> ATTR_BG_SHIFT) & 7;
  let ink = f === 0 ? 'white' : NAMES[f];
  let paper = b === 0 ? 'black' : NAMES[b];
  if (attr & ATTR_INVERSE) [ink, paper] = [paper, ink];
  return { ink, paper };
}

/** What the tile accepts in a TEXT op: printable ASCII only (§14.3). */
export const ascii = (s) => [...String(s)].filter(c => c >= ' ' && c <= '~').join('');

/* ---- images (§14.8) ---------------------------------------------------
 * A picture is 1 bpp, MSB leftmost, sent a few pixel rows at a time and
 * expanded by the tile to the ink and paper of its ATTR. One bit per pixel is
 * not a style choice: 128x128 in colour is 32 KB, which is 2.3 s of auxiliary
 * slot and four times the tile's free flash, while 1 bpp is 2 KB and 0.15 s.
 * IMPLEMENTATION.md §34 has the arithmetic. */

/** Bytes per pixel row. The panel's width is always a multiple of 8 here. */
export const strideOf = (pxW) => pxW / 8;

/** Pixel rows in one DISP_IMAGE_MAX chunk — 4 on a 128 px panel. */
export const rowsPerChunk = (pxW, max = 64) => Math.floor(max / strideOf(pxW));

/**
 * Scale an ImageBitmap/HTMLImageElement to pxW x pxH and threshold it to 1 bpp
 * with Floyd-Steinberg error diffusion.
 *
 * Dithered rather than hard-thresholded because a logo thresholded at 50 %
 * loses every soft edge, and at this size that is most of the picture. The
 * caller passes `contain` to letterbox rather than crop, which is usually what
 * a square logo on a square key wants.
 */
export function ditherTo1bpp(source, pxW, pxH, { invert = false, contain = true, threshold = 128 } = {}) {
  const c = document.createElement('canvas');
  c.width = pxW; c.height = pxH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // Paper, so the letterbox bars are paper rather than whatever the canvas
  // started as -- on the tile an unset bit IS paper.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, pxW, pxH);

  const sw = source.width, sh = source.height;
  let dw = pxW, dh = pxH, dx = 0, dy = 0;
  if (contain) {
    const s = Math.min(pxW / sw, pxH / sh);
    dw = Math.round(sw * s); dh = Math.round(sh * s);
    dx = Math.round((pxW - dw) / 2); dy = Math.round((pxH - dh) / 2);
  }
  ctx.drawImage(source, dx, dy, dw, dh);

  const img = ctx.getImageData(0, 0, pxW, pxH).data;
  // Greyscale in one pass, as floats so the diffused error stays meaningful.
  const grey = new Float32Array(pxW * pxH);
  for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
    const a = img[p + 3] / 255;
    // Composite onto white: a transparent PNG logo is the common case and its
    // alpha is the shape.
    const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
    grey[i] = lum * a + 255 * (1 - a);
  }

  const stride = strideOf(pxW);
  const out = new Uint8Array(stride * pxH);
  for (let y = 0; y < pxH; y++) {
    for (let x = 0; x < pxW; x++) {
      const i = y * pxW + x;
      const old = grey[i];
      const dark = old < threshold;
      // A set bit is ink. Dark pixels are ink unless the caller inverts.
      const on = invert ? !dark : dark;
      if (on) out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      const err = old - (dark ? 0 : 255);
      // Floyd-Steinberg, clipped at the edges rather than wrapped.
      if (x + 1 < pxW)              grey[i + 1]        += err * 7 / 16;
      if (y + 1 < pxH) {
        if (x > 0)                  grey[i + pxW - 1]  += err * 3 / 16;
                                    grey[i + pxW]      += err * 5 / 16;
        if (x + 1 < pxW)            grey[i + pxW + 1]  += err * 1 / 16;
      }
    }
  }
  return out;
}

/**
 * Paint 1 bpp bytes onto a canvas in an ATTR's two colours.
 *
 * Deliberately fed the same `bits` that `imageChunks` sends rather than the
 * source image: a preview of the picture the tile will draw is worth having,
 * and a preview of the file you chose is not — the whole question the dither
 * raises is what survives it. A set bit is ink, exactly as on the tile.
 */
export function paint1bpp(canvas, bits, pxW, pxH, attr) {
  const { ink, paper } = cssOf(attr);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(pxW, pxH);
  const rgb = (css) => [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16)];
  const [ir, ig, ib] = rgb(ink), [pr, pg, pb] = rgb(paper);
  const stride = strideOf(pxW);
  for (let y = 0; y < pxH; y++) {
    for (let x = 0; x < pxW; x++) {
      const on = bits[y * stride + (x >> 3)] & (0x80 >> (x & 7));
      const p = (y * pxW + x) * 4;
      img.data[p] = on ? ir : pr;
      img.data[p + 1] = on ? ig : pg;
      img.data[p + 2] = on ? ib : pb;
      img.data[p + 3] = 255;
    }
  }
  canvas.width = pxW; canvas.height = pxH;
  ctx.putImageData(img, 0, 0);
}

/** Split a 1 bpp image into { row, hex } chunks, each a whole number of rows. */
export function imageChunks(bits, pxW, max = 64) {
  const stride = strideOf(pxW), rows = rowsPerChunk(pxW, max);
  const out = [];
  for (let r = 0; r * stride < bits.length; r += rows) {
    const slice = bits.subarray(r * stride, Math.min((r + rows) * stride, bits.length));
    out.push({ row: r, hex: [...slice].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('') });
  }
  return out;
}

/** One palette colour as CSS, by §14.7's name. Black is in the table here even
 * though it has no palette index: as a *paper* colour it is index 0's own
 * resolution, and a picture's paper is a canvas question rather than an ATTR. */
export const cssOfName = (name) => CSS[NAMES.indexOf(name) < 0 ? 0 : NAMES.indexOf(name)];

const rgbOf = (css) => [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16)];

/* ---- stored pictures (§14.9) -------------------------------------------
 * A tile with a `slots` count keeps whole pictures in a local SPI flash.
 * Loading one still costs the 2-4 s §14.8 refused to spend, but it costs it
 * ONCE at config time; every later change of legend is a single SHOW frame.
 * That is what puts RGB565 back on the table — the objection to 16 bits a
 * pixel was always the bus, never the tile, and the picture no longer crosses
 * the bus when it is shown. */

/** FMT `0x02`: two bytes a pixel, big endian, no ATTR (§14.9). */
export const RGB565_BYTES = (pxW, pxH) => pxW * pxH * 2;

/** Bytes a DATA chunk carries. 512 chunks for a 128x128 colour picture. */
export const SLOT_CHUNK = 64;

/**
 * Scale an ImageBitmap/HTMLImageElement to pxW x pxH and encode it as RGB565,
 * big endian, the byte order §14.9's FMT 0x02 names.
 *
 * Letterboxed rather than cropped and composited onto `paper`, for the same
 * reasons `ditherTo1bpp` does both: a square logo on a square key wants its
 * whole self, and a transparent PNG's alpha IS the shape, so something has to
 * be behind it. Unlike the 1 bpp path the paper is not an ATTR — FMT 0x02
 * carries no attribute and the tile must be sent a zero one — so the colour is
 * baked into the pixels here instead.
 */
export function encodeRgb565(source, pxW, pxH, { contain = true, paper = 'black' } = {}) {
  const c = document.createElement('canvas');
  c.width = pxW; c.height = pxH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = cssOfName(paper);
  ctx.fillRect(0, 0, pxW, pxH);

  const sw = source.width, sh = source.height;
  let dw = pxW, dh = pxH, dx = 0, dy = 0;
  if (contain) {
    const s = Math.min(pxW / sw, pxH / sh);
    dw = Math.round(sw * s); dh = Math.round(sh * s);
    dx = Math.round((pxW - dw) / 2); dy = Math.round((pxH - dh) / 2);
  }
  ctx.drawImage(source, dx, dy, dw, dh);

  // Alpha is composited by the canvas against the paper fill above, so the
  // pixels read back are already opaque; the divide by 255 is belt and braces
  // for a context that hands back anything else.
  const img = ctx.getImageData(0, 0, pxW, pxH).data;
  const [br, bg, bb] = rgbOf(cssOfName(paper));
  const out = new Uint8Array(RGB565_BYTES(pxW, pxH));
  for (let i = 0, p = 0, o = 0; i < pxW * pxH; i++, p += 4, o += 2) {
    const a = img[p + 3] / 255;
    const r = img[p] * a + br * (1 - a);
    const g = img[p + 1] * a + bg * (1 - a);
    const b = img[p + 2] * a + bb * (1 - a);
    const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
    out[o] = (v >> 8) & 0xFF;      // big endian: the high byte first
    out[o + 1] = v & 0xFF;
  }
  return out;
}

/**
 * Paint RGB565 bytes onto a canvas.
 *
 * Fed the wire bytes rather than the source image, exactly as `paint1bpp` is:
 * 5-6-5 throws away tone, and what a preview is for is showing what survives
 * the encoding. It is a smaller loss than the dither's, and that is the point
 * the two previews make side by side.
 */
export function paintRgb565(canvas, bytes, pxW, pxH) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(pxW, pxH);
  for (let i = 0, o = 0, p = 0; i < pxW * pxH; i++, o += 2, p += 4) {
    const v = (bytes[o] << 8) | bytes[o + 1];
    const r = (v >> 11) & 0x1F, g = (v >> 5) & 0x3F, b = v & 0x1F;
    // Replicate the top bits into the bottom ones, so 0x1F is 255 and not 248
    // -- the same expansion a panel driver does.
    img.data[p] = (r << 3) | (r >> 2);
    img.data[p + 1] = (g << 2) | (g >> 4);
    img.data[p + 2] = (b << 3) | (b >> 2);
    img.data[p + 3] = 255;
  }
  canvas.width = pxW; canvas.height = pxH;
  ctx.putImageData(img, 0, 0);
}

/**
 * Split a stored picture into { off, hex } chunks for `disp … slot … data`.
 *
 * Offsets are ascending and contiguous because §14.9 requires exactly that:
 * `OFF` must equal the number of bytes already accepted, which is what lets
 * the tile tell a retried chunk from a dropped one. A sender that skipped or
 * reordered would be told `args` on the first chunk out of step.
 */
export function slotChunks(bytes, max = SLOT_CHUNK) {
  const out = [];
  for (let off = 0; off < bytes.length; off += max) {
    const slice = bytes.subarray(off, Math.min(off + max, bytes.length));
    out.push({ off, hex: [...slice].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('') });
  }
  return out;
}

/**
 * The CRC `disp … slot … end` commits against: CRC-16/CCITT-FALSE over every
 * data byte, the same function `shared/crc.h` and `tools/buttonboard/crc.py` compute.
 *
 * Deliberately not a second implementation. Two clients that disagree about a
 * polynomial fail every commit with `err crc` and give nothing to debug with,
 * so this is `util.js`'s one, which `firmware.js` already stamps images with.
 */
export const slotCrc = (bytes) => crc16CcittFalse(bytes);
