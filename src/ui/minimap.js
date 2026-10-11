import { DIFF } from '../world/openTerrain.js';

// Trail map of an open world: shaded relief, forests, colour-coded routes,
// lifts, building footprints, water and ice, drawn once; the riders are drawn
// on top every few frames. Oriented "heading up": the fall line points up the
// screen, so the rider's left and right match the map.
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
    const B = track.mapBounds || { u0: -470, u1: 470, s0: -30, s1: track.finishS + 70 };
    const U0 = B.u0, U1 = B.u1, S0 = B.s0, S1 = B.s1;
    const SCALE = track.city ? 3 : 5; // metres per base pixel
    const W = Math.round((U1 - U0) / SCALE), H = Math.round((S1 - S0) / SCALE);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    // forest density per pixel
    const dens = new Float32Array(W * H);
    const treeW = track.city ? 0.05 : 0.11;
    for (const t of track.trees) {
      const x = Math.floor((t.u - U0) / SCALE), y = Math.floor((S1 - t.s) / SCALE);
      if (x >= 0 && x < W && y >= 0 && y < H) dens[y * W + x] += 1;
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = S1 - (y + 0.5) * SCALE, u = U0 + (x + 0.5) * SCALE;
        const gs = (track.ground(s + SCALE, u) - track.ground(s - SCALE, u)) / (2 * SCALE);
        const gu = (track.ground(s, u + SCALE) - track.ground(s, u - SCALE)) / (2 * SCALE);
        // light from the upper left of the map
        const shade = Math.max(0.55, Math.min(1.08, 0.92 - gu * 0.55 - gs * 0.35));
        let r = 222 * shade, g = 232 * shade, b = 246 * shade;
        const steep = Math.hypot(gs, gu);
        if (steep > 1.1) { r = 120 * shade; g = 124 * shade; b = 132 * shade; }
        // water: canals and rivers cut into the ground
        if (track.city && track.ground(s, u) < track.baseY(s) - 1.2) { r = 70; g = 120; b = 168; }
        // forests: blurred tree density
        let acc = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) acc += dens[(y + dy) * W + x + dx] || 0;
        const d = Math.min(0.62, acc * treeW);
        r = r * (1 - d) + 38 * d; g = g * (1 - d) + 78 * d; b = b * (1 - d) + 66 * d;
        const i = (y * W + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const X = (u) => (u - U0) / SCALE, Y = (s) => (S1 - s) / SCALE;
    // ice (frozen ponds, rivers, canals)
    ctx.fillStyle = 'rgba(150, 215, 245, 0.75)';
    for (const a of track.iceAreas || []) {
      if (a.r) { ctx.beginPath(); ctx.arc(X(a.u), Y(a.s), a.r / SCALE, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(X(Math.max(a.u0, U0)), Y(a.s1), (Math.min(a.u1, U1) - Math.max(a.u0, U0)) / SCALE, (a.s1 - a.s0) / SCALE);
    }
    // city streets: cross streets as plain bands under the coloured routes
    if (track.city) {
      ctx.fillStyle = 'rgba(150, 160, 178, 0.55)';
      for (const cs of track.cross || []) {
        const u0 = Math.max(cs.u0 ?? U0, U0), u1 = Math.min(cs.u1 ?? U1, U1);
        ctx.fillRect(X(u0), Y(cs.s + cs.hw), (u1 - u0) / SCALE, (cs.hw * 2) / SCALE);
      }
    }
    // routes: soft corridor + centre line in the route colour
    for (const r of track.routes) {
      const col = '#' + r.color.toString(16).padStart(6, '0');
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const sa = Math.max(r.s0 + (track.city ? 0 : 30), S0), sb = Math.min(r.s1 - (track.city ? 0 : 20), S1);
      for (const pass of [0, 1]) {
        ctx.beginPath();
        for (let s = sa; s <= sb; s += 10) {
          const c2 = r.at(s, {});
          if (s === sa) ctx.moveTo(X(c2.u), Y(s)); else ctx.lineTo(X(c2.u), Y(s));
        }
        ctx.strokeStyle = pass ? col : col + '44';
        ctx.lineWidth = pass ? 2.6 : (track.city ? Math.max(4, (r.pts?.[0]?.[2] ?? 6) * 2 / SCALE) : 10);
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
    // buildings: footprints
    ctx.fillStyle = track.city ? '#3d4658' : '#6b4a32';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 0.6;
    for (const b of track.buildings) {
      const s0 = b.s0 ?? b.s - b.w / 2, s1 = b.s1 ?? b.s + b.w / 2;
      const u0 = b.u0 ?? b.u - b.d / 2, u1 = b.u1 ?? b.u + b.d / 2;
      const w = Math.max(2, (u1 - u0) / SCALE), h = Math.max(2, (s1 - s0) / SCALE);
      const x = (X(u0) + X(u1)) / 2 - w / 2, y = (Y(s0) + Y(s1)) / 2 - h / 2;
      ctx.fillRect(x, y, w, h);
      if (track.city) ctx.strokeRect(x, y, w, h);
    }
    // start and finish
    const G = track.gates || { start: { s: 26, u: 0, half: 14 }, finish: { s: track.finishS, u: 0, half: 420 } };
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(X(G.finish.u - G.finish.half), Y(G.finish.s) - 1.5, (G.finish.half * 2) / SCALE, 3);
    ctx.fillStyle = '#2de2ff';
    ctx.fillRect(X(G.start.u - G.start.half), Y(G.start.s) - 1.5, (G.start.half * 2) / SCALE, 3);
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
