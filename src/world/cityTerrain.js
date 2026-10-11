import { mulberry32, fbm2, clamp, smoothstep } from '../core/utils.js';
import { OpenWorldTerrain, Route, lateralFall } from './openBase.js';
import { CITY_LAYOUTS } from './cityLayouts.js';

// An open-world city on a snowy hillside: a grid of named streets running down
// the fall line, cross streets, alleys cutting through the blocks, plazas,
// terraces with stairs, rideable rooftops and stage-specific landmarks. All
// buildings are solid; low roofs can be ridden.
//
// The layout (streets, building style, landmarks) comes from CITY_LAYOUTS;
// this class provides the shared city toolkit the layouts use.

export class CityTerrain extends OpenWorldTerrain {
  constructor(stage) {
    const L = CITY_LAYOUTS[stage.id];
    super(stage, { sMin: L.sMin, sMax: L.sMax, uHalf: L.uHalf + L.margin });
    this.L = L;
    this.city = true;
    this.rng = mulberry32(stage.seed);
    this.length = L.length;
    this.finishS = L.finishS;
    this.uMax = L.uHalf - 4;
    this.sMin = L.sMin + 30;
    this.sEnd = L.sEnd ?? L.sMax - 30;
    this.spawn = L.spawn;
    this.sidewalk = L.sidewalk ?? 3;
    this.routes = L.streets.map((a, i) => new Route({
      ...a, fadeLen: 0,
      pts: a.pts || [[L.sMin, a.u, a.hw, 0], [L.sMax, a.u, a.hw, 0]], linear: !a.pts,
    }, i));
    this.cross = (L.cross || []).map((c) => ({ ...c }));
    this.areas = (L.areas || []).map((a) => ({ ...a }));
    this.defaultZone = L.defaultZone;
    this.mapBounds = { u0: -L.uHalf, u1: L.uHalf, s0: L.sMin + 20, s1: L.finishS + 60 };
    this.reserved = [];
    this.props = { lamps: [], signals: [], vending: [], lanterns: [], trees: [], benches: [], poles: [], bollards: [], hydrants: [], stoneLanterns: [], chochin: [], bamboo: [], torii: [], fences: [] };
    this.decor = { neonGates: [], screens: [], footbridges: [], landmarks: [] };
    this.structures = [];
    this.carves = L.carves || [];
    this.alleys = [];
    this.init();
  }

  _gradeAt(s) {
    return this.L.grade(s);
  }

  _terrain(s, u) {
    const L = this.L;
    let y = this.baseY(s);
    // gentle unevenness so plazas and parks are not perfectly flat
    y += fbm2(u / 140 + 3.1, s / 140 + 1.7, 2) * 0.6;
    for (const c of this.carves) y -= carveDepth(c, s, u);
    if (L.terrainMod) y += L.terrainMod(s, u, this);
    // the city ends against higher ground (outside the playable area)
    const au = Math.abs(u);
    if (au > L.uHalf) { const e = au - L.uHalf; y += Math.min(e * e * 0.02, 6 + e * 0.35); }
    if (s < L.sMin + 20) y += (L.sMin + 20 - s) * 0.4;
    return y;
  }

  _layout() {
    this.L.build(this);
  }

  _scatter() {
    this.L.scatter?.(this);
    // posts, lamps and other street furniture are obstacles
    for (const l of this.props.lamps) this.addObstacle({ s: l.s, u: l.u, r: 0.28, top: l.y + 6.5, kind: 'post' });
    for (const p of this.props.poles) this.addObstacle({ s: p.s, u: p.u, r: 0.3, top: p.y + 9.4, kind: 'post' });
    for (const v of this.props.vending) this.addObstacle({ s: v.s, u: v.u, r: 0.7, top: v.y + 1.9, kind: 'box' });
    for (const t of this.props.trees) this.addObstacle({ s: t.s, u: t.u, r: 0.55 * (t.sc ?? 1), top: t.y + 6 * (t.sc ?? 1), kind: 'tree' });
    for (const g of this.props.signals) this.addObstacle({ s: g.s, u: g.u, r: 0.25, top: g.y + 5.6, kind: 'post' });
    for (const l of this.props.stoneLanterns) this.addObstacle({ s: l.s, u: l.u, r: 0.5, top: l.y + 1.8, kind: 'post' });
    for (const b of this.props.bamboo) this.addObstacle({ s: b.s, u: b.u, r: 0.22, top: b.y + 12, kind: 'tree' });
    for (const t of this.props.torii) for (const sd of [-1, 1]) this.addObstacle({ s: t.s, u: t.u + sd * t.w / 2, r: 0.32, top: t.y + t.h, kind: 'post' });
    for (const g of this.signs) this.addObstacle({ s: g.s, u: g.u, r: 0.3, top: this.ground(g.s, g.u) + 3.4, kind: 'post' });
  }

  // ---------------------------------------------------------------- street geometry
  street(id) {
    return this.routes.find((r) => r.id === id);
  }
  // Is (s,u) on a street (road + sidewalk) or cross street?
  onStreet(s, u, pad = 0) {
    for (const r of this.routes) {
      if (r.street === false) continue;
      const c = r.at(clamp(s, r.s0, r.s1), _c);
      if (s >= r.s0 && s <= r.s1 && Math.abs(u - c.u) < c.w + (r.sw ?? this.sidewalk) + pad) return r;
    }
    for (const c of this.cross) if (Math.abs(s - c.s) < c.hw + this.sidewalk + pad && u > (c.u0 ?? -1e9) && u < (c.u1 ?? 1e9)) return c;
    return null;
  }
  // Light tint of the ground: roads are packed and a little grey, pavements bright.
  groundTint(s, u) {
    // stone embankments of canals and rivers
    for (const c of this.carves) {
      const d = c.along === 's' ? Math.abs(u - (typeof c.u === 'function' ? c.u(s) : c.u)) : Math.abs(s - c.s);
      if ((c.s0 === undefined || (s > c.s0 && s < c.s1)) && d > c.hw - 0.5 && d < c.hw + c.bank + 0.5) return 0.62;
    }
    for (const r of this.routes) {
      if (r.street === false || s < r.s0 || s > r.s1) continue;
      const c = r.at(s, _c);
      const d = Math.abs(u - c.u);
      if (d < c.w) return r.paved ?? 0.86;
      if (d < c.w + (r.sw ?? this.sidewalk)) return 0.97;
    }
    for (const c of this.cross) {
      if (u < (c.u0 ?? -1e9) || u > (c.u1 ?? 1e9)) continue;
      const d = Math.abs(s - c.s);
      if (d < c.hw) return 0.87;
      if (d < c.hw + this.sidewalk) return 0.97;
    }
    return 1;
  }
  reserve(s0, s1, u0, u1, tag = '') {
    this.reserved.push({ s0, s1, u0, u1, tag });
  }
  isReserved(s0, s1, u0, u1, m = 0) {
    return this.reserved.some((r) => s1 + m > r.s0 && s0 - m < r.s1 && u1 + m > r.u0 && u0 - m < r.u1);
  }

  // ---------------------------------------------------------------- blocks and buildings
  // Fill every block between the streets with buildings along their edges
  // (with alleys cutting through), skipping reserved areas.
  fillBlocks(opt) {
    const rng = this.rng;
    const L = this.L;
    const sw = this.sidewalk;
    const streets = this.routes.filter((r) => r.street !== false && !r.noBlocks);
    const crossS = [{ s: L.sMin - 10, hw: 0 }, ...this.cross.filter((c) => c.u0 === undefined), { s: L.sMax + 10, hw: 0 }].sort((a, b) => a.s - b.s);
    for (let i = 0; i < crossS.length - 1; i++) {
      const sA0 = crossS[i].s + crossS[i].hw + (crossS[i].hw ? sw : 0), sB0 = crossS[i + 1].s - crossS[i + 1].hw - (crossS[i + 1].hw ? sw : 0);
      if (sB0 - sA0 < 8) continue;
      // edges of every street over this s-range
      const edges = streets.map((r) => {
        let lo = 1e9, hi = -1e9, active = false;
        for (let s = sA0; s <= sB0; s += 4) {
          if (s < r.s0 || s > r.s1) continue;
          active = true;
          const c = r.at(s, _c);
          const rsw = r.sw ?? sw;
          lo = Math.min(lo, c.u - c.w - rsw);
          hi = Math.max(hi, c.u + c.w + rsw);
        }
        return active ? { lo, hi, r } : null;
      }).filter(Boolean).sort((a, b) => a.lo - b.lo);
      const bounds = [{ hi: -L.uHalf - L.margin }, ...edges, { lo: L.uHalf + L.margin }];
      for (let k = 0; k < bounds.length - 1; k++) {
        const uA = bounds[k].hi, uB = bounds[k + 1].lo;
        if (uB - uA < 7) continue;
        // partial cross streets (u-limited) split blocks too
        let pieces = [[sA0, sB0]];
        for (const c of this.cross) {
          if (c.u0 === undefined || c.u1 < uA || c.u0 > uB) continue;
          const cs0 = c.s - c.hw - sw, cs1 = c.s + c.hw + sw;
          pieces = pieces.flatMap(([a, b]) => (cs1 <= a || cs0 >= b ? [[a, b]] : [[a, cs0], [cs1, b]].filter(([x, y]) => y - x > 6)));
        }
        for (const [sA, sB] of pieces) this._fillRect({ sA, sB, uA, uB, leftStreet: bounds[k].r, rightStreet: bounds[k + 1].r }, opt, rng);
      }
    }
  }

  _fillRect(rect, opt, rng) {
    const { sA, sB, uA, uB } = rect;
    const W = uB - uA, D = sB - sA;
    const kind = opt.kindAt ? opt.kindAt(rect, rng) : 'buildings';
    if (kind === 'skip') return;
    const mk = (s0, s1, u0, u1, face) => {
      if (s1 - s0 < 3 || u1 - u0 < 3) return;
      if (this.isReserved(s0, s1, u0, u1, 1)) return;
      const sc = (s0 + s1) / 2, uc = (u0 + u1) / 2;
      const H = opt.height(sc, uc, rng, rect);
      const style = opt.style(sc, uc, rng);
      const b = this.block(s0, s1, u0, u1, H, {
        style, face, seed: rng(), lit: opt.lit?.(rng) ?? 0.4, color: opt.color(rng, style), roofKind: opt.roof?.(sc, uc, rng, H) ?? 'flat',
        pitch: 0, kind: 'block', district: opt.district,
      });
      if (b.roofKind === 'gable' || b.roofKind === 'hip') {
        // tiled pitched roof: physics follows the ridge
        const rise = Math.min(u1 - u0, s1 - s0) * 0.28;
        const hw = (s1 - s0) / 2 + 0.6, hd = (u1 - u0) / 2 + 0.6;
        b.rise = rise; b.hw = hw; b.hd = hd; b.ye = b.top - 0.2;
        const along = (s1 - s0) >= (u1 - u0);
        b.ridgeAlong = along ? 's' : 'u';
        b.roofH = (s, u) => {
          const ds = Math.abs(s - sc), du = Math.abs(u - uc);
          if (ds > hw || du > hd) return -1e9;
          const k = b.roofKind === 'hip' ? Math.min(hd - du, hw - ds) / Math.min(hd, hw) : along ? (hd - du) / hd : (hw - ds) / hw;
          return b.ye + rise * clamp(k, 0, 1) + 0.12;
        };
        b.feature.fn = b.roofH;
        b.feature.bs0 = sc - hw; b.feature.bs1 = sc + hw; b.feature.bu0 = uc - hd; b.feature.bu1 = uc + hd;
        this._addFeatureBuckets(b.feature, sc - hw, sc + hw, uc - hd, uc + hd);
      }
      return b;
    };
    const lot = () => rng.range(opt.lot[0], opt.lot[1]);
    const depthMax = Math.min(opt.depth[1], W / 2);
    // through-alleys (cut across the whole block)
    const alleys = [];
    if (D > 30 && rng() < (opt.alley ?? 0.5)) {
      const n = D > 70 ? rng.int(1, 2) : 1;
      for (let i = 0; i < n; i++) alleys.push(sA + D * ((i + 1) / (n + 1)) + rng.range(-4, 4));
    }
    const inAlley = (a, b) => alleys.some((x) => b > x - 2.2 && a < x + 2.2);
    const row = (u0, u1, face) => {
      let s = sA;
      while (s < sB - 2) {
        let w = lot();
        if (sB - s - w < opt.lot[0] * 0.6) w = sB - s;
        let e = Math.min(sB, s + w);
        const hit = alleys.find((x) => e > x - 2.2 && s < x + 2.2);
        if (hit !== undefined) {
          if (hit - 2.2 - s > 3) mk(s, hit - 2.2, u0, u1, face);
          s = hit + 2.2;
          continue;
        }
        mk(s, e, u0, u1, face);
        s = e + (rng() < (opt.gap ?? 0.12) ? rng.range(1.5, 4) : 0);
      }
    };
    if (W < opt.depth[0] * 2 + 6) {
      row(uA, uB, { du: rect.leftStreet ? -1 : 1, ds: 0, both: true });
      for (const x of alleys) this.alleys.push({ s: x, u0: uA, u1: uB });
      return;
    }
    const dL = rng.range(opt.depth[0], depthMax), dR = rng.range(opt.depth[0], depthMax);
    row(uA, uA + dL, { du: -1, ds: 0 });
    row(uB - dR, uB, { du: 1, ds: 0 });
    for (const x of alleys) this.alleys.push({ s: x, u0: uA, u1: uB });
    // buildings facing the cross streets between the two rows
    const midA = uA + dL + 0.2, midB = uB - dR - 0.2;
    if (midB - midA > 6) {
      for (const [edge, dir] of [[sA, -1], [sB, 1]]) {
        const dep = Math.min(rng.range(opt.depth[0], opt.depth[1]), D / 2 - 2);
        if (dep < 4) continue;
        const s0 = dir < 0 ? edge : edge - dep, s1 = dir < 0 ? edge + dep : edge;
        if (inAlley(s0, s1)) continue;
        let u = midA;
        while (u < midB - 2) {
          let w = lot();
          if (midB - u - w < opt.lot[0] * 0.6) w = midB - u;
          mk(s0, s1, u, Math.min(midB, u + w), { du: 0, ds: dir });
          u += w;
        }
      }
    }
  }

  _addFeatureBuckets(f, s0, s1, u0, u1) {
    // re-register a feature whose footprint grew (pitched roofs with eaves)
    for (let a = Math.floor(s0 / 16); a <= Math.floor(s1 / 16); a++) {
      for (let b = Math.floor(u0 / 16); b <= Math.floor(u1 / 16); b++) {
        const k = a * 4096 + b;
        let l = this.bucket.get(k);
        if (!l) this.bucket.set(k, (l = []));
        if (!l.includes(f)) l.push(f);
      }
    }
  }

  // ---------------------------------------------------------------- city features
  // Terrace (plaza on a platform) whose downhill edge drops to the street by a
  // flight of stairs with handrails; flat top level with the uphill street.
  terrace(sTop, sEdge, u0, w, opts = {}) {
    const yTop = this.ground(sTop, u0) + (opts.lift ?? 0);
    const stairLen = opts.stairLen ?? 8;
    const sEnd = sEdge + stairLen;
    const yEnd = this.ground(sEnd, u0);
    const drop = yTop - yEnd;
    const f = {
      type: 'terrace', solid: true, s0: sTop, s1: sEnd, u0, w, yTop, sEdge, sEnd, drop, stairs: opts.stairs !== false,
      fn: (s, u) => {
        if (s < sTop || s > sEnd) return 0;
        const lf = Math.abs(u - u0) <= w / 2 ? 1 : 0;
        if (!lf) return 0;
        const g = this.ground(s, u);
        if (s <= sEdge) return Math.max(0, yTop - g);
        // stairs: a steady slope (the steps are drawn, the board rides the nosings)
        const t = (s - sEdge) / stairLen;
        return Math.max(0, yTop + (yEnd - yTop) * t - g);
      },
    };
    this._reg(f, sTop, sEnd, u0 - w / 2, u0 + w / 2);
    this.structures.push(f);
    if (opts.rails !== false && drop > 1.2) {
      for (const sd of opts.railSides ?? [-1, 1]) {
        const ru = u0 + sd * (w / 2 - 0.6);
        this.rails.push({ type: 'rail', style: 'handrail', s0: sEdge - 0.6, s1: sEnd + 0.4, u: ru, y0: yTop + 0.95, y1: yEnd + 0.95, h: 0.95 });
      }
    }
    return f;
  }
  // Plowed snowbank along a curb: ride up it and pop off the top.
  snowbank(s0, len, u0, h = 1.2, hw = 1.9) {
    return this.spine(s0, len, u0, h, hw, 'snowbank');
  }
  // Parked cars along a curb, with snowbanks between them.
  parkedRow(street, s0, s1, side, opts = {}) {
    const rng = this.rng;
    let s = s0;
    while (s < s1 - 6) {
      const c = street.at(clamp(s, street.s0, street.s1), {});
      const u = c.u + side * (c.w - 1.5);
      if (rng() < (opts.car ?? 0.55) && this._free(s - 1, s + 5.4, u - 1.2, u + 1.2, 0.6)) {
        this.car(s, u, { kind: 'car', len: 4.4, w: 1.9, h: 1.45, color: rng.pick(opts.colors || [0xb8261e, 0x1d3f8a, 0xe8e8e8, 0x1a1a1f, 0xf2c20f, 0x2e6b4a, 0x8a8f99]) });
        if (rng() < 0.35) this.tokens.push({ s: s + 2.2, u, y: this.ground(s, u) + 2.8 });
        s += 5.6 + rng.range(0, 2);
      } else if (rng() < (opts.bank ?? 0.5)) {
        const len = rng.range(8, 16);
        if (this._free(s, s + len, u - 2, u + 2, 0.5)) this.snowbank(s, len, u, rng.range(0.9, 1.4));
        s += len + rng.range(1, 3);
      } else s += rng.range(4, 9);
    }
  }
  // Street lamps on both sidewalks of a street.
  lampsAlong(street, every = 26, opts = {}) {
    const sw = street.sw ?? this.sidewalk;
    for (let s = street.s0 + (opts.offset ?? 8); s < street.s1 - 4; s += every) {
      for (const side of opts.sides ?? [-1, 1]) {
        const c = street.at(s, {});
        const u = c.u + side * (c.w + Math.min(0.8, sw * 0.3));
        if (this.onCross(s, 2)) continue;
        if (this.height(s, u) - this.ground(s, u) > 0.3) continue;
        this.props.lamps.push({ s: s + side * every * 0.25, u, y: this.ground(s, u), dir: -side, style: opts.style });
      }
    }
  }
  onCross(s, pad = 0) {
    return this.cross.find((c) => Math.abs(s - c.s) < c.hw + this.sidewalk + pad && c.u0 === undefined);
  }
  onLaneCross(s, pad = 2) {
    return this.cross.find((c) => Math.abs(s - c.s) < c.hw + this.sidewalk + pad);
  }
  // Rideable rooftop line: a row of low buildings stepping down the hill with
  // jumpable gaps, kickers on the roofs and a ramp up at the start.
  rooftopLine(u0, s0, s1, width, opts = {}) {
    const rng = this.rng;
    const roofs = [];
    let s = s0;
    const above = opts.above ?? 7;
    let first = true, k = 0, prevEnd = Infinity;
    while (s < s1 - 10) {
      if (this.onCross(s + 6, 0) || this.onCross(s, 0)) { s += 4; continue; }
      let len = rng.range(opts.len?.[0] ?? 18, opts.len?.[1] ?? 34);
      const cr = this.cross.find((c) => c.u0 === undefined && c.s - c.hw - this.sidewalk > s && c.s - c.hw - this.sidewalk < s + len + 6);
      if (cr) len = Math.max(8, cr.s - cr.hw - this.sidewalk - s);
      const sEnd = Math.min(s + len, s1);
      // the first roofs are built into the slope so you can ride straight on
      let H = Math.min(above + rng.range(-0.4, 0.4), 0.9 + k * 0.6);
      k++;
      // the snow on the roof falls with the street so the line keeps its speed
      const slope = Math.max(0, (this.ground(s, u0) - this.ground(sEnd, u0)) / (sEnd - s));
      // never start higher than the roof we just left (no walls in the line)
      const ua = u0 - width / 2, ub = u0 + width / 2;
      const base = Math.min(this.ground(s, ua), this.ground(s, ub), this.ground(sEnd, ua), this.ground(sEnd, ub), this.ground((s + sEnd) / 2, u0));
      H = Math.max(2.5, Math.min(H, prevEnd - 0.3 - (base + 0.3 + slope * (sEnd - s))));
      const b = this.block(s, sEnd, u0 - width / 2, u0 + width / 2, H, { style: opts.style ?? 1, face: { du: opts.face ?? -1, ds: 0 }, seed: rng(), lit: 0.45, color: opts.color?.(rng) ?? 0x3a3a46, roofKind: 'flat', rooftop: true, roofSnow: 0.3, roofSlope: slope });
      roofs.push(b);
      prevEnd = b.roofH(sEnd, u0);
      if (first) {
        // a long plowed ramp so you can ride straight up onto the first roof
        this.drift(s, u0, Math.min(width - 1, 8), b.top + 0.3 + b.roofSlope * (sEnd - s), 10);
        first = false;
      }
      // kicker near the downhill end of each roof to clear the next gap
      const kl = 4.5;
      if (sEnd - s > 12) this.kicker(sEnd - kl - 1.2, u0, kl, 0.9, Math.min(width - 2, 4.5), 'kicker', (ss, uu) => b.roofH(ss, uu));
      for (let q = 1; q <= 3; q++) this.tokens.push({ s: s + (sEnd - s) * (q / 4), u: u0, y: b.roofH(s + (sEnd - s) * (q / 4), u0) + 1.3 });
      // across a cross street: a skybridge carries the line on
      if (cr && opts.bridges !== false) {
        const bs0 = sEnd, bs1 = cr.s + cr.hw + this.sidewalk + 0.5;
        const y0 = b.top + 0.3;
        const nextTop = this.ground(bs1 + 4, u0) + Math.min(above, 0.9 + k * 0.6) + 0.3 + slope * 20;
        this.slab(bs0, bs1, u0 - 2.2, u0 + 2.2, (ss) => y0 + (nextTop - y0) * ((ss - bs0) / (bs1 - bs0)), { kind: 'skybridge' });
        this.structures.push({ type: 'skybridge', s0: bs0, s1: bs1, u0, w: 4.4, y0, y1: nextTop });
        prevEnd = nextTop + 0.25;
        s = bs1;
      } else s = sEnd + (k < 4 ? 0.6 : rng.range(opts.gap?.[0] ?? 4, opts.gap?.[1] ?? 8));
    }
    return roofs;
  }
}

// Depth of a carved channel (canal / river) at (s,u).
function carveDepth(c, s, u) {
  if (c.s0 !== undefined && (s < c.s0 || s > c.s1)) return 0;
  let d;
  if (c.along === 's') {
    const cu = typeof c.u === 'function' ? c.u(s) : c.u;
    d = Math.abs(u - cu);
  } else {
    if (c.u0 !== undefined && (u < c.u0 || u > c.u1)) return 0;
    d = Math.abs(s - c.s);
  }
  if (d > c.hw + c.bank) return 0;
  // ends of a channel ramp gently back up to street level
  const ends = c.s0 !== undefined ? smoothstep(c.s0, c.s0 + 40, s) * (1 - smoothstep(c.s1 - 40, c.s1, s)) : 1;
  if (d <= c.hw) return c.depth * ends;
  const t = (d - c.hw) / c.bank;
  return c.depth * ends * (1 - smoothstep(0, 1, t));
}

export { carveDepth, lateralFall };
const _c = {};
