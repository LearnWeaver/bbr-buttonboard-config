// Tile Runner, the key test game (game.html): the rules and the input reading,
// no DOM, so node can test them (tools/test_web.mjs).
//
// The board is read through the browser's Gamepad API, not the config channel,
// so the game sees exactly what the Driver Station sees, in either USB
// personality (PROTOCOL.md §8.3). Under `frc` the board is a 32-button HID
// gamepad and button index i is logical button i + 1. Under `xinput` it is an
// Xbox pad with the browser's standard mapping. Neither needs to be known in
// advance: the player binds jump and duck by pressing them, and a control is a
// button index or an axis direction, whatever the key drives.

export const W = 800, H = 240, GROUND = 200;
export const RUN_W = 34, RUN_H = 44, DUCK_H = 24;
const GRAVITY = 2600, JUMP_V = 900;        // a jump 156 px high, 0.69 s in the air
const FAST_FALL = 3;                       // gravity while ducking in the air
const JUMP_CUT = 0.45;                     // vy kept when jump is let go on the way up
const BUFFER_S = 0.12;                     // a jump pressed this soon before landing still counts
const SPEED_0 = 320, SPEED_MAX = 900, ACCEL = 9;   // px/s, px/s per second
const BAR_AFTER = 400;                     // score before the duck bars start
const SLACK = 4;                           // px forgiven on each side of the runner

// A small seeded generator, so a test can replay a run.
export function rng(seed = Date.now()) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newGame(rand = rng()) {
  return { rand, t: 0, speed: SPEED_0, dist: 0, score: 0, over: false, next: 500,
           runner: { x: 80, h: 0, vy: 0, duck: false, buffer: 0, wasJump: false },
           obs: [], jumps: 0, ducks: 0 };
}

// The runner's box, in canvas coordinates (y down).
export function runnerBox(r) {
  const tall = r.duck && r.h === 0 ? DUCK_H : RUN_H, wide = r.duck && r.h === 0 ? RUN_W + 10 : RUN_W;
  return { x0: r.x, x1: r.x + wide, y0: GROUND - r.h - tall, y1: GROUND - r.h };
}

// Ground blocks are jumped; bars hang from the top down to just above a
// ducking runner's head, so they cannot be jumped and have to be ducked.
function spawn(g) {
  const bars = g.score >= BAR_AFTER && g.rand() < 0.3;
  if (bars) {
    g.obs.push({ kind: 'bar', x: W, w: 40 + g.rand() * 30, y0: 0, y1: GROUND - DUCK_H - 10 });
  } else {
    const n = g.score > 250 && g.rand() < 0.35 ? 2 : 1;      // a pair of keycaps later on
    const w = 26 + g.rand() * 10, h = 28 + g.rand() * 22;
    for (let i = 0; i < n; i++) g.obs.push({ kind: 'key', x: W + i * (w + 4), w, y0: GROUND - h, y1: GROUND });
  }
  // room to land and jump again: the time in the air at this speed, plus a random stretch
  g.next = g.speed * (0.75 + g.rand() * 0.8) + 120;
}

// One step of dt seconds. inp: { jump, duck } held this step.
export function step(g, dt, inp) {
  if (g.over) return g;
  const r = g.runner;
  g.t += dt;
  g.speed = Math.min(SPEED_MAX, g.speed + ACCEL * dt);
  g.dist += g.speed * dt;
  g.score = Math.floor(g.dist / 10);

  const pressed = inp.jump && !r.wasJump;
  r.wasJump = !!inp.jump;
  if (pressed) { r.buffer = BUFFER_S; g.jumps++; }
  else r.buffer = Math.max(0, r.buffer - dt);
  if (inp.duck && !r.duck) g.ducks++;
  r.duck = !!inp.duck;

  if (r.h === 0 && r.buffer > 0 && !r.duck) { r.vy = JUMP_V; r.buffer = 0; }
  if (r.h > 0 || r.vy > 0) {
    if (!inp.jump && r.vy > 0) r.vy *= JUMP_CUT ** (dt * 30);  // a short tap is a short hop
    r.vy -= GRAVITY * (r.duck ? FAST_FALL : 1) * dt;
    r.h = Math.max(0, r.h + r.vy * dt);
    if (r.h === 0) r.vy = 0;
  }

  for (const o of g.obs) o.x -= g.speed * dt;
  g.obs = g.obs.filter((o) => o.x + o.w > -10);
  g.next -= g.speed * dt;
  if (g.next <= 0) spawn(g);

  const b = runnerBox(r);
  for (const o of g.obs)
    if (b.x1 - SLACK > o.x && b.x0 + SLACK < o.x + o.w && b.y1 - SLACK > o.y0 && b.y0 + SLACK < o.y1) g.over = true;
  return g;
}

// ---- input --------------------------------------------------------------

const AXIS_ON = 0.5;

// What a pad's axes read at rest, so an axis that idles away from 0 (some
// drivers park triggers at -1) is not read as held.
export const restOf = (pad) => Array.from(pad.axes, (v) => (Math.abs(v) > 0.9 ? Math.sign(v) : 0));

// Every control held on a pad: "b<i>" for a button, "a<i>+" / "a<i>-" for an
// axis pushed past half from rest.
export function controlsDown(pad, rest = []) {
  const ids = new Set();
  pad.buttons.forEach((b, i) => { if (b.pressed || b.value > AXIS_ON) ids.add(`b${i}`); });
  pad.axes.forEach((v, i) => {
    const d = v - (rest[i] ?? 0);
    if (d > AXIS_ON) ids.add(`a${i}+`); else if (d < -AXIS_ON) ids.add(`a${i}-`);
  });
  return ids;
}

// The browser's standard mapping, which is what an xinput board gets.
const STANDARD = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3',
                  'D-up', 'D-down', 'D-left', 'D-right', 'Guide'];
const STANDARD_AXES = ['left stick X', 'left stick Y', 'right stick X', 'right stick Y'];

// A control as the player knows it. Under `frc` button i is logical button
// i + 1, the number the config app binds.
export function controlName(id, standard) {
  const m = /^([ba])(\d+)([+-]?)$/.exec(id);
  if (!m) return id;
  const i = +m[2];
  if (m[1] === 'b') return standard ? (STANDARD[i] ?? `button ${i}`) : `button ${i + 1}`;
  const axis = standard ? (STANDARD_AXES[i] ?? `axis ${i}`) : `axis ${i + 1}`;
  return `${axis} ${m[3] === '+' ? '+' : '−'}`;
}

// Which personality a pad looks like, from the id string the browser gives.
export function padKind(pad) {
  const id = pad.id.toLowerCase();
  if (/xbox|xinput|045e/.test(id)) return 'xinput';
  if (/bbr|button board/.test(id)) return 'frc';
  return pad.mapping === 'standard' ? 'standard' : 'other';
}

// Press-to-press gaps per control. Nobody presses one key twice inside
// REPEAT_MS on purpose, so a pair that close is the switch bouncing past its
// debounce, or a contact dropping out for a moment.
export const REPEAT_MS = 60;
export function repeatTracker() {
  const last = new Map(), down = new Set();
  const out = { presses: 0, repeats: 0, fastest: Infinity, byControl: new Map() };
  out.update = (held, now) => {
    for (const id of held) if (!down.has(id)) {
      out.presses++;
      const p = last.get(id);
      if (p !== undefined && now - p < REPEAT_MS) {
        out.repeats++;
        out.byControl.set(id, (out.byControl.get(id) ?? 0) + 1);
      }
      if (p !== undefined) out.fastest = Math.min(out.fastest, now - p);
      last.set(id, now);
    }
    down.clear();
    for (const id of held) down.add(id);
  };
  return out;
}
