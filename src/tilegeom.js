// How each tile type is laid out physically, so the Configure screen can draw
// a tile the way it sits in front of you rather than as a table row.
//
// KEY_COUNT from the descriptor is authoritative over what TYPE implies
// (PROTOCOL.md §5), so `geom` never trusts the table for the key count — the
// table only supplies the shape of the arrangement. An unknown type still
// draws, as a near-square grid; that is the §5 "type":"unknown" case and it
// must not be a blank screen.

const TYPES = {
  mx9:    { cols: 3, shape: 'square', name: '3×3 MX' },
  mx9rgb: { cols: 3, shape: 'square', name: '3×3 MX RGB' },
  mx6:    { cols: 3, shape: 'square', name: '3×2 MX' },
  mx6rgb: { cols: 3, shape: 'square', name: '3×2 MX RGB' },
  mx1:    { cols: 1, shape: 'square', name: 'Single MX' },
  mx3:    { cols: 3, shape: 'square', name: '3 MX in a row' },
  // Not a grid: K1 sits above K3. `cells` gives each key's [row, column],
  // 1-based for CSS grid, in key order (PROTOCOL.md §5: reading order).
  mx4:    { cols: 3, shape: 'square', name: '4 MX (WASD)', cells: [[1, 2], [2, 1], [2, 2], [2, 3]] },
  arc4:   { cols: 2, shape: 'round',  name: '4 arcade' },
  enc2:   { cols: 2, shape: 'round',  name: '2 encoders' },
  enc1:   { cols: 1, shape: 'round',  name: '1 encoder' },
  // Display tiles (§14). `disp1` has no keys at all, and `screenkey1` has
  // exactly one because its panel *is* the key's legend.
  disp1:      { cols: 1, shape: 'square', name: 'Display' },
  screenkey1: { cols: 1, shape: 'square', name: 'Screen key' },
  disp2:      { cols: 1, shape: 'square', name: 'Colour display' },
};

const CAP_DISP_COLOR = 1 << 6;      // shared/protocol.h; §9.5 gives it no field
const CAP_DEBOUNCE = 1 << 1;        // shared/protocol.h: honours SET_CONFIG debounce (§4.5)

// The debounce the module sends a tile when the map has no override for it:
// firmware/core/tilesm.c tilesm_default_debounce(), PROTOCOL.md §4.5.
export function defaultDebounce(type) {
  return type === 'arc4' ? 20 : 5;
}

// A debounce setting only means something on a tile with keys that honours it.
export function hasDebounce(tile) {
  return tile.keys > 0 && !!(tile.caps & CAP_DEBOUNCE);
}

export function geom(tile) {
  const t = TYPES[tile.type];
  const keys = tile.keys ?? 0;
  // `cells` only when the tile has exactly the keys the table expects; any
  // other count falls back to the plain grid rather than misplacing keys.
  // An RGB build is the same TYPE with LEDs (board_mx4.h, board_mx1.h), so
  // the name comes from the LED count rather than from the table.
  const rgb = tile.leds > 0 && t && !t.name.endsWith('RGB') ? ' RGB' : '';
  if (t) return { cols: Math.min(t.cols, Math.max(keys, 1)), shape: t.shape, name: t.name + rgb,
                  cells: t.cells && t.cells.length === keys ? t.cells : null };
  return { cols: Math.ceil(Math.sqrt(Math.max(keys, 1))), shape: 'square', name: tile.type };
}

// A display tile's panel is not bindable and is not drawn here: the rows come
// from a companion app at run time (§14.4), not from a saved layout. Say what
// the panel is, so a tile with no keys is not a blank card.
export function displayNote(tile) {
  if (!tile.cols || !tile.rows) return '';
  const colour = (tile.caps & CAP_DISP_COLOR) ? 'colour' : 'mono';
  return `${tile.cols} × ${tile.rows} ${colour} character panel — written at run time over the config channel (§14.4)`;
}

// Encoders are not keys and are not in the POLL bitmap (PROTOCOL.md §15): the
// keys a tile reports are the shaft pushes. Say so under the diagram rather
// than drawing something that implies you can bind a detent here.
export function encoderNote(tile) {
  return tile.enc ? `${tile.enc} rotary encoder${tile.enc === 1 ? '' : 's'} → axes, bound separately` : '';
}
