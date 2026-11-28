// LED bar tiles (PROTOCOL.md §14.12), for drawing a bar16 as the tile lights it.
//
// The zone colours are shared/ledbar.h's; tools/test_web.mjs checks the two
// agree. Green for the first 60 % of the bar, yellow to 85 %, red above.

const GREEN = '#00ff00', YELLOW = '#ffa000', RED = '#ff0000';

export function ledbarZone(i, n) {
  const pct = n ? Math.floor((i * 100) / n) : 0;
  return pct < 60 ? GREEN : pct < 85 ? YELLOW : RED;
}

// How many cells BAR lights for a value (§14.11/§14.12): one per whole
// 1/width of 0-255, and at least one for any non-zero value.
export function ledbarLit(value, width) {
  const lit = Math.floor((value * width) / 255);
  return value && !lit ? 1 : lit;
}
