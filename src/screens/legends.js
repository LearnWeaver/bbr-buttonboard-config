// Legends: every rumble code at once (PROTOCOL.md §8.8).
//
// Configure edits a code from one tile's or one key's side. This screen is
// the other view: one row per code, with everything that code does across
// the whole board — the picture it shows, the messages it writes and the key
// colours it sets — and the call that sends it. Read-only: each entry links
// to the inspector that edits it.
import { state, setStatus, show } from '../app.js';
import { geom } from '../tilegeom.js';
import { RUMBLE_CODE_MAX, bindFor, textsOf, ledActionsOf, usedCodes, showLegendCall } from '../rumble.js';
import { cssOf } from '../dispattr.js';
import { focusTile } from './configure.js';

export const wide = true;

let showUnused = false;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const tileAt = (addr) => state.tiles.find(t => t.addr === addr && t.state !== 'cached') ?? null;

function tileName(addr) {
  const t = tileAt(addr);
  return t ? `${esc(geom(t).name)} <span class="mono muted">tile ${addr}</span>`
           : `<span class="muted">tile ${addr} (not connected)</span>`;
}

// The message as the panel would draw it: its rows in their colours, padded
// to the panel's width when the tile is here to say what that is.
function miniPanel(e) {
  const t = tileAt(e.addr);
  const rows = t?.rows ?? e.rows.length, cols = t?.cols ?? Math.max(1, ...e.rows.map(r => r.length));
  const out = [];
  for (let r = 0; r < rows; r++) {
    const a = e.attrs?.[r] ?? 0, dbl = !!(a & 0x02) && r + 1 < rows;
    const { ink, paper } = cssOf(a);
    const text = (e.rows[r] ?? '').slice(0, cols).padEnd(cols);
    out.push(`<div class="mini-row${dbl ? ' dbl' : ''}" style="background:${paper};color:${ink}">${esc(text)}</div>`);
    if (dbl) r++;
  }
  return `<div class="minipanel" style="--cols:${cols}">${out.join('')}</div>`;
}

function codeCard(code) {
  const pic = bindFor(state.map, code);
  const msgs = textsOf(state.map, { code });
  const leds = ledActionsOf(state.map, { code });
  const used = pic || msgs.length || leds.length;
  const items = [];

  if (pic) {
    items.push(`<div class="legend-item">
      <div class="legend-what">Picture</div>
      <div class="legend-body">${tileName(pic.addr)} · picture slot ${pic.slot}</div>
      <button data-edit="${pic.addr}" data-kind="disp">Edit</button>
    </div>`);
  }
  for (const e of msgs) {
    items.push(`<div class="legend-item">
      <div class="legend-what">Message</div>
      <div class="legend-body">${tileName(e.addr)}${miniPanel(e)}</div>
      <button data-edit="${e.addr}" data-kind="disp">Edit</button>
    </div>`);
  }
  if (leds.length) {
    items.push(`<div class="legend-item">
      <div class="legend-what">Key colours</div>
      <div class="legend-body">${leds.map(l => `<span class="chip">${'btn' in l ? `Button ${l.btn}` : `${tileName(l.addr)} K${l.led + 1}`}
        ${l.rgb === 'map' ? '<span class="muted">back to normal</span>'
          : `<span class="keycell-led" style="display:inline-block;vertical-align:middle;background:#${l.rgb === 'off' ? '000' : esc(l.rgb)}"></span>
             ${l.rgb === 'off' ? 'off' : `#${esc(l.rgb)}`}`}${l.fx && l.fx !== 'solid' ? ` · ${esc(l.fx)}` : ''}</span>`).join(' ')}</div>
    </div>`);
  }

  return `<div class="card legend-card ${used ? '' : 'unused'}">
    <div class="card-head">
      <strong>Code ${code}</strong>
      <span class="mono muted">${esc(showLegendCall(code))}</span>
    </div>
    ${used ? items.join('') : '<p class="muted small">Not used.</p>'}
  </div>`;
}

export function render(root) {
  const used = usedCodes(state.map);
  const codes = Array.from({ length: RUMBLE_CODE_MAX }, (_, i) => i + 1).filter(c => showUnused || used.includes(c));
  const calls = used.map(c => showLegendCall(c)).join('\n');

  root.innerHTML = `
  <div class="diag legends">
    <h2>Legends</h2>
    <p class="muted">What each rumble code does when the robot sends it during a match: the picture it shows,
      the message it writes and the key colours it sets. ${used.length
        ? `${used.length} of ${RUMBLE_CODE_MAX} codes are in use.`
        : 'No code does anything yet: give a display tile a picture or a message, or a key a robot colour, on the Configure screen.'}</p>
    <p><label><input type="checkbox" id="unused" ${showUnused ? 'checked' : ''}> Show unused codes</label></p>
    ${codes.map(codeCard).join('')}
    ${used.length ? `
    <div class="card">
      <div class="card-head"><strong>In the OpMode</strong><button id="copy">Copy</button></div>
      <pre class="ftccall">${esc(calls)}</pre>
      <p class="muted small">Calls on the <code>ButtonBoard</code> helper class. Without it, send code
        <em>n</em> with <code>gamepad1.rumble(n / 15.0, 0, 100)</code>. The FTC SDK may drop a code sent
        less than 50 ms after another.</p>
    </div>` : ''}
  </div>`;

  root.onchange = (e) => {
    if (e.target.id === 'unused') { showUnused = e.target.checked; render(root); }
  };
  root.onclick = async (e) => {
    const b = e.target.closest('[data-edit],#copy');
    if (!b) return;
    if (b.id === 'copy') {
      try { await navigator.clipboard.writeText(calls); setStatus('OpMode calls copied', 'ok'); }
      catch { setStatus('Copy refused by the browser — select the block instead', 'fault'); }
      return;
    }
    focusTile(+b.dataset.edit, b.dataset.kind);
    show('configure');
  };
}
