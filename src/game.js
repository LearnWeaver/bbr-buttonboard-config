// Tile Runner's page: the setup steps, the loop and the drawing. The rules
// and the input reading are in game-core.js.

import { W, H, GROUND, newGame, step, runnerBox, restOf, controlsDown, controlName, padKind,
         repeatTracker } from './game-core.js';

const $ = (s) => document.querySelector(s);
const cv = $('#field'), ctx = cv.getContext('2d');
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const C = { ink: css('--ink'), muted: css('--muted'), rule: css('--rule'), accent: css('--accent'), surface: css('--surface') };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: not kept */ } },
};

// wait (the first key held picks the board, and is JUMP unless keys are saved for it)
// → bindJump → bindDuck → ready → play → over → play ...
let phase = 'wait';
let padIndex = null, padId = null, rest = [], standard = false;
let bind = null;                    // { jump, duck } control ids
let pending = null;                 // the control being bound, until it is let go
let game = null, tracker = null, best = store.get('bb-runner-best') ?? 0;
const keys = new Set();             // keyboard, the fallback
const tapped = new Set();           // keys pressed since the last frame, so a tap shorter than one frame still counts

function setPrompt(p, d = '') { $('#prompt').textContent = p; $('#detail').textContent = d; }

function pad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  if (padIndex !== null && pads[padIndex]) return pads[padIndex];
  // the first pad with something held is the board
  for (const p of pads) if (p && controlsDown(p, restOf(p)).size) return adopt(p);
  return null;
}
function adopt(p) {
  padIndex = p.index; padId = p.id; rest = restOf(p); standard = p.mapping === 'standard';
  const kind = padKind(p);
  $('#pad').textContent = `${p.id} · ${kind === 'frc' ? 'frc mode' : kind === 'xinput' ? 'xinput mode' : 'gamepad'}`;
  bind = store.get(`bb-runner-bind:${padId}`);
  $('#rebind').hidden = false;
  return p;
}
window.addEventListener('gamepaddisconnected', (e) => {
  if (e.gamepad.index !== padIndex) return;
  padIndex = null;
  $('#pad').textContent = 'The board went away. Plug it back in and press a key.';
});

function startBinding() { bind = null; pending = null; phase = 'bindJump'; setPrompt('Press the key on the board you want for JUMP'); }
$('#rebind').addEventListener('click', (e) => { e.currentTarget.blur(); startBinding(); });

function startGame() {
  game = newGame(); tracker = repeatTracker(); phase = 'play';
  game.runner.wasJump = true;       // the press that started the run is not a jump
  setPrompt('', '');
  $('#report').hidden = true;
}

function endGame() {
  phase = 'over';
  if (game.score > best) { best = game.score; store.set('bb-runner-best', best); }
  setPrompt(`Score ${game.score}. Press JUMP to run again`, `Best ${best}`);
  const rows = [
    ['Score', game.score], ['Time', `${game.t.toFixed(1)} s`], ['Top speed', `${Math.round(game.speed)} px/s`],
    ['Jumps', game.jumps], ['Ducks', game.ducks], ['Board key presses read', tracker.presses],
    ['Fast repeats', tracker.repeats ? `${tracker.repeats} (${[...tracker.byControl].map(([id, n]) => `${controlName(id, standard)} ×${n}`).join(', ')})` : '0'],
    ['Quickest press to press', Number.isFinite(tracker.fastest) ? `${Math.round(tracker.fastest)} ms` : '—'],
  ];
  $('#report-table').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  $('#report').hidden = false;
}

// What is held this frame, from the board and the keyboard together.
function readInput(now) {
  const p = pad();
  const held = p ? controlsDown(p, rest) : new Set();
  if (phase === 'wait' && p) { phase = bind ? 'ready' : 'bindJump'; if (bind) readyPrompt(); else startBinding(); }
  $('#held').innerHTML = [...held].map((id) => `<span class="chip down">${controlName(id, standard)}</span>`).join('');

  if (phase === 'bindJump' || phase === 'bindDuck') {
    if (pending) { if (!held.has(pending)) advanceBinding(); }
    else if (held.size) {
      const id = [...held][0];
      if (phase === 'bindDuck' && id === bind.jump) setPrompt('That one is JUMP. Press a different key for DUCK');
      else { pending = id; if (phase === 'bindJump') bind = { jump: id }; else bind.duck = id; }
    }
    tapped.clear();
    return null;
  }
  if (phase === 'play' && tracker) tracker.update(held, now);
  const k = (n) => keys.has(n) || tapped.has(n);
  const kJump = k(' ') || k('ArrowUp'), kDuck = k('ArrowDown');
  tapped.clear();
  return { jump: kJump || (bind && held.has(bind.jump)), duck: kDuck || (bind && held.has(bind.duck)) };
}
function advanceBinding() {
  pending = null;
  if (phase === 'bindJump') { phase = 'bindDuck'; setPrompt(`JUMP is ${controlName(bind.jump, standard)}. Now press the key for DUCK`); }
  else { store.set(`bb-runner-bind:${padId}`, bind); phase = 'ready'; readyPrompt(); }
}
function readyPrompt() {
  setPrompt('Press JUMP to start', bind ? `JUMP is ${controlName(bind.jump, standard)}, DUCK is ${controlName(bind.duck, standard)}` : '');
}

window.addEventListener('keydown', (e) => {
  if ([' ', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
  keys.add(e.key); tapped.add(e.key);
  if (phase === 'wait') { phase = 'ready'; setPrompt('Press JUMP to start', 'Space or ↑ jumps, ↓ ducks'); }
});
window.addEventListener('keyup', (e) => keys.delete(e.key));
window.addEventListener('blur', () => keys.clear());

// ---- loop: fixed 1/120 s steps, drawn every frame -----------------------

const DT = 1 / 120;
let acc = 0, last = performance.now(), jumpWas = false;
function frame(now) {
  const inp = readInput(now);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (inp) {
    const edge = inp.jump && !jumpWas; jumpWas = !!inp.jump;
    if ((phase === 'ready' || phase === 'over') && edge) startGame();
    if (phase === 'play') {
      for (acc += dt; acc >= DT; acc -= DT) { step(game, DT, inp); if (game.over) { endGame(); acc = 0; break; } }
    }
  }
  draw();
  requestAnimationFrame(frame);
}

// ---- drawing --------------------------------------------------------------

function fit() {
  const r = window.devicePixelRatio || 1;
  cv.width = W * r; cv.height = H * r;
  ctx.setTransform(r, 0, 0, r, 0, 0);
}
window.addEventListener('resize', fit);

function rr(x, y, w, h, rad) { ctx.beginPath(); ctx.roundRect(x, y, w, h, rad); }

function draw() {
  ctx.clearRect(0, 0, W, H);
  const g = game;
  // ground, with marks that move so speed reads even with nothing coming
  ctx.fillStyle = C.rule; ctx.fillRect(0, GROUND, W, 2);
  const off = g ? g.dist % 40 : 0;
  ctx.fillStyle = C.muted;
  for (let x = -off; x < W; x += 40) ctx.fillRect(x, GROUND + 10, 12, 1);

  if (g) {
    for (const o of g.obs) {
      if (o.kind === 'key') {                       // a keycap
        ctx.fillStyle = C.ink; rr(o.x, o.y0, o.w, o.y1 - o.y0, 4); ctx.fill();
        ctx.fillStyle = C.muted; rr(o.x + 4, o.y0 + 3, o.w - 8, Math.min(14, o.y1 - o.y0 - 8), 3); ctx.fill();
      } else {                                      // a bar to duck under
        ctx.fillStyle = C.ink; ctx.fillRect(o.x, o.y0, o.w, o.y1 - o.y0);
        ctx.fillStyle = C.accent;
        for (let y = o.y1 - 8; y > o.y0; y -= 16) ctx.fillRect(o.x, y, o.w, 4);
      }
    }
  }
  const r = g ? g.runner : { x: 80, h: 0, duck: false };
  const b = runnerBox(r);
  ctx.fillStyle = g?.over ? C.muted : C.accent;
  rr(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 6); ctx.fill();
  ctx.fillStyle = C.surface; ctx.fillRect(b.x1 - 11, b.y0 + 7, 5, 5);   // eye

  ctx.fillStyle = C.ink; ctx.font = '600 16px ui-monospace, Menlo, monospace'; ctx.textAlign = 'right';
  ctx.fillText(String(g ? g.score : 0).padStart(5, '0'), W - 16, 28);
  ctx.fillStyle = C.muted; ctx.fillText(`best ${String(best).padStart(5, '0')}`, W - 16, 48);
}

fit();
if (!navigator.getGamepads) setPrompt('This browser has no Gamepad API', 'Space or ↑ jumps, ↓ ducks.');
requestAnimationFrame(frame);
