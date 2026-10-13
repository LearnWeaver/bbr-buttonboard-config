// The logical-button → XInput slot table of §8.5, and the same 24 buttons
// drawn where they sit on an Xbox pad.
//
// The map stays in logical buttons 1–32 (§8.5), so the number grid is the
// truth and this is a second way in to it: someone laying out an FTC board
// thinks "this key is A", not "this key is 1". Both views carry the same
// data-* attribute, so a screen's one click handler serves both and they can
// never disagree about what is selected.

export const XINPUT_SLOTS = ['A','B','X','Y','LB','RB','Back','Start','L3','R3','D-up','D-down','D-left','D-right','LT','RT','LX−','LX+','LY−','LY+','RX−','RX+','RY−','RY+'];

export const slotOf = (n) => XINPUT_SLOTS[n - 1];

// The slot name small enough to sit under a number in the 1–32 grid.
const TINY = { 11: 'D↑', 12: 'D↓', 13: 'D←', 14: 'D→' };
export const tinySlot = (n) => TINY[n] ?? slotOf(n);

// Where each logical button sits, as a centre in percent of the pad's box.
// Sticks are drawn as a cross of four directions around their click, which is
// what they are to the map: a key drives an axis to one end (§8.5).
// XInput's Y axis is positive UP (unlike the FTC SDK's left_stick_y, which
// negates it), so LY+ is the upper cell.
const STICK = (cx, cy, neg_x, pos_x, neg_y, pos_y, click) => [
  [click, cx, cy], [pos_y, cx, cy - 13], [neg_y, cx, cy + 13], [neg_x, cx - 9, cy], [pos_x, cx + 9, cy],
];
const CROSS = (cx, cy, up, down, left, right) => [
  [up, cx, cy - 13], [down, cx, cy + 13], [left, cx - 9, cy], [right, cx + 9, cy],
];
const PLACES = [
  [15, 13, 7], [16, 87, 7],                 // LT RT
  [5, 13, 19], [6, 87, 19],                 // LB RB
  ...STICK(22, 45, 17, 18, 19, 20, 9),      // left stick, L3
  [7, 43, 33], [8, 57, 33],                 // Back Start
  ...CROSS(78, 45, 4, 1, 3, 2),             // Y A X B
  ...CROSS(36, 79, 11, 12, 13, 14),         // D-pad
  ...STICK(64, 79, 21, 22, 23, 24, 10),     // right stick, R3
];

// Short names for the cells, which are too small for "D-left".
const SHORT = { 11: '↑', 12: '↓', 13: '←', 14: '→', 17: '←', 18: '→', 19: '↓', 20: '↑',
                21: '←', 22: '→', 23: '↓', 24: '↑' };

/**
 * The pad as HTML. `attr` names the data attribute a click reads (`btn` on
 * Configure, `hold` on Diagnose); `cls(n)` returns extra classes for a cell
 * (`sel`, `used`, `down`) and `title(n)` its tooltip.
 */
export function padView({ attr, cls = () => '', title = (n) => `${n} · ${slotOf(n)}` }) {
  return `<div class="xpad" role="group" aria-label="Xbox controller layout">
    <svg class="xpad-body" viewBox="0 0 100 64" preserveAspectRatio="none" aria-hidden="true">
      <path d="M22 8 H78 C92 8 98 22 99 40 C100 56 92 63 84 60 C76 57 72 50 64 50 H36
               C28 50 24 57 16 60 C8 63 0 56 1 40 C2 22 8 8 22 8 Z"/>
    </svg>
    <span class="xpad-ring" style="left:22%;top:45%"></span>
    <span class="xpad-ring" style="left:64%;top:79%"></span>
    ${PLACES.map(([n, x, y]) => `<button class="xcell ${[9, 10].includes(n) ? 'click' : ''} ${cls(n)}"
        data-${attr}="${n}" title="${title(n)}" style="left:${x}%;top:${y}%">${SHORT[n] ?? slotOf(n)}</button>`).join('')}
  </div>`;
}
