// Keyboard + gamepad + touch input, merged into one state object.
import { damp } from './utils.js';

const GRAB_KEYS = { KeyJ: 'indy', ShiftLeft: 'indy', ShiftRight: 'indy', KeyK: 'method', KeyL: 'nose', KeyI: 'tail', KeyU: 'tail' };

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();
    this.state = { steer: 0, up: false, down: false, jump: false, grab: null };
    this.touch = { steer: 0, up: false, down: false, jump: false, grab: null, active: false };
    this.prevPad = {};
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // Edge-triggered actions consumed once per frame.
  was(...codes) {
    return codes.some((c) => this.pressed.has(c));
  }

  update(dt) {
    const k = this.keys;
    let steer = 0;
    if (k.has('ArrowLeft') || k.has('KeyA')) steer -= 1;
    if (k.has('ArrowRight') || k.has('KeyD')) steer += 1;
    let up = k.has('ArrowUp') || k.has('KeyW');
    let down = k.has('ArrowDown') || k.has('KeyS');
    let jump = k.has('Space');
    let grab = null;
    for (const code in GRAB_KEYS) if (k.has(code)) { grab = GRAB_KEYS[code]; break; }

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (Math.abs(ax) > 0.18) steer = ax;
      if (ay < -0.5) up = true;
      if (ay > 0.5) down = true;
      const b = (i) => p.buttons[i]?.pressed;
      if (b(12)) up = true;
      if (b(13)) down = true;
      if (b(14)) steer = -1;
      if (b(15)) steer = 1;
      if (b(0)) jump = true;
      if (b(2)) grab = 'indy';
      if (b(1)) grab = 'method';
      if (b(3)) grab = 'nose';
      if (b(4) || b(5) || b(7)) grab = grab || 'tail';
      const edges = { 0: 'PadA', 1: 'PadB', 9: 'PadStart', 12: 'PadUp', 13: 'PadDown', 14: 'PadLeft', 15: 'PadRight' };
      for (const i in edges) {
        const now = !!b(+i);
        if (now && !this.prevPad[i]) this.pressed.add(edges[i]);
        this.prevPad[i] = now;
      }
      // stick as menu navigation
      const sx = ax > 0.6 ? 1 : ax < -0.6 ? -1 : 0;
      if (sx && sx !== this.prevPad.sx) this.pressed.add(sx > 0 ? 'PadRight' : 'PadLeft');
      this.prevPad.sx = sx;
      break;
    }

    // touch
    const t = this.touch;
    if (t.active) {
      if (Math.abs(t.steer) > 0.1) steer = t.steer;
      up = up || t.up;
      down = down || t.down;
      jump = jump || t.jump;
      grab = grab || t.grab;
    }

    const s = this.state;
    // keyboard steering eases in for smooth carves; analog passes straight through
    s.steer = Math.abs(steer) < 1 && steer !== 0 ? steer : damp(s.steer, steer, 9, dt);
    s.up = up;
    s.down = down;
    s.jump = jump;
    s.grab = grab;
    return s;
  }

  endFrame() {
    this.pressed.clear();
  }
}
