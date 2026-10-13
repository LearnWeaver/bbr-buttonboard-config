// Firmware screen: main-module BOOTSEL and tile updates from the same-origin
// manifest (web/firmware/README.md, PROTOCOL.md §9.4).
//
// The USB personality control used to live here as well as on Connect. It is
// gone from this screen deliberately: switching to `xinput` removes the config
// port this page talks over (§8.3), and only Connect's copy warns about that
// before doing it. One guarded control beats two, one of which is a trap.
import { state, setStatus, refreshTiles } from '../app.js';
import { crc16CcittFalse, hex16, semverCmp } from '../util.js';

export const wide = true;

let manifest = null, allowSame = false, busyAddr = null, progress = null;

async function loadManifest() {
  if (manifest) return manifest;
  const r = await fetch('firmware/manifest.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`manifest ${r.status}`);
  manifest = await r.json();
  return manifest;
}

function candidate(tile) {
  const proto = state.hello?.proto ?? 1;
  const imgs = (manifest?.images ?? []).filter(i => i.type === tile.type && i.proto === proto);
  if (!imgs.length) return null;
  imgs.sort((a, b) => semverCmp(b.fw, a.fw));
  const best = imgs[0];
  const newer = semverCmp(best.fw, tile.fw) > 0;
  return { img: best, newer, offer: newer || allowSame };
}

const logLines = () => (state.client?.log ?? []).slice(-40).join('\n');

export async function render(root) {
  let manifestErr = '';
  try { await loadManifest(); } catch (e) { manifestErr = e.message; }

  const cards = state.tiles.filter(t => t.state !== 'cached').map(t => {
    const c = candidate(t);
    const running = busyAddr === t.addr;
    const stale = c?.newer;
    const offer = c && c.offer && t.state === 'online' && busyAddr === null;

    let action;
    if (running) action = '<span class="fwbtn busy">Updating…</span>';
    else if (t.state !== 'online') action = `<span class="fwbtn none">tile ${t.state}</span>`;
    else if (offer) action = `<button class="fwbtn go" data-flash="${t.addr}">Update to ${c.img.fw}</button>`;
    else if (c) action = `<span class="fwbtn none">${c.newer ? 'update available' : 'up to date'}</span>`;
    else action = '<span class="fwbtn none">no image</span>';

    return `<div class="fwcard ${stale ? 'stale' : ''} ${t.state === 'lost' ? 'lost' : ''}">
      <div class="fwcard-top">
        <div>
          <div class="fwcard-name">Tile ${t.addr} · ${t.type}</div>
          <div class="mono muted small">running ${t.fw} · latest ${c ? c.img.fw : '—'}</div>
        </div>
        ${action}
      </div>
      ${running && progress ? `<div class="fwbar"><div class="fwfill" style="width:${Math.round(100 * progress.done / progress.total)}%"></div></div>
        <div class="muted small fwnote">${progress.done} of ${progress.total} bytes · the other tiles are still being polled</div>` : ''}
    </div>`;
  }).join('');

  root.innerHTML = `
  <div class="fw">
    <section class="fw-tiles">
      <h2>Tiles</h2>
      <p class="muted">Pushed over the bus by the main module — no programmer. Images come from this site's
        manifest${manifest ? ` (generated ${manifest.generated})` : ''}. The other tiles keep being polled throughout.</p>
      ${manifestErr ? `<p class="notice risk">Could not load the firmware manifest: ${manifestErr}</p>` : ''}
      <p><label><input type="checkbox" id="same" ${allowSame ? 'checked' : ''}> Allow reflashing the same or an older version</label></p>
      ${cards || '<p class="muted">No tiles on the bus.</p>'}
    </section>

    <aside class="fw-side">
      <h2>Main module</h2>
      <p class="muted">Reboots into its bootloader and appears as the RPI-RP2 drive. Drag the new
        <code>.uf2</code> onto it.</p>
      <div class="fwcard">
        <div class="fwcard-top">
          <div class="mono">${state.hello?.fw ?? '—'}</div>
          <button class="fwbtn" id="boot">Reboot for UF2 update</button>
        </div>
      </div>
      <p class="notice small"><strong>The COM port disappears.</strong>
        This page loses the board until the update is copied across and it restarts.</p>
      <div class="insp-title">Config channel</div>
      <pre class="log" id="fwlog">${logLines()}</pre>
    </aside>
  </div>`;

  const log = root.querySelector('#fwlog');
  log.scrollTop = log.scrollHeight;

  root.querySelector('#boot').onclick = () => state.client.boot().catch(() => {});
  root.querySelector('#same').onchange = (e) => { allowSame = e.target.checked; render(root); };
  root.onclick = async (e) => {
    const f = e.target.closest('[data-flash]');
    if (f && busyAddr === null) await flashTile(root, +f.dataset.flash);
  };
}

async function flashTile(root, addr) {
  const tile = state.tiles.find(t => t.addr === addr);
  const c = candidate(tile);
  if (!c) return;
  busyAddr = addr; progress = null;
  render(root);
  try {
    const r = await fetch(`firmware/${c.img.file}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`image ${r.status}`);
    const image = new Uint8Array(await r.arrayBuffer());
    const crc = hex16(crc16CcittFalse(image));
    if (image.length !== c.img.size || crc !== c.img.crc16.toUpperCase())
      throw new Error(`image does not match manifest (size ${image.length}/${c.img.size}, crc ${crc}/${c.img.crc16})`);
    setStatus(`Updating tile ${addr} to ${c.img.fw}…`, 'fault');
    const res = await state.client.flash(addr, image, crc, (done, total) => {
      progress = { done, total };
      render(root);
    });
    setStatus(`Tile ${addr} verified, now running ${res.fw}`, 'ok');
  } catch (err) {
    setStatus(`Update failed: ${err.message}`, 'fault');
  } finally {
    busyAddr = null; progress = null;
    await refreshTiles({ rerender: false });
    render(root);
  }
}
