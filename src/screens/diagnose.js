// Diagnose: what the hardware is actually doing. Was the Tiles, Health and
// Test tabs.
//
// The three views are not three skins on one table — they answer different
// questions and carry different columns. Tiles is "what is on the bus",
// Counters is "which cable is failing", Power is §8.7's budget and the
// brightness clamp it produces.
import { state, setStatus } from '../app.js';
import { geom } from '../tilegeom.js';
import { XINPUT_SLOTS, padView } from '../xpad.js';

export const wide = true;
export const live = true;

const label = (n) => state.hello?.usb === 'xinput' ? (XINPUT_SLOTS[n - 1] ?? 'no XInput slot') : `Button ${n}`;

const VIEWS = ['Tiles', 'Counters', 'Power'];
let view = 0, mode = 'off', held = 0, stats = null;

const rows = () => state.tiles.filter(t => t.state !== 'cached');

function tilesView() {
  return `<table><thead><tr>
      <th>Addr</th><th>Type</th><th>State</th><th>Firmware</th><th>Carries</th><th>Pressed now</th>
    </tr></thead><tbody>
    ${rows().map(t => `<tr class="${t.state === 'lost' ? 'lost' : ''}">
      <td>${t.addr}</td><td>${t.type}</td><td>${t.state}</td><td class="mono">${t.fw}</td>
      <td class="muted">${t.keys} key${t.keys === 1 ? '' : 's'}${t.leds ? ` · ${t.leds} LEDs` : ''}${t.enc ? ` · ${t.enc} encoders` : ''}</td>
      <td><span class="dots">${Array.from({ length: t.keys }, (_, k) =>
        `<span class="dot ${t.pressed?.includes(k) ? 'down' : ''}" data-dot="${t.addr},${k}"
               style="border-radius:${geom(t).shape === 'round' ? '999px' : '3px'}"></span>`).join('')}</span></td>
    </tr>`).join('')}
  </tbody></table>`;
}

function countersView() {
  return `<table><thead><tr>
      <th>Addr</th><th>Type</th><th>State</th><th>CRC errors</th><th>Missed polls</th><th>Last seen</th>
    </tr></thead><tbody>
    ${rows().map(t => `<tr class="${t.state === 'lost' ? 'lost' : ''}">
      <td>${t.addr}</td><td>${t.type}</td><td>${t.state}</td>
      <td class="mono">${t.crcErr}</td><td class="mono">${t.missed}</td>
      <td class="mono">${t.lastSeen == null ? '—' : `${t.lastSeen} ms`}</td>
    </tr>`).join('')}
  </tbody></table>
  <p class="muted small">Counters run from the moment the board powered up, not from when this page opened.
     A count climbing on one tile names the cable to replace.</p>`;
}

function powerView() {
  const p = stats?.power;
  if (!p) return '<p class="muted">Counters unavailable.</p>';
  const lit = rows().reduce((n, t) => n + (t.leds ?? 0), 0);
  return `
    <table class="ident">
      <tr><th>Budget</th><td><input type="number" id="budget" min="100" max="4000" step="50" value="${p.budget}"> mA</td></tr>
      <tr><th>Worst case</th><td class="mono">${p.worst} mA <span class="muted">every LED white at once</span></td></tr>
      <tr><th>Brightness cap</th><td class="mono">${p.brightness} <span class="muted">of 255, chosen by the board to stay inside the budget</span></td></tr>
      <tr><th>LEDs on the bus</th><td class="mono">${lit}</td></tr>
    </table>
    <p><button id="setbudget">Apply budget</button></p>
    <p class="muted small">The board clamps brightness rather than browning out (§8.7). Raise the budget only
      if the supply and the cable can actually carry it — the connector's doubled 5 V pins are sized for the
      unclamped worst case, not for this number.</p>`;
}

export async function render(root) {
  try { stats = await state.client.stats(); mode = stats.test ?? mode; } catch { /* keep last */ }

  // The screen scrolls now that the bench carries a pad, and every click here
  // rebuilds it; keep the reader where they were.
  const scrolled = root.querySelector('.diag')?.scrollTop ?? 0;
  const lost = rows().filter(t => t.state === 'lost');
  const body = [tilesView, countersView, powerView][view]();

  root.innerHTML = `
  <div class="diag">
    ${lost.length ? `<p class="notice risk"><strong>${lost.map(t => `Tile ${t.addr}`).join(', ')} ${lost.length === 1 ? 'is' : 'are'} lost.</strong>
       ${lost.length === 1 ? 'Its' : 'Their'} buttons read released. Counters name the cable to replace.</p>` : ''}

    <div class="pills">
      ${VIEWS.map((v, i) => `<button class="pill ${i === view ? 'sel' : ''}" data-view="${i}">${v}</button>`).join('')}
    </div>

    <div class="card">${body}</div>

    <div class="card">
      <div class="card-head">
        <strong>Report bench</strong>
        <span class="mono muted">${mode === 'off' ? 'test off' : mode === 'hold' ? `test hold ${held}` : `test ${mode}`}</span>
      </div>
      <p class="muted">The board generates the gamepad report itself here, ignoring tiles and the map entirely,
        so a Driver Station can be watched with nothing plugged into the bus.</p>
      <p class="benchbar">
        <button class="primary" data-mode="walk">Walk 1 → 32</button>
        <label>step <input type="number" id="ms" min="50" max="5000" step="50" value="250"> ms</label>
        <button data-mode="all">All on</button>
        <button data-mode="off">Stop</button>
      </p>
      <div class="group">
        ${Array.from({ length: 32 }, (_, i) => i + 1).map(n =>
          `<button class="key wide ${mode === 'all' || held === n ? 'down' : ''}" data-hold="${n}" title="${label(n)}">${n}</button>`).join('')}
      </div>
      <div class="bench-pad">${padView({ attr: 'hold',
        cls: n => mode === 'all' || held === n ? 'down' : '',
        title: n => `Hold button ${n} · ${XINPUT_SLOTS[n - 1]}` })}</div>
      <p class="notice small">Test mode ends the moment this page disconnects, so nothing can be left stuck on.
        It is never saved and does not survive a reset.</p>
    </div>

    <p class="mono muted diag-foot">
      ${stats ? `uptime ${stats.uptime} s · poll cycle ${stats.pollCycleUs} µs` : 'counters unavailable'}
      · reporting as <strong>${state.hello?.usb ?? '—'}</strong>
    </p>
  </div>`;

  root.querySelector('.diag').scrollTop = scrolled;

  const run = async (fn, desc) => {
    try { const r = await fn(); mode = r.test; setStatus(desc, 'ok'); render(root); }
    catch (e) { setStatus(`Test: ${e.message === 'busy' ? 'not while binding' : e.message}`, 'fault'); }
  };

  root.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.view) { view = +b.dataset.view; return render(root); }
    if (b.id === 'setbudget') {
      const mA = +root.querySelector('#budget').value;
      try { const r = await state.client.powerBudget(mA); setStatus(`Power budget ${r.budget} mA (unsaved)`, 'ok'); render(root); }
      catch (err) { setStatus(`Power: ${err.message}`, 'fault'); }
      return;
    }
    if (b.dataset.mode === 'walk') {
      const ms = +root.querySelector('#ms').value;
      held = 0; return run(() => state.client.test('walk', ms), `Walking every ${ms} ms`);
    }
    if (b.dataset.mode === 'all') { held = 0; return run(() => state.client.test('all'), 'All 32 asserted'); }
    if (b.dataset.mode === 'off') { held = 0; return run(() => state.client.test('off'), 'Test stopped'); }
    if (b.dataset.hold) {
      const n = +b.dataset.hold;
      if (held === n) { held = 0; return run(() => state.client.test('off'), 'Test stopped'); }
      held = n; return run(() => state.client.test('hold', n), `Holding ${label(n)}`);
    }
  };
}

// Only the Tiles view carries live dots; patch them rather than rebuilding a
// screen that has a number input and a running test on it.
export function tick(root) {
  for (const el of root.querySelectorAll('[data-dot]')) {
    const [addr, key] = el.dataset.dot.split(',').map(Number);
    const t = state.tiles.find(x => x.addr === addr);
    el.classList.toggle('down', !!t?.pressed?.includes(key));
  }
}
