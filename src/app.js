import { ProtocolClient, groupsOf } from './protocol.js';
import { SerialTransport } from './transport/serial.js';
import { MockTransport } from './transport/mock.js';
import * as connect from './screens/connect.js';
import * as configure from './screens/configure.js';
import * as diagnose from './screens/diagnose.js';
import * as firmware from './screens/firmware.js';
import * as legends from './screens/legends.js';
import { mapFileText, mapFileName, mapFromFileText } from './mapfile.js';

const screens = { connect, configure, legends, diagnose, firmware };

export const state = {
  client: null, transport: null, hello: null, tiles: [], map: null, dirty: false, screen: 'connect',
  get groups() { return groupsOf(this.map); },
};

const $ = (s) => document.querySelector(s);
const useMock = new URL(location.href).searchParams.get('mock') === '1';
if (!useMock && !SerialTransport.supported()) $('#unsupported').hidden = false;

export async function connectBoard() {
  const t = useMock ? new MockTransport() : new SerialTransport();
  await t.open();
  const c = new ProtocolClient(t);
  state.transport = t; state.client = c;
  c.on('tile', () => refreshTiles());
  c.on('fault', (e) => setStatus(e.on ? `Fault: ${e.why}` : 'Connected', e.on ? 'fault' : 'ok'));
  state.hello = await c.hello();
  await refreshAll();
  setStatus(`Connected · ${state.hello.product} ${state.hello.fw} · ${state.hello.usb}`, 'ok');
  for (const b of document.querySelectorAll('#tabs button')) b.disabled = false;
  for (const id of ['#save', '#map-export', '#map-import']) $(id).disabled = false;
  show('configure');
}

// `rerender` is false for the live tick: a screen that wants live pressed
// state patches it in `tick()` instead, so a 250 ms rebuild never lands in the
// middle of someone's click.
export async function refreshTiles({ rerender = true } = {}) {
  if (!state.client) return;
  state.tiles = (await state.client.tiles()).tiles;
  if (rerender && state.screen !== 'connect') render();
}
export async function refreshMap() {
  const r = await state.client.mapGet();
  state.map = r.map; state.dirty = !!r.dirty;
  $('#dirty').hidden = !state.dirty;
}
export async function refreshAll() { await refreshTiles(); await refreshMap(); }

export function setStatus(text, cls = '') { const el = $('#status'); el.textContent = text; el.className = `status ${cls}`; }

export function show(name) {
  state.screen = name;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.screen === name);
  render();
}
export function render() {
  const root = $('#screen');
  root.className = screens[state.screen].wide ? 'wide' : '';
  root.innerHTML = '';
  screens[state.screen].render(root);
}

$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) show(b.dataset.screen); });
$('#save').addEventListener('click', async () => {
  try { await state.client.save(); await refreshMap(); setStatus('Saved', 'ok'); }
  catch (e) { setStatus(`Save failed: ${e.message}`, 'fault'); }
});

// Export reads the map fresh rather than trusting state.map, so the file is
// what the board holds in RAM, unsaved edits included (§9.2 `map get`).
$('#map-export').addEventListener('click', async () => {
  try {
    await refreshMap();
    const name = mapFileName(state.map);
    const url = URL.createObjectURL(new Blob([mapFileText(state.map)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`Exported ${name}${state.dirty ? ', including unsaved changes' : ''}`, 'ok');
  } catch (e) { setStatus(`Export failed: ${e.message}`, 'fault'); }
});
// Import is a `map set`, so like every other edit it lands in RAM and waits
// for Save. The map keys on address (§9.5): it binds the same addresses on
// this board, whichever tiles sit there.
$('#map-import').addEventListener('click', () => $('#map-import-file').click());
$('#map-import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const m = mapFromFileText(await f.text());
    if (state.dirty && !confirm('The board has unsaved changes. Importing replaces the whole map. Continue?')) return;
    await state.client.mapSet(m);
    await refreshMap();
    render();
    setStatus(`Imported ${f.name} (unsaved). Save to board to keep it`, 'ok');
  } catch (err) { setStatus(`Import failed: ${err.message}`, 'fault'); }
});

// Live pressed indicators, for whichever screen asks for them.
setInterval(async () => {
  const s = screens[state.screen];
  if (!state.client || !s?.live) return;
  await refreshTiles({ rerender: false });
  s.tick?.($('#screen'));
}, 250);

show('connect');
