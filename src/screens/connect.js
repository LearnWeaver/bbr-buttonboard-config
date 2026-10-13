// Connect: the gate. Port picker before anything, board identity and the USB
// personality after.
//
// This screen owns the ONLY USB personality control in the app. Firmware used
// to carry a second, unguarded copy; switching to `xinput` removes the config
// port this page talks over (PROTOCOL.md §8.3), so the warning below is not
// optional decoration and there must not be a way around it.
import { connectBoard, setStatus, state } from '../app.js';

export const wide = true;

const XINPUT_WARNING = `Switching to xinput removes the config port this page talks over.
To reach the board from here again, hold its CFG button while plugging it in.

Continue?`;

const isMock = new URL(location.href).searchParams.get('mock') === '1';

const ICON_OK = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const ICON_TERM = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`;

function disconnected() {
  return `
    <h2 class="hero">Plug in the main module</h2>
    <p class="hero-sub">Then choose its port. The browser only opens a serial port from a click, so this
      button is the one thing that cannot be skipped.</p>

    <p class="hero-actions">
      <button class="primary big" id="connect">Choose port and connect</button>
      ${isMock ? '<span class="muted">running against the demo board</span>'
               : '<span class="muted">or</span> <button class="big" id="demo">Open the demo board</button>'}
    </p>

    <div class="facts">
      <div>
        <div class="insp-title">Browser</div>
        <div class="fact">${ICON_OK}<span>Chrome, Edge and Opera on desktop. Firefox and Safari have no Web
          Serial and cannot talk to the board.</span></div>
      </div>
      <div>
        <div class="insp-title">In the pit, without this page</div>
        <div class="fact">${ICON_TERM}<span>Open the COM port in any terminal and type <code>tiles</code>.</span></div>
      </div>
    </div>

    <p class="notice"><strong>A board set to <code>xinput</code> has no config port.</strong><br>
      Hold its CFG button while plugging it in, and it will appear here.</p>`;
}

function connected(h) {
  const pending = h.usb !== h.usbSaved;
  const rows = [
    ['Product', h.product], ['Firmware', h.fw], ['Protocol', h.proto],
    ['Hardware', h.hw], ['Serial', h.serial], ['Tiles', h.tiles],
    ['Saved setup', h.mapValid ? 'yes' : 'none'], ['Mode', h.mode],
  ];
  return `
    <h2 class="hero">Connected</h2>
    <p class="hero-sub">Reporting as <strong>${h.usb}</strong>${pending ? `, switching to <strong>${h.usbSaved}</strong> after Save and a reset` : ''}.</p>

    <div class="facts">
      <div>
        <div class="insp-title">Board</div>
        <table class="ident">${rows.map(([k, v]) => `<tr><th>${k}</th><td class="mono">${v}</td></tr>`).join('')}</table>
      </div>
      <div>
        <div class="insp-title">USB mode</div>
        <p class="muted small">What the board shows up as on the computer. <code>frc</code> is a plain gamepad plus this
          config port; <code>xinput</code> is an Xbox 360 pad, which is what the FTC Driver Station wants.</p>
        <p><select id="usb">
          ${['frc', 'xinput'].map(m => `<option value="${m}" ${h.usbSaved === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select></p>
        <p class="notice small"><strong>Choosing <code>xinput</code> disconnects this page.</strong>
          To connect again, hold the CFG button while plugging the board in.</p>
        ${'pixel' in h ? `
        <div class="insp-title">Status light</div>
        <p><label><input type="checkbox" id="pixel" ${h.pixel ? 'checked' : ''}>
          Flash the main module's light white on every button press</label></p>
        <p class="muted small">A quick way to see the board is sending presses, with no Driver Station
          needed. Works in both modes. Save to keep it after a power cycle.</p>`
          : ''}
        <p><button id="connect">Choose a different port</button></p>
      </div>
    </div>`;
}

export function render(root) {
  const h = state.hello;
  root.innerHTML = `<div class="gate">${h ? connected(h) : disconnected()}</div>`;

  root.querySelector('#connect').onclick = async () => {
    try { setStatus('Connecting…'); await connectBoard(); }
    catch (e) { setStatus(`Connect failed: ${e.message}`, 'fault'); }
  };

  const demo = root.querySelector('#demo');
  if (demo) demo.onclick = () => { location.search = '?mock=1'; };

  const px = root.querySelector('#pixel');
  if (px) px.onchange = async () => {
    try {
      await state.client.pixel(px.checked);
      state.hello = await state.client.hello();
      setStatus(`Status light ${px.checked ? 'on' : 'off'} (unsaved)`, 'ok');
    } catch (e) { px.checked = !px.checked; setStatus(`Status light: ${e.message}`, 'fault'); }
  };

  const sel = root.querySelector('#usb');
  if (sel) sel.onchange = async () => {
    const mode = sel.value;
    if (mode === 'xinput' && !confirm(XINPUT_WARNING)) { sel.value = state.hello.usbSaved; return; }
    try {
      await state.client.usb(mode);
      state.hello = await state.client.hello();
      setStatus(`USB mode ${mode} — Save, then unplug the board and plug it back in`, 'ok');
      render(root);
    } catch (e) { setStatus(`USB: ${e.message}`, 'fault'); }
  };
}
