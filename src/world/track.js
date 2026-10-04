import * as THREE from 'three';
import { mulberry32, noise1, clamp, smoothstep } from '../core/utils.js';

// The course is a long downhill "snow street" that winds through the city.
// Everything is described in track space: s = distance along the street,
// u = lateral offset (right positive). World height is absolute.

export const HALF_W = 11; // flat riding area half width
export const BANK_R = 6; // quarter-pipe radius of the side banks
const BANK_ANGLE = (60 * Math.PI) / 180;
export const BANK_END = BANK_R * Math.sin(BANK_ANGLE); // lateral extent of bank arc
export const BANK_TOP = BANK_R * (1 - Math.cos(BANK_ANGLE));
export const SIDEWALK = 5.5;
export const EDGE_U = HALF_W + BANK_END; // coping line
export const BUILD_U = EDGE_U + SIDEWALK; // building front line
const DS = 1; // sample spacing of center line

export class Track {
  constructor(stage) {
    this.stage = stage;
    const rng = (this.rng = mulberry32(stage.seed));
    this.length = stage.length;
    this.finishS = this.length - 70;
    const n = Math.ceil(this.length / DS) + 2;
    this.n = n;
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.py = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.drops = [];

    // Pre-plan stair drops so the elevation profile can include them.
    const dropCount = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < dropCount; i++) {
      const s = 250 + (i + rng() * 0.6) * ((this.length - 500) / dropCount);
      this.drops.push({ s, len: 7, h: 3.6 + rng() * 1.2 });
    }

    // Integrate heading and elevation.
    const turn = stage.course.turn;
    const off = rng() * 1000;
    let a = -Math.PI / 2;
    let x = 0, z = 0, y = 0;
    for (let i = 0; i < n; i++) {
      const s = i * DS;
      this.px[i] = x;
      this.pz[i] = z;
      this.py[i] = y;
      this.tx[i] = Math.cos(a);
      this.tz[i] = Math.sin(a);
      // curvature: smooth noise, straight at start/end
      const ramp = smoothstep(60, 160, s) * (1 - smoothstep(this.length - 200, this.length - 120, s));
      const k = (noise1(s / 190 + off) * 0.75 + noise1(s / 83 + off * 2) * 0.25) * 0.0055 * turn * ramp;
      a += k * DS;
      x += Math.cos(a) * DS;
      z += Math.sin(a) * DS;
      // grade
      let g = stage.course.grade * (1 + 0.5 * noise1(s / 140 + off * 3));
      g = Math.max(0.06, g);
      g *= smoothstep(0, 40, s) * 0.7 + 0.3;
      if (s > this.finishS) g = stage.course.grade * 0.4 * (1 - smoothstep(this.finishS, this.finishS + 40, s)) - 0.02 * smoothstep(this.finishS + 20, this.length, s);
      for (const d of this.drops) {
        if (s >= d.s && s < d.s + d.len) g += d.h / d.len;
        // short flat before / after the stairs
        if ((s >= d.s - 14 && s < d.s) || (s >= d.s + d.len && s < d.s + d.len + 10)) g *= 0.35;
      }
      y -= g * DS;
    }

    this._buildFeatures();
  }

  // ---------------------------------------------------------------- frames
  _idx(s) {
    const f = clamp(s / DS, 0, this.n - 1.001);
    const i = Math.floor(f);
    return [i, f - i];
  }
  baseY(s) {
    const [i, t] = this._idx(s);
    return this.py[i] + (this.py[i + 1] - this.py[i]) * t;
  }
  baseSlope(s) {
    return (this.baseY(s + 0.5) - this.baseY(s - 0.5));
  }
  frame(s, out = {}) {
    const [i, t] = this._idx(s);
    out.x = this.px[i] + (this.px[i + 1] - this.px[i]) * t;
    out.z = this.pz[i] + (this.pz[i + 1] - this.pz[i]) * t;
    out.y = this.py[i] + (this.py[i + 1] - this.py[i]) * t;
    let tx = this.tx[i] + (this.tx[i + 1] - this.tx[i]) * t;
    let tz = this.tz[i] + (this.tz[i + 1] - this.tz[i]) * t;
    const l = Math.hypot(tx, tz);
    tx /= l; tz /= l;
    out.tx = tx; out.tz = tz;
    out.rx = -tz; out.rz = tx; // right vector
    return out;
  }
  // World position for track coords (y absolute).
  toWorld(s, u, y, out = new THREE.Vector3()) {
    const f = this.frame(s, _f);
    return out.set(f.x + f.rx * u, y, f.z + f.rz * u);
  }
  // Heading (world yaw for an object whose forward is -Z) of the track at s.
  yawAt(s) {
    const f = this.frame(s, _f);
    return Math.atan2(-f.tx, -f.tz);
  }
  // Matrix placing an object at (s,u,y) aligned with the track direction.
  matrixAt(s, u, y, extraYaw = 0, scale = 1, out = new THREE.Matrix4()) {
    const p = this.toWorld(s, u, y, _v);
    _q.setFromAxisAngle(_up, this.yawAt(s) + extraYaw);
    _sc.set(scale, scale, scale);
    return out.compose(p, _q, _sc);
  }

  // ---------------------------------------------------------------- surface
  // Lateral profile (banks + sidewalk), relative to the base elevation.
  lateral(u) {
    const d = Math.abs(u) - HALF_W;
    if (d <= 0) return 0;
    if (d < BANK_END) return BANK_R - Math.sqrt(BANK_R * BANK_R - d * d);
    return BANK_TOP + 0.15;
  }
  lateralSlope(u) {
    const d = Math.abs(u) - HALF_W;
    if (d <= 0 || d >= BANK_END) return 0;
    return (d / Math.sqrt(BANK_R * BANK_R - d * d)) * Math.sign(u);
  }

  // Ground height. solid=false skips features that have their own meshes (cars).
  height(s, u, solid = true) {
    let h = this.baseY(s) + this.lateral(u);
    let fh = 0;
    const b = Math.floor(s / 10);
    const list = this.bucket[b];
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!solid && f.solid) continue;
        const v = f.fn(s, u);
        if (v > fh) fh = v;
      }
    }
    return h + fh;
  }
  // Gradient of ground height (dh/ds, dh/du).
  gradient(s, u, out = { gs: 0, gu: 0 }, solid = true) {
    const e = 0.12;
    out.gs = (this.height(s + e, u, solid) - this.height(s - e, u, solid)) / (2 * e);
    out.gu = (this.height(s, u + e, solid) - this.height(s, u - e, solid)) / (2 * e);
    return out;
  }
  // World-space normal at (s,u).
  normal(s, u, out = new THREE.Vector3(), solid = true) {
    const g = this.gradient(s, u, _g, solid);
    const f = this.frame(s, _f);
    // n = (-gs * T - gu * R + up) normalised
    out.set(-g.gs * f.tx - g.gu * f.rx, 1, -g.gs * f.tz - g.gu * f.rz);
    return out.normalize();
  }

  // ---------------------------------------------------------------- features
  _addFeature(f) {
    this.features.push(f);
    for (let b = Math.floor(f.s0 / 10); b <= Math.floor(f.s1 / 10); b++) {
      (this.bucket[b] ||= []).push(f);
    }
  }

  _buildFeatures() {
    const rng = this.rng;
    this.features = [];
    this.bucket = [];
    this.rails = [];
    this.tokens = [];
    this.cars = [];
    this.kickers = [];
    const dens = this.stage.course.features;

    const lateralFall = (u, u0, w, fall) => {
      const d = Math.abs(u - u0) - w / 2;
      if (d <= 0) return 1;
      if (d >= fall) return 0;
      const t = 1 - d / fall;
      return t * t * (3 - 2 * t);
    };

    const kicker = (s0, u0, len, h, w, kind = 'kicker') => {
      const f = {
        type: kind, s0, s1: s0 + len, u0, w, h, len,
        fn: (s, u) => {
          if (s < s0 || s > s0 + len) return 0;
          const lf = lateralFall(u, u0, w, 2.0);
          if (lf <= 0) return 0;
          const t = (s - s0) / len;
          return h * (0.55 * t * t + 0.45 * t * t * t * t) * lf;
        },
      };
      f.lipSlope = (h / len) * (0.55 * 2 + 0.45 * 4);
      this._addFeature(f);
      this.kickers.push(f);
      return f;
    };

    const tabletop = (s0, u0, up, flat, down, h, w) => {
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
      this._addFeature(f);
      this.kickers.push(f);
      return f;
    };

    const landing = (s0, u0, len, h, w) => {
      const f = {
        type: 'landing', s0, s1: s0 + len, u0, w, h,
        fn: (s, u) => {
          const x = s - s0;
          if (x < 0 || x > len) return 0;
          const lf = lateralFall(u, u0, w, 4);
          if (lf <= 0) return 0;
          // knuckle then long smooth landing slope
          const k = Math.min(1, x / 3);
          const t = clamp((x - 3) / (len - 3), 0, 1);
          return h * Math.min(k * 4, 1) * (1 - t * t * (3 - 2 * t)) * lf;
        },
      };
      this._addFeature(f);
      return f;
    };

    const car = (s0, u0, rot) => {
      const len = 4.4, w = 1.9, h = 1.45;
      const f = {
        type: 'car', solid: true, s0, s1: s0 + len, u0, w, h, len, rot,
        fn: (s, u) => {
          const x = s - s0;
          if (x < 0 || x > len) return 0;
          const du = Math.abs(u - u0);
          if (du > w / 2) return 0;
          // snow-capped roof: dome over the cabin, lower over hood/trunk
          const tx = x / len;
          const cab = smoothstep(0.18, 0.36, tx) * (1 - smoothstep(0.72, 0.86, tx));
          const edge = 1 - Math.pow(du / (w / 2), 6);
          return (0.95 + 0.5 * cab) * edge + 0.08;
        },
      };
      this._addFeature(f);
      this.cars.push(f);
      return f;
    };

    const rail = (s0, len, u, hgt, type = 'rail') => {
      const r = {
        type, s0, s1: s0 + len, u,
        y0: this.baseY(s0) + hgt, y1: this.baseY(s0 + len) + hgt, h: hgt,
      };
      this.rails.push(r);
      return r;
    };

    const tokenLine = (s0, s1, u0, u1, yOff, count, arc = 0) => {
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        const s = s0 + (s1 - s0) * t;
        const u = u0 + (u1 - u0) * t;
        const y = this.height(s, u) + yOff + Math.sin(t * Math.PI) * arc;
        this.tokens.push({ s, u, y });
      }
    };

    // Stair sets with handrails
    for (const d of this.drops) {
      const top = d.s - 2;
      // handrails follow the stairs
      for (const side of [-1, 1]) {
        const r = {
          type: 'handrail', s0: d.s - 0.6, s1: d.s + d.len + 0.6, u: side * 4.5,
          y0: this.baseY(d.s - 0.6) + 0.95, y1: this.baseY(d.s + d.len + 0.6) + 0.95, h: 0.95,
        };
        this.rails.push(r);
      }
      tokenLine(top, d.s + d.len + 10, 0, 0, 2.2, 7, 3);
      d.occupied = [d.s - 16, d.s + d.len + 14];
    }

    // Walk along the course placing features.
    let s = 110;
    const blocked = (a, b) => this.drops.some((d) => b > d.occupied[0] && a < d.occupied[1]) || b > this.finishS - 30;
    const types = [
      ['kicker', 30], ['table', 14], ['rail', 16], ['cars', 14], ['ledge', 9], ['mega', 6], ['double', 11],
    ];
    const total = types.reduce((a, t) => a + t[1], 0);
    let lastType = '';
    while (s < this.finishS - 60) {
      let r = rng() * total, type = types[0][0];
      for (const t of types) { if ((r -= t[1]) < 0) { type = t[0]; break; } }
      if (type === lastType && type !== 'kicker') continue;
      let span = 0;
      const u0 = (rng() - 0.5) * 9;
      if (type === 'kicker') {
        const big = rng();
        const len = 8 + big * 7, h = 1.2 + big * 1.4, w = 5 + rng() * 3;
        if (blocked(s - 10, s + len + 40)) { s += 20; continue; }
        kicker(s, u0, len, h, w);
        tokenLine(s - 20, s - 2, u0, u0, 0.9, 4);
        tokenLine(s + len + 6, s + len + 34, u0, u0 * 0.6, h + 3, 5, 3 + big * 4);
        span = len + 40;
      } else if (type === 'table') {
        const up = 9, flat = 6 + rng() * 6, down = 12, h = 2.2 + rng() * 0.8, w = 7;
        if (blocked(s - 10, s + up + flat + down + 15)) { s += 20; continue; }
        tabletop(s, u0, up, flat, down, h, w);
        tokenLine(s + up, s + up + flat + down * 0.6, u0, u0, 2.4, 5, 3);
        span = up + flat + down + 25;
      } else if (type === 'mega') {
        const len = 16, h = 3.2, w = 9;
        const gap = 26, llen = 34, lh = 5.5;
        if (blocked(s - 20, s + len + gap + llen + 20)) { s += 20; continue; }
        const k = kicker(s - 6, 0, len, h, w, 'mega');
        k.mega = true;
        landing(s - 6 + len + gap, 0, llen, lh, 14);
        tokenLine(s + len, s + len + gap + 6, 0, 0, h + 5, 7, 8);
        span = len + gap + llen + 30;
      } else if (type === 'rail' || type === 'ledge') {
        const len = 16 + rng() * 18;
        if (blocked(s - 5, s + len + 10)) { s += 20; continue; }
        const hgt = type === 'rail' ? 0.85 + rng() * 0.35 : 0.65;
        rail(s, len, u0, hgt, type);
        // small launch ramp so the rail can be hit straight from a run
        if (rng() < 0.7) kicker(s - 6.5, u0, 5, 0.75, 2.4, 'feeder');
        tokenLine(s + 2, s + len - 2, u0, u0, hgt + 0.9, Math.round(len / 5));
        span = len + 22;
      } else if (type === 'cars') {
        const n = 2 + Math.floor(rng() * 3);
        if (blocked(s - 5, s + n * 9 + 10)) { s += 20; continue; }
        const side = rng() < 0.5 ? -1 : 1;
        for (let i = 0; i < n; i++) {
          const lane = side * (3 + rng() * 5);
          car(s + i * (7 + rng() * 5), lane, (rng() - 0.5) * 0.25);
        }
        // a launch ramp on the other side
        kicker(s + 4, -side * 5, 9, 1.8, 5);
        tokenLine(s, s + n * 9, side * 5, side * 5, 2.6, n + 2);
        span = n * 10 + 18;
      } else if (type === 'double') {
        // kicker on one side, rail on the other
        const side = rng() < 0.5 ? -1 : 1;
        const len = 10, h = 2.0;
        if (blocked(s - 5, s + 45)) { s += 20; continue; }
        kicker(s, side * 5.5, len, h, 5);
        rail(s - 4, 26, -side * 5.5, 1.0, rng() < 0.5 ? 'rail' : 'ledge');
        tokenLine(s + len + 5, s + len + 30, side * 5.5, side * 4, h + 3, 5, 4);
        span = 45;
      }
      lastType = type;
      s += span + (18 + rng() * 34) / dens;
    }

    // Bank (wall-ride) token lines on open stretches
    for (let i = 0; i < 6; i++) {
      const s0 = 150 + rng() * (this.finishS - 300);
      if (blocked(s0, s0 + 30)) continue;
      const side = rng() < 0.5 ? -1 : 1;
      for (let k = 0; k < 6; k++) {
        const ss = s0 + k * 5;
        const uu = side * (HALF_W + 1.5 + Math.sin((k / 5) * Math.PI) * 3.2);
        this.tokens.push({ s: ss, u: uu, y: this.height(ss, uu) + 1.0 });
      }
    }
  }

  // Find a rail the rider can lock onto.
  findRail(s, u, y, vy) {
    for (const r of this.rails) {
      if (s < r.s0 || s > r.s1) continue;
      const ry = this.railY(r, s);
      const tolU = r.type === 'ledge' ? 1.15 : 1.0;
      if (Math.abs(u - r.u) > tolU) continue;
      if (y < ry - 0.55 || y > ry + 0.9) continue;
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

const _f = {};
const _g = { gs: 0, gu: 0 };
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
