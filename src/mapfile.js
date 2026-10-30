// The map as a file on disk: Export writes it, Import reads it back.
//
// The file is the bare map object of PROTOCOL.md §9.5, exactly what `map get`
// returns and `map set` accepts, pretty-printed. No wrapper and no metadata,
// so the same file goes back through `tools/buttonboard` or a terminal `map set`
// unchanged. Import also takes a whole `map get` reply ({"ok":true,"map":…}),
// because that is what someone copying from PuTTY ends up with.
//
// Platform-free: no DOM, no client. `app.js` does the download and the file
// picker; `tools/test_web.mjs` exercises this half.
import { mapFits } from './rumble.js';

export const mapFileText = (map) => JSON.stringify(map, null, 2) + '\n';

// `name` is optional (§9.5), so a nameless map is just "map".
export function mapFileName(map, date = new Date()) {
  const slug = String(map?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const day = date.toISOString().slice(0, 10);
  return `${slug || 'map'}-${day}.json`;
}

// Throws with a sentence fit for the status line. Only the checks that a file
// can fail and a map built by this app cannot; everything else is the
// module's to refuse, and `map set` names the offending entry when it does.
export function mapFromFileText(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('not a JSON file'); }
  if (obj && typeof obj === 'object' && obj.map && typeof obj.map === 'object') obj = obj.map;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not a map');
  if (obj.v !== 1) throw new Error(`map version ${JSON.stringify(obj.v ?? null)}, this board takes 1`);
  if (!mapFits(obj)) throw new Error('too big to store on the board');
  return obj;
}
