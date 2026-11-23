// A tile's heartbeat LED (PROTOCOL.md §4.5 CFG_HB_OFF, §9.5 rev 0.48): the
// green light that blinks while the tile runs. The map's `heartbeat` section
// holds it off per tile address. Platform-free, so the tests and the mock use it too.

/** True if the tile at `addr` blinks: the default, unless the map says "off". */
export function heartbeatOn(map, addr) {
  return map?.heartbeat?.[addr] !== 'off';
}

/**
 * The map with tile `addr`'s heartbeat on or off. On is the default, so it
 * removes the entry, and the section goes once it is empty, as map.c's
 * canonical form has it.
 */
export function withHeartbeat(map, addr, on) {
  const m = structuredClone(map ?? { v: 1, bind: [] });
  m.heartbeat = { ...(m.heartbeat ?? {}) };
  if (on) delete m.heartbeat[addr]; else m.heartbeat[addr] = 'off';
  if (!Object.keys(m.heartbeat).length) delete m.heartbeat;
  return m;
}

/**
 * map.c's check of a `heartbeat` section: { err: 'heartbeat' } for a fault, or
 * { canonical }, the section as the module would hand it back.
 */
export function heartbeatCheck(hb) {
  if (hb === undefined) return { canonical: undefined };
  if (typeof hb !== 'object' || hb === null || Array.isArray(hb)) return { err: 'heartbeat' };
  const canonical = {};
  for (const [k, v] of Object.entries(hb)) {
    const addr = /^\d+$/.test(k) ? +k : NaN;
    if (!(addr >= 1 && addr <= 31) || (v !== 'on' && v !== 'off')) return { err: 'heartbeat' };
    if (v === 'off') canonical[addr] = 'off';
  }
  return { canonical: Object.keys(canonical).length ? canonical : undefined };
}
