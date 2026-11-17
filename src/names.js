// Tile names (PROTOCOL.md §9.5, rev 0.44): the map's `names` section, a short
// label per tile address. Platform-free, so the tests and the mock use it too.

export const TILE_NAME_MAX = 16;            // map.h MAP_TILE_NAME_MAX

/** Why `s` cannot be a tile name, or null if it can. */
export function tileNameError(s) {
  if (typeof s !== 'string') return 'not text';
  if (s.length > TILE_NAME_MAX) return `${TILE_NAME_MAX} characters at most`;
  if (!/^[\x20-\x7E]*$/.test(s)) return 'plain letters, digits and punctuation only';
  return null;
}

/** The tile's name in this map, or '' if it has none. */
export function tileName(map, addr) {
  return map?.names?.[addr] ?? '';
}

/**
 * The map with tile `addr` named `name` (trimmed). An empty name removes the
 * entry, and the section goes once it is empty, as map.c's canonical form has it.
 */
export function withTileName(map, addr, name) {
  const m = structuredClone(map ?? { v: 1, bind: [] });
  const n = String(name ?? '').trim();
  m.names = { ...(m.names ?? {}) };
  if (n) m.names[addr] = n; else delete m.names[addr];
  if (!Object.keys(m.names).length) delete m.names;
  return m;
}

/**
 * map.c's check of a `names` section: { err, addr } for the first fault, or
 * null. `canonical` is the section as the module would hand it back.
 */
export function namesCheck(names) {
  if (names === undefined) return { canonical: undefined };
  if (typeof names !== 'object' || names === null || Array.isArray(names)) return { err: 'name' };
  const canonical = {};
  for (const [k, v] of Object.entries(names)) {
    const addr = /^\d+$/.test(k) ? +k : NaN;
    if (!(addr >= 1 && addr <= 31)) return { err: 'name' };
    if (tileNameError(v)) return { err: 'name', addr };
    if (v) canonical[addr] = v;
  }
  return { canonical: Object.keys(canonical).length ? canonical : undefined };
}
