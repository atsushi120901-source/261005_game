import { DIFF } from '../world/openTerrain.js';

// Trail map of the open mountain: shaded relief, forests, colour-coded routes,
// lifts and buildings, drawn once; the riders are drawn on top every few frames.
// Oriented "heading up": the fall line points up the screen, so the rider's
// left and right match the map.
const U0 = -470, U1 = 470, S0 = -30;
const SCALE = 5; // metres per base pixel

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.base = null;
    this.timer = 0;
    this.visible = true;
  }

  setTrack(track) {
    this.track = track;
    this.base = null;
    this.canvas.classList.toggle('on', !!track.open && this.visible);
    if (!track.open) return;
    const S1 = track.finishS + 70;
    this.S1 = S1;
    const W = Math.round((U1 - U0) / SCALE), H = Math.round((S1 - S0) / SCALE);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    // forest density per pixel
    const dens = new Float32Array(W * H);
    for (const t of track.trees) {
      const x = Math.floor((t.u - U0) / SCALE), y = Math.floor((S1 - t.s) / SCALE);
      if (x >= 0 && x < W && y >= 0 && y < H) dens[y * W + x] += 1;
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = S1 - (y + 0.5) * SCALE, u = U0 + (x + 0.5) * SCALE;
        const h = track.ground(s, u);
        const gs = (track.ground(s + SCALE, u) - track.ground(s - SCALE, u)) / (2 * SCALE);
        const gu = (track.ground(s, u + SCALE) - track.ground(s, u - SCALE)) / (2 * SCALE);
        // light from the upper left of the map
        const shade = Math.max(0.55, Math.min(1.08, 0.92 - gu * 0.55 - gs * 0.35));
        let r = 222 * shade, g = 232 * shade, b = 246 * shade;
        const steep = Math.hypot(gs, gu);
        if (steep > 1.1) { r = 120 * shade; g = 124 * shade; b = 132 * shade; }
        // forests: blurred tree density
        let acc = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) acc += dens[(y + dy) * W + x + dx] || 0;
        const d = Math.min(0.62, acc * 0.11);
        r = r * (1 - d) + 38 * d; g = g * (1 - d) + 78 * d; b = b * (1 - d) + 66 * d;
        void h;
        const i = (y * W + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const X = (u) => (u - U0) / SCALE, Y = (s) => (S1 - s) / SCALE;
    // routes: soft corridor + centre line in the route colour
    for (const r of track.routes) {
      const col = '#' + r.color.toString(16).padStart(6, '0');
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const pass of [0, 1]) {
        ctx.beginPath();
        for (let s = r.s0 + 30; s <= r.s1 - 20; s += 10) {
          const c2 = r.at(s, {});
          if (s === r.s0 + 30) ctx.moveTo(X(c2.u), Y(s)); else ctx.lineTo(X(c2.u), Y(s));
        }
        ctx.strokeStyle = pass ? col : col + '44';
        ctx.lineWidth = pass ? 2.6 : 10;
        ctx.stroke();
      }
    }
    // lifts
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.2;
    for (const L of track.lifts) {
      ctx.beginPath();
      ctx.moveTo(X(L.a.u), Y(L.a.s));
      ctx.lineTo(X(L.b.u), Y(L.b.s));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // buildings
    ctx.fillStyle = '#6b4a32';
    for (const b of track.buildings) ctx.fillRect(X(b.u) - 1.5, Y(b.s) - 1.5, 3, 3);
    // start and finish
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(X(-420), Y(track.finishS) - 1, X(420) - X(-420), 2);
    ctx.fillStyle = '#2de2ff';
    ctx.fillRect(X(-14), Y(26) - 1, X(14) - X(-14), 2);
    this.base = c;
    this.X = X;
    this.Y = Y;
    // fit the canvas to the map's aspect ratio
    this.canvas.width = W;
    this.canvas.height = H;
    this.canvas.style.aspectRatio = `${W} / ${H}`;
  }

  toggle() {
    this.visible = !this.visible;
    this.canvas.classList.toggle('on', !!this.base && this.visible);
    return this.visible;
  }

  update(dt, game) {
    if (!this.base || !this.visible) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / 20;
    const ctx = this.ctx, k = 1;
    const cw = this.canvas.width, ch = this.canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.globalAlpha = 0.92;
    ctx.drawImage(this.base, 0, 0, cw, ch);
    ctx.globalAlpha = 1;
    for (const n of game.npcs || []) {
      if (n.s === undefined) continue;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(this.X(n.u) * k, this.Y(n.s) * k, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const r = game.rider;
    const x = this.X(r.u) * k, y = this.Y(r.s) * k;
    const a = r.groundSpeed > 0.5 ? Math.atan2(r.vu, r.vs) : 0;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = '#ff2d6a';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(8, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function zoneLabel(z) {
  const d = z.diff ? DIFF[z.diff].mark + ' ' : '';
  return `${d}${z.name}`;
}
