import * as THREE from 'three';
import { clamp, smoothstep } from '../core/utils.js';

// Shared core of every open-world stage. It keeps the Track interface the rider,
// camera and effects expect (s = distance down the fall line, u = lateral, y
// absolute) with a straight frame: world x = u, world z = -s.
//
// The ground is a heightfield on a regular grid (piecewise planar, matching the
// rendered LOD0 mesh exactly). On top of it sit analytic features (kickers,
// cliffs, roofs, decks ...) found through a 2D bucket grid, round obstacles
// (trees, posts, rocks) that make you crash, grind rails, collectible tokens and
// named routes / areas for the HUD and the trail map.
//
// Subclasses provide: _gradeAt(s) (fall-line profile), _terrain(s, u, row)
// (raw height) with an optional _rowPrep(s), _layout() and _scatter().

export const BK = 16; // feature bucket size (m)
export const OB = 8; // obstacle bucket size (m)

// Piste difficulty marks
export const DIFF = { easy: { mark: '●', color: 0x2fb45a }, mid: { mark: '■', color: 0x2a7dff }, hard: { mark: '◆', color: 0x15161a } };

export const lateralFall = (u, u0, w, fall) => {
  const d = Math.abs(u - u0) - w / 2;
  if (d <= 0) return 1;
  if (d >= fall) return 0;
  const t = 1 - d / fall;
  return t * t * (3 - 2 * t);
};

function hermite(p0, p1, m0, m1, t) {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}

// A named corridor down the slope: control points [s, u, halfWidth, depth].
export class Route {
  constructor(def, index) {
    Object.assign(this, def);
    this.index = index;
    this.s0 = def.pts[0][0];
    this.s1 = def.pts[def.pts.length - 1][0];
    this.fadeLen = def.fadeLen ?? 70;
  }
  // centre, half width, depth and fade at s (null outside the route)
  at(s, out = {}) {
    const P = this.pts;
    if (s < this.s0 || s > this.s1) return null;
    let i = 0;
    while (i < P.length - 2 && P[i + 1][0] < s) i++;
    const a = P[i], b = P[i + 1];
    const h = b[0] - a[0];
    const t = (s - a[0]) / h;
    const pa = P[Math.max(0, i - 1)], pb = P[Math.min(P.length - 1, i + 2)];
    for (let k = 1; k < 4; k++) {
      let v;
      if (this.linear) v = a[k] + (b[k] - a[k]) * t;
      else {
        const m0 = ((b[k] - pa[k]) / (b[0] - pa[0] || 1)) * h;
        const m1 = ((pb[k] - a[k]) / (pb[0] - a[0] || 1)) * h;
        v = hermite(a[k], b[k], i === 0 ? (b[k] - a[k]) : m0, i === P.length - 2 ? (b[k] - a[k]) : m1, t);
      }
      if (k === 1) out.u = v; else if (k === 2) out.w = v; else out.d = v;
    }
    out.fade = this.fadeLen > 0 ? smoothstep(this.s0, this.s0 + this.fadeLen, s) * (1 - smoothstep(this.s1 - this.fadeLen, this.s1, s)) : 1;
    return out;
  }
  centre(s) {
    return this.at(clamp(s, this.s0, this.s1), {}).u;
  }
}

export class OpenWorldTerrain {
  constructor(stage, cfg) {
    this.stage = stage;
    this.open = true;
    this.banks = false;
    this.cfg = cfg;
    this.CELL = cfg.cell ?? 2;
    this.S_MIN = cfg.sMin;
    this.S_MAX = cfg.sMax;
    this.U_HALF = cfg.uHalf;
    this.NS = Math.round((this.S_MAX - this.S_MIN) / this.CELL) + 1;
    this.NU = Math.round((2 * this.U_HALF) / this.CELL) + 1;
    this.drops = [];
    this.routes = [];
    this.areas = [];
    this.halfpipes = [];
    this.iceAreas = [];
    // compatibility with the street track (a straight "centre line")
    this.n = 2;
    this.px = new Float32Array([0, 0]);
    this.pz = new Float32Array([0, -1000]);
    // feature / obstacle registries
    this.features = [];
    this.bucket = new Map();
    this.obst = new Map();
    this.rails = [];
    this.tokens = [];
    this.cars = [];
    this.kickers = [];
    this.buildings = [];
    this.signs = [];
    this.arches = [];
    this.pillows = [];
    this.cliffs = [];
    this.lifts = [];
    this.trees = [];
    this.rocks = [];
    this.lookouts = [];
  }

  // Build everything (call at the end of the subclass constructor).
  init() {
    this.pz[1] = -this.length;
    this._profile();
    this._grid();
    this._layout();
    this._scatter();
    // drop tokens that ended up inside trees, rocks or buildings
    this.tokens = this.tokens.filter((t) => !this.obstacleAt(t.s, t.u, t.y - 1) && this.height(t.s, t.u) < t.y - 0.3);
  }

  // ---------------------------------------------------------------- base profile
  _profile() {
    const n = this.S_MAX - this.S_MIN + 1;
    const B = (this.B = new Float32Array(n));
    let y = 0;
    for (let i = 0; i < n; i++) {
      B[i] = y;
      y -= this._gradeAt(this.S_MIN + i);
    }
    // re-centre so the start sits near y = 0
    const y0 = B[Math.round(this.spawn.s) - this.S_MIN];
    for (let i = 0; i < n; i++) B[i] -= y0;
  }
  baseY(s) {
    const f = clamp(s - this.S_MIN, 0, this.S_MAX - this.S_MIN - 1.001);
    const i = Math.floor(f);
    return this.B[i] + (this.B[i + 1] - this.B[i]) * (f - i);
  }
  baseSlope(s) {
    return this.baseY(s + 0.5) - this.baseY(s - 0.5);
  }

  _grid() {
    const { NS, NU, CELL, S_MIN, U_HALF } = this;
    const G = (this.G = new Float32Array(NS * NU));
    for (let i = 0; i < NS; i++) {
      const s = S_MIN + i * CELL;
      const row = this._rowPrep ? this._rowPrep(s) : null;
      for (let j = 0; j < NU; j++) G[i * NU + j] = this._terrain(s, -U_HALF + j * CELL, row);
    }
  }

  // Piecewise planar ground (same triangulation as the LOD0 terrain mesh).
  ground(s, u) {
    const NS = this.NS, NU = this.NU, CELL = this.CELL;
    let fs = (s - this.S_MIN) / CELL, fu = (u + this.U_HALF) / CELL;
    fs = fs < 0 ? 0 : fs > NS - 1.0001 ? NS - 1.0001 : fs;
    fu = fu < 0 ? 0 : fu > NU - 1.0001 ? NU - 1.0001 : fu;
    const i = Math.floor(fs), j = Math.floor(fu);
    const a = fs - i, b = fu - j;
    const G = this.G, o = i * NU + j;
    const h00 = G[o], h11 = G[o + NU + 1];
    if (a >= b) return h00 + a * (G[o + NU] - h00) + b * (h11 - G[o + NU]);
    return h00 + b * (G[o + 1] - h00) + a * (h11 - G[o + 1]);
  }
  gridInfo() {
    return { NS: this.NS, NU: this.NU, CELL: this.CELL, S_MIN: this.S_MIN, U_HALF: this.U_HALF, G: this.G };
  }

  // ---------------------------------------------------------------- frames (straight)
  frame(s, out = {}) {
    out.x = 0; out.z = -s; out.y = this.baseY(s);
    out.tx = 0; out.tz = -1; out.rx = 1; out.rz = 0;
    return out;
  }
  toWorld(s, u, y, out = new THREE.Vector3()) {
    return out.set(u, y, -s);
  }
  yawAt() {
    return 0;
  }
  matrixAt(s, u, y, extraYaw = 0, scale = 1, out = new THREE.Matrix4()) {
    _q.setFromAxisAngle(_up, extraYaw);
    return out.compose(_v.set(u, y, -s), _q, _sc.set(scale, scale, scale));
  }
  lateral() {
    return 0;
  }
  lateralSlope() {
    return 0;
  }

  // ---------------------------------------------------------------- surface
  // Surface height. `y` (optional) is the height of whoever asks: decks you
  // are underneath (bridges, the skyway) are ignored so you can pass below.
  height(s, u, solid = true, y) {
    const g = this.ground(s, u);
    const list = this.bucket.get(bkey(s, u));
    if (!list) return g;
    let best = g;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!solid && f.solid) continue;
      const v = f.abs ? f.fn(s, u) : g + f.fn(s, u);
      if (v > best) {
        if (f.under && y !== undefined && y < v - (f.clear ?? 1.2)) continue;
        best = v;
      }
    }
    return best;
  }
  gradient(s, u, out = { gs: 0, gu: 0 }, solid = true, y) {
    const e = 0.12;
    out.gs = (this.height(s + e, u, solid, y) - this.height(s - e, u, solid, y)) / (2 * e);
    out.gu = (this.height(s, u + e, solid, y) - this.height(s, u - e, solid, y)) / (2 * e);
    return out;
  }
  normal(s, u, out = new THREE.Vector3(), solid = true, y) {
    const g = this.gradient(s, u, _g, solid, y);
    // world: x = u, z = -s  ->  n = (-gu, 1, gs)
    return out.set(-g.gu, 1, g.gs).normalize();
  }
  // Surface friction multiplier (ice is slippery).
  friction(s, u) {
    for (const a of this.iceAreas) {
      if (a.r) { if ((s - a.s) ** 2 + (u - a.u) ** 2 < a.r * a.r) return 0.25; }
      else if (s > a.s0 && s < a.s1 && u > a.u0 && u < a.u1) return 0.25;
    }
    return 1;
  }

  // ---------------------------------------------------------------- routes and areas
  // Which route corridor (if any) is at (s,u): { route, x (0 centre .. 1 edge) }
  routeAt(s, u, minFade = 0.3) {
    let best = null;
    for (const r of this.routes) {
      const c = r.at(s, _c);
      if (!c || c.fade < minFade) continue;
      const x = Math.abs(u - c.u) / c.w;
      if (x < 1.05 && (!best || x < best.x)) best = { route: r, x, side: Math.sign(u - c.u), c: c.u, w: c.w };
    }
    return best;
  }
  areaAt(s, u) {
    for (const a of this.areas) {
      if (s < a.s0 || s >= a.s1) continue;
      if (a.u0 !== undefined && (u < a.u0 || u > a.u1)) continue;
      return a;
    }
    return null;
  }
  zoneName(s, u) {
    const a = this.areaAt(s, u);
    if (a && !a.under) return a;
    const r = this.routeAt(s, u);
    if (r) return r.route;
    return a || this.defaultZone || { name: 'BACKCOUNTRY', jp: 'バックカントリー' };
  }
  // Nearest route centre to u at s (used by other riders).
  nearestRoute(s, u) {
    let best = null, bd = 1e9;
    for (const r of this.routes) {
      if (r.noNpc) continue;
      const c = r.at(s, _c);
      if (!c || c.fade < 0.5) continue;
      const d = Math.abs(u - c.u);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  // Halfpipe walls send the rider straight up and back in.
  wallLip(s, u, vu) {
    for (const h of this.halfpipes) {
      if (s < h.s0 - 20 || s > h.s1 + 20) continue;
      const c = h.route.at(clamp(s, h.route.s0, h.route.s1), _c);
      if (!c) continue;
      const x = (u - c.u) / (h.w ?? c.w);
      if (Math.abs(x) > (h.x0 ?? 0.7) && Math.abs(x) < (h.x1 ?? 1.45) && x * vu > 0) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- obstacles
  addObstacle(o) {
    const r = o.r + 0.4;
    for (let a = Math.floor((o.s - r) / OB); a <= Math.floor((o.s + r) / OB); a++) {
      for (let b = Math.floor((o.u - r) / OB); b <= Math.floor((o.u + r) / OB); b++) {
        const k = a * 4096 + b;
        let l = this.obst.get(k);
        if (!l) this.obst.set(k, (l = []));
        l.push(o);
      }
    }
    return o;
  }
  obstacleAt(s, u, y) {
    const list = this.obst.get(okey(s, u));
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const ds = s - o.s, du = u - o.u;
      if (ds * ds + du * du < o.r * o.r && y < o.top && y > (o.bottom ?? -1e9)) return o;
    }
    return null;
  }
  // How far (0..1) along the line from a to b the camera can go before a wall.
  cameraClear(s0, u0, y0, s1, u1, y1) {
    const n = 10;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const s = s0 + (s1 - s0) * t, u = u0 + (u1 - u0) * t, y = y0 + (y1 - y0) * t;
      if (this.height(s, u) > y - 0.4) return Math.max(0, (i - 1.5) / n);
    }
    return 1;
  }

  // ---------------------------------------------------------------- feature registry
  _addFeature(f, s0, s1, u0, u1) {
    this.features.push(f);
    for (let a = Math.floor(s0 / BK); a <= Math.floor(s1 / BK); a++) {
      for (let b = Math.floor(u0 / BK); b <= Math.floor(u1 / BK); b++) {
        const k = a * 4096 + b;
        let l = this.bucket.get(k);
        if (!l) this.bucket.set(k, (l = []));
        l.push(f);
      }
    }
    return f;
  }
  // Is the footprint free of other features (with margin)?
  _free(s0, s1, u0, u1, m = 3) {
    for (const f of this.features) {
      if (f.bs0 === undefined || f.type === 'roller') continue;
      if (s1 + m > f.bs0 && s0 - m < f.bs1 && u1 + m > f.bu0 && u0 - m < f.bu1) return false;
    }
    return true;
  }
  _reg(f, s0, s1, u0, u1) {
    f.bs0 = s0; f.bs1 = s1; f.bu0 = u0; f.bu1 = u1;
    return this._addFeature(f, s0, s1, u0, u1);
  }

  // ---------------------------------------------------------------- feature kit
  // Features normally sit on the ground; `base` (s,u)->y puts them on a deck instead.
  _onBase(f, base) {
    if (!base) return f;
    const rel = f.fn;
    f.abs = true;
    f.base = base;
    f.under = true;
    f.fn = (s, u) => {
      const v = rel(s, u);
      return v > 0 ? base(s, u) + v : -1e9;
    };
    return f;
  }
  kicker(s0, u0, len, h, w, kind = 'kicker', base = null) {
    const f = this._onBase({
      type: kind, s0, s1: s0 + len, u0, w, h, len,
      fn: (s, u) => {
        if (s < s0 || s > s0 + len) return 0;
        const lf = lateralFall(u, u0, w, 2.0);
        if (lf <= 0) return 0;
        const t = (s - s0) / len;
        return h * (0.55 * t * t + 0.45 * t * t * t * t) * lf;
      },
    }, base);
    f.lipSlope = (h / len) * (0.55 * 2 + 0.45 * 4);
    this._reg(f, s0, s0 + len, u0 - w / 2 - 2, u0 + w / 2 + 2);
    this.kickers.push(f);
    return f;
  }
  tabletop(s0, u0, up, flat, down, h, w) {
    const f = {
      type: 'table', s0, s1: s0 + up + flat + down, u0, w, h, up, flat, down,
      fn: (s, u) => {
        const x = s - s0;
        if (x < 0 || x > up + flat + down) return 0;
        const lf = lateralFall(u, u0, w, 2.5);
        if (lf <= 0) return 0;
        let y;
        if (x < up) { const t = x / up; y = h * (0.5 * t * t + 0.5 * t * t * t); }
        else if (x < up + flat) y = h;
        else { const t = (x - up - flat) / down; y = h * (1 - t * t * (3 - 2 * t)); }
        return y * lf;
      },
    };
    this._reg(f, s0, f.s1, u0 - w / 2 - 2.5, u0 + w / 2 + 2.5);
    this.kickers.push(f);
    return f;
  }
  landing(s0, u0, len, h, w) {
    const f = {
      type: 'landing', s0, s1: s0 + len, u0, w, h,
      fn: (s, u) => {
        const x = s - s0;
        if (x < 0 || x > len) return 0;
        const lf = lateralFall(u, u0, w, 4);
        if (lf <= 0) return 0;
        const k = Math.min(1, x / 3);
        const t = clamp((x - 3) / (len - 3), 0, 1);
        return h * Math.min(k * 4, 1) * (1 - t * t * (3 - 2 * t)) * lf;
      },
    };
    return this._reg(f, s0, s0 + len, u0 - w / 2 - 4, u0 + w / 2 + 4);
  }
  // filled gap between a big kicker and its landing: come up short and you
  // land on the deck instead of slamming into the knuckle
  deck(sLip, sKnuckle, u0, w, h, lh) {
    const yA = this.ground(sLip, u0) + h - 1.4, yB = this.ground(sKnuckle, u0) + lh;
    const f = {
      type: 'deck', s0: sLip, s1: sKnuckle, u0, w,
      fn: (s, u) => {
        if (s < sLip || s > sKnuckle + 0.8) return 0;
        const lf = lateralFall(u, u0, w, 3);
        if (lf <= 0) return 0;
        const t = Math.min(1, (s - sLip) / (sKnuckle - sLip));
        return Math.max(0, yA + (yB - yA) * t - this.ground(s, u)) * lf;
      },
    };
    return this._reg(f, sLip, sKnuckle + 0.8, u0 - w / 2 - 3, u0 + w / 2 + 3);
  }
  bigJump(s, u0, len, h, w, gap, llen, lh) {
    const k = this.kicker(s, u0, len, h, w, 'mega');
    k.mega = true;
    this.deck(s + len, s + len + gap, u0, w, h, lh);
    this.landing(s + len + gap, u0, llen, lh, w + 5);
    this.tokenLine(s + len, s + len + gap + 4, u0, u0, h + 5, 7, 7 + h);
    return k;
  }
  // Solid, rounded obstacle you can ollie onto (snow-capped boulder or parked car).
  car(s0, u0, opts = {}) {
    const len = opts.len ?? 4.4, w = opts.w ?? 2.6, h = opts.h ?? 1.7;
    const kind = opts.kind ?? 'rock';
    const f = this._onBase({
      type: 'car', kind, solid: true, s0, s1: s0 + len, u0, w, h, len, rot: opts.rot ?? 0, color: opts.color,
      fn: kind === 'car'
        ? (s, u) => {
          const x = s - s0;
          if (x < 0 || x > len) return 0;
          const du = Math.abs(u - u0);
          if (du > w / 2) return 0;
          const tx = x / len;
          const cab = smoothstep(0.18, 0.36, tx) * (1 - smoothstep(0.72, 0.86, tx));
          const edge = 1 - Math.pow(du / (w / 2), 6);
          return (0.95 + 0.5 * cab) * edge + 0.08;
        }
        : (s, u) => {
          const x = s - s0;
          if (x < 0 || x > len) return 0;
          const du = Math.abs(u - u0);
          if (du > w / 2) return 0;
          const cab = Math.sin((x / len) * Math.PI);
          const edge = 1 - Math.pow(du / (w / 2), 4);
          return (0.6 + 1.1 * cab) * edge + 0.08;
        },
    }, opts.base);
    this._reg(f, s0, s0 + len, u0 - w / 2, u0 + w / 2);
    this.cars.push(f);
    return f;
  }
  // straight rail / box / log along the fall line, clear of the ground everywhere
  rail(s0, len, u, hgt, type = 'rail', style = 'metal', opts = {}) {
    const gh = (s) => (opts.onTop ? this.height(s, u) : this.ground(s, u));
    let y0 = gh(s0) + hgt, y1 = gh(s0 + len) + hgt;
    if (opts.y0 !== undefined) { y0 = opts.y0; y1 = opts.y1; }
    let lift = 0;
    for (let s = s0; s <= s0 + len; s += 1) {
      const t = (s - s0) / len;
      const gap = y0 + (y1 - y0) * t - gh(s);
      lift = Math.max(lift, hgt * 0.75 - gap);
    }
    y0 += lift; y1 += lift;
    const r = { type, style, s0, s1: s0 + len, u, y0, y1, h: hgt, color: opts.color };
    this.rails.push(r);
    this._reg({ type: 'railFoot', fn: () => 0 }, s0 - 1, s0 + len + 1, u - 1, u + 1);
    return r;
  }
  // feeder ramp + rail / box
  railLine(s, u, len, hgt, type = 'rail', style = 'metal', tokens = true) {
    this.kicker(s - 6, u, 5, Math.min(0.75, hgt * 0.8), 2.6, 'feeder');
    const r = this.rail(s, len, u, hgt, type, style);
    if (tokens) this.tokenLine(s + 2, s + len - 2, u, u, hgt + 0.9, Math.max(2, Math.round(len / 5)));
    return r;
  }
  // rock band: the slope steps down abruptly by d over its whole width. The
  // shelf above the edge is built up gently so the approach stays downhill.
  cliff(se, u0, w, d) {
    const ramp = Math.max(24, d * 8);
    const f = {
      type: 'cliff', solid: true, s0: se - ramp, s1: se + 0.4, u0, w, h: d, se,
      fn: (s, u) => {
        if (s < se - ramp || s > se + 0.4) return 0;
        const lf = lateralFall(u, u0, w, 5);
        if (lf <= 0) return 0;
        const r = smoothstep(se - ramp, se - 2, s);
        const e = s <= se ? 1 : 1 - (s - se) / 0.4;
        return d * r * e * lf * (0.94 + 0.06 * Math.sin(u * 1.3 + s * 0.7));
      },
    };
    this.cliffs.push(f);
    return this._reg(f, se - ramp, se + 0.4, u0 - w / 2 - 5, u0 + w / 2 + 5);
  }
  pillow(s0, u0, r, h) {
    const f = {
      type: 'pillow', s0: s0 - r, s1: s0 + r, u0, r, h, sc: s0,
      fn: (s, u) => {
        const ds = s - s0, du = u - u0;
        const q = (ds * ds + du * du) / (r * r);
        if (q >= 1) return 0;
        const k = 1 - q;
        return h * k * Math.sqrt(k);
      },
    };
    this.pillows.push(f);
    return this._reg(f, s0 - r, s0 + r, u0 - r, u0 + r);
  }
  rollers(s0, n, lambda, amp, u0, w) {
    const f = {
      type: 'roller', s0, s1: s0 + n * lambda, u0, w,
      fn: (s, u) => {
        const x = s - s0;
        if (x < 0 || x > n * lambda) return 0;
        const lf = lateralFall(u, u0, w, 6);
        if (lf <= 0) return 0;
        return amp * (0.5 - 0.5 * Math.cos((x / lambda) * Math.PI * 2)) * lf;
      },
    };
    return this._reg(f, s0, f.s1, u0 - w / 2 - 6, u0 + w / 2 + 6);
  }
  // spine / hip / plowed snowbank: a ridge along the fall line you can hit from either side
  spine(s0, len, u0, h, hw, type = 'spine') {
    const f = {
      type, s0, s1: s0 + len, u0, h, hw,
      fn: (s, u) => {
        const x = s - s0;
        if (x < 0 || x > len) return 0;
        const ramp = Math.min(6, len / 3);
        const e = smoothstep(0, ramp, x) * (1 - smoothstep(len - ramp, len, x));
        const t = 1 - Math.abs(u - u0) / hw;
        if (t <= 0) return 0;
        return h * e * (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));
      },
    };
    return this._reg(f, s0, s0 + len, u0 - hw, u0 + hw);
  }
  // A cross-slope ridge (spans u), e.g. a snow berm across a street.
  berm(sc, u0, u1, h, hs) {
    const f = {
      type: 'berm', s0: sc - hs, s1: sc + hs, u0: (u0 + u1) / 2, w: u1 - u0,
      fn: (s, u) => {
        const t = 1 - Math.abs(s - sc) / hs;
        if (t <= 0) return 0;
        const lf = lateralFall(u, (u0 + u1) / 2, u1 - u0, 2);
        return h * (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)) * lf;
      },
    };
    return this._reg(f, sc - hs, sc + hs, u0 - 2, u1 + 2);
  }
  // Snow drift against an uphill wall (rideable ramp up to height `top`).
  drift(sA, u0, dw, top, maxLen = 14) {
    const gA = this.ground(sA - 0.3, u0);
    const gap = top - gA;
    if (gap < 0.4) return null;
    const L = clamp(gap * 5, 5, maxLen);
    const f = {
      type: 'drift', s0: sA - L, s1: sA, u0, w: dw, h: gap,
      fn: (s, u) => {
        if (s < sA - L || s > sA + 0.05) return 0;
        const lf = lateralFall(u, u0, dw, 2.5);
        if (lf <= 0) return 0;
        const t = (s - (sA - L)) / L;
        return Math.max(0, (top - this.ground(s, u)) * t * t) * lf;
      },
    };
    return this._reg(f, sA - L, sA + 0.05, u0 - dw / 2 - 2.5, u0 + dw / 2 + 2.5);
  }
  // chalet / machiya with a rideable hip roof (ridge along the fall line)
  chalet(sc, u0, w, d, wallH, opts = {}) {
    const g = (a, b) => this.ground(sc + a, u0 + b);
    const base = Math.min(g(-w / 2, 0), g(w / 2, 0), g(0, -d / 2), g(0, d / 2), g(-w / 2, -d / 2), g(-w / 2, d / 2), g(w / 2, -d / 2), g(w / 2, d / 2));
    const ov = opts.ov ?? 0.7;
    const hw = w / 2 + ov, hd = d / 2 + ov;
    const rise = opts.rise ?? hd * 0.62;
    const y1 = base + wallH;
    const ye = y1 - 0.25, yr = ye + rise;
    const b = { s: sc, u: u0, w, d, base, y1, ye, yr, hw, hd, rise, color: opts.color, kind: opts.kind || 'chalet', roof: opts.roof || 'hip', seed: this.rng(), chimney: opts.chimney ?? true, style: opts.style ?? 6, lit: opts.lit };
    this.buildings.push(b);
    const roofH = (s, u) => {
      const ds = Math.abs(s - sc), du = Math.abs(u - u0);
      if (ds > hw || du > hd) return -1e9;
      return ye + rise * clamp(Math.min(hd - du, hw - ds) / hd, 0, 1) + 0.12;
    };
    b.roofH = roofH;
    const f = { type: 'roof', solid: true, abs: true, render: false, s0: sc - hw, s1: sc + hw, u0, building: b, fn: roofH };
    b.feature = f;
    this._reg(f, sc - hw, sc + hw, u0 - hd, u0 + hd);
    if (opts.drift !== false) b.drift = this.drift(sc - hw, u0, Math.min(d * 0.8, 7), ye + 0.12);
    return b;
  }
  // Box building with a flat (or gently pitched) roof; footprint in s/u.
  block(s0, s1, u0, u1, H, opts = {}) {
    const g = (s, u) => this.ground(s, u);
    const base = Math.min(g(s0, u0), g(s0, u1), g(s1, u0), g(s1, u1), g((s0 + s1) / 2, (u0 + u1) / 2));
    const top = (opts.baseY ?? base) + H;
    const b = { s: (s0 + s1) / 2, u: (u0 + u1) / 2, w: s1 - s0, d: u1 - u0, s0, s1, u0, u1, base: opts.baseY ?? base, H, top, kind: 'block', ...opts };
    this.buildings.push(b);
    const snow = opts.roofSnow ?? 0.3;
    const pitch = opts.pitch ?? 0;
    // roofSlope: snow piled so the roof falls with the hill (rooftop lines keep their speed)
    const slope = opts.roofSlope ?? 0;
    const roofH = pitch
      ? (s, u) => {
        if (s < s0 || s > s1 || u < u0 || u > u1) return -1e9;
        // gable ridge along s
        const hd = (u1 - u0) / 2;
        return top + pitch * (1 - Math.abs(u - (u0 + u1) / 2) / hd) + snow + slope * (s1 - s);
      }
      : (s, u) => (s < s0 || s > s1 || u < u0 || u > u1 ? -1e9 : top + snow + slope * (s1 - s));
    b.roofH = roofH;
    const f = { type: 'roof', solid: true, abs: true, render: false, s0, s1, u0: b.u, building: b, fn: roofH };
    b.feature = f;
    this._reg(f, s0, s1, u0, u1);
    return b;
  }
  // Flat elevated deck (bridge, viaduct, terrace); y(s) gives its surface.
  slab(s0, s1, u0, u1, yFn, opts = {}) {
    const f = {
      type: 'slab', solid: opts.solid ?? true, abs: true, render: opts.render ?? false, under: opts.under ?? true, s0, s1, u0: (u0 + u1) / 2, w: u1 - u0, ...opts,
      fn: (s, u) => (s < s0 || s > s1 || u < u0 || u > u1 ? -1e9 : yFn(s, u)),
    };
    return this._reg(f, s0, s1, u0, u1);
  }
  tokenLine(s0, s1, u0, u1, yOff, count, arc = 0) {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const s = s0 + (s1 - s0) * t;
      const u = u0 + (u1 - u0) * t;
      const y = this.height(s, u) + yOff + Math.sin(t * Math.PI) * arc;
      this.tokens.push({ s, u, y });
    }
  }
  sign(s, u, boards, opts = {}) {
    const g = { s, u, boards, ...opts };
    this.signs.push(g);
    return g;
  }
  arch(s, route, opts = {}) {
    const c = route.at(clamp(s, route.s0, route.s1), {});
    const a = { s, u: c.u, w: opts.w ?? Math.min(c.w * 1.3, 34), route, ...opts };
    this.arches.push(a);
    return a;
  }

  // ---------------------------------------------------------------- rails
  findRail(s, u, y, vy) {
    for (const r of this.rails) {
      if (s < r.s0 || s > r.s1) continue;
      const ry = this.railY(r, s);
      const tolU = r.type === 'ledge' ? 1.15 : 1.0;
      if (Math.abs(u - r.u) > tolU) continue;
      const slope = Math.abs((r.y1 - r.y0) / (r.s1 - r.s0));
      if (y < ry - 0.55 || y > ry + 0.9 + slope * 1.5) continue;
      if (vy > 3) continue;
      return r;
    }
    return null;
  }
  railY(r, s) {
    const t = clamp((s - r.s0) / (r.s1 - r.s0), 0, 1);
    return r.y0 + (r.y1 - r.y0) * t + (r.type === 'ledge' ? 0.05 : 0.04);
  }
}

export const bkey = (s, u) => Math.floor(s / BK) * 4096 + Math.floor(u / BK);
export const okey = (s, u) => Math.floor(s / OB) * 4096 + Math.floor(u / OB);
const _c = {};
const _g = { gs: 0, gu: 0 };
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
