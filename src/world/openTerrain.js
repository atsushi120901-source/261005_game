import { mulberry32, fbm2, noise1, clamp, smoothstep } from '../core/utils.js';
import { OpenWorldTerrain, Route } from './openBase.js';

export { DIFF } from './openBase.js';

// Open mountain: a whole ski area instead of a single street, with named routes
// that split and merge across the slope, forests, cliffs, a mid station and a
// base village.

// Route corridors: control points [s, u, halfWidth, depth].
const ROUTES = [
  { id: 'cliff', name: 'CLIFF LINE', jp: '断崖ライン', diff: 'hard', color: 0xd8452a,
    pts: [[50, -30, 16, 0], [160, -170, 22, 4], [300, -280, 24, 6], [500, -315, 26, 7], [700, -300, 26, 7], [900, -250, 26, 6], [1060, -170, 30, 3], [1170, -110, 40, 0]] },
  { id: 'park', name: 'SNOW PARK', jp: 'スノーパーク', diff: 'mid', color: 0xff8a1a, park: true,
    pts: [[50, -12, 18, 0], [160, -80, 32, 2], [400, -115, 40, 3], [700, -120, 42, 3], [950, -100, 42, 2], [1150, -50, 50, 0]] },
  { id: 'gully', name: 'FOREST GULLY', jp: '森のガリー', diff: 'mid', color: 0x2fb45a, halfpipe: [320, 880],
    pts: [[50, 12, 16, 0], [160, 55, 20, 3], [300, 85, 16, 6], [500, 70, 14, 8.5], [700, 45, 14, 8.5], [880, 35, 16, 6], [1060, 40, 30, 2], [1170, 40, 40, 0]] },
  { id: 'village', name: 'CHALET ROAD', jp: '山小屋ロード', diff: 'easy', color: 0xffc21a,
    pts: [[50, 30, 16, 0], [170, 165, 18, 2], [350, 265, 20, 3], [560, 300, 34, 2], [760, 262, 30, 2], [950, 200, 24, 2], [1150, 120, 40, 0]] },
  { id: 'bigair', name: 'BIG AIR LINE', jp: 'ビッグエア', diff: 'hard', color: 0xff2d6a,
    pts: [[1250, -10, 26, 0], [1400, -25, 30, 3], [1700, -40, 32, 3], [1900, -20, 34, 2], [2060, 0, 60, 0]] },
  { id: 'pillow', name: 'PILLOW WOODS', jp: 'ピロウの森', diff: 'mid', color: 0x7a5cff, woods: true,
    pts: [[1250, -150, 24, 0], [1400, -235, 26, 3], [1650, -260, 26, 3], [1850, -200, 28, 2], [2060, -120, 50, 0]] },
  { id: 'ridge', name: 'RIDGE & HAMLET', jp: '尾根と集落', diff: 'easy', color: 0x23c4d8,
    pts: [[1250, 140, 26, 0], [1400, 215, 28, 3], [1650, 240, 30, 2], [1850, 200, 40, 2], [2060, 120, 60, 0]] },
];

const AREAS = [
  { name: 'SUMMIT', jp: '山頂', s0: -200, s1: 70 },
  { name: 'MID STATION', jp: '中間ステーション', s0: 1130, s1: 1262 },
  { name: 'BASE VILLAGE', jp: 'ベースビレッジ', s0: 2050, s1: 9999 },
];

export class MountainTerrain extends OpenWorldTerrain {
  constructor(stage) {
    super(stage, { sMin: -120, sMax: 2400, uHalf: 540 });
    this.rng = mulberry32(stage.seed);
    this.length = 2200;
    this.finishS = 2125;
    this.uMax = 470;
    this.sMin = -60;
    this.spawn = { s: 16, u: 0 };
    this.routes = ROUTES.map((d, i) => new Route(d, i));
    this.areas = AREAS;
    const gully = this.routes.find((r) => r.halfpipe);
    this.halfpipes = [{ route: gully, s0: gully.halfpipe[0], s1: gully.halfpipe[1] }];
    this.mapBounds = { u0: -470, u1: 470, s0: -30, s1: this.finishS + 70 };
    this.init();
  }

  // Elevation along the fall line: summit plateau, upper face, mid-station
  // flat, lower face, base village flats and a run-out bowl.
  _gradeAt(s) {
    if (s < -30) return -0.55;
    if (s < 55) return 0.05;
    if (s < 1080) return 0.05 + (0.22 + 0.05 * noise1(s / 160 + 3.3) + 0.06 * smoothstep(380, 440, s) * (1 - smoothstep(600, 660, s))) * smoothstep(55, 120, s);
    if (s < 1250) return 0.07 + 0.2 * (1 - smoothstep(1080, 1140, s));
    if (s < 2000) return 0.07 + 0.16 * smoothstep(1250, 1320, s) + 0.04 * noise1(s / 140 + 9.1);
    if (s < 2235) return 0.03 + 0.2 * (1 - smoothstep(2000, 2060, s));
    return -0.12;
  }

  _rowPrep(s) {
    const rp = this._rp || (this._rp = this.routes.map(() => null));
    const tmp = this._rpt || (this._rpt = this.routes.map(() => ({})));
    for (let k = 0; k < this.routes.length; k++) rp[k] = this.routes[k].at(s, tmp[k]);
    return rp;
  }

  // Raw terrain function (before gridding).
  _terrain(s, u, rp) {
    let y = this.baseY(s);
    // summit dome: routes fan out downhill from the peak
    const top = 1 - smoothstep(0, 340, s);
    y -= 0.00032 * u * u * top;
    // the whole face is a shallow bowl so riders drift back to the middle
    y += 0.000035 * u * u;
    let carve = 0, mask = 0;
    for (let k = 0; k < rp.length; k++) {
      const c = rp[k];
      if (!c) continue;
      const x = Math.abs(u - c.u) / c.w;
      const r = this.routes[k];
      const p = r.halfpipe ? 1 - smoothstep(0.66, 1.22, x) : 1 - smoothstep(0.55, 1.5, x);
      const hp = r.halfpipe ? smoothstep(r.halfpipe[0] - 60, r.halfpipe[0], s) * (1 - smoothstep(r.halfpipe[1], r.halfpipe[1] + 60, s)) : 0;
      const pp = hp ? p * hp + (1 - smoothstep(0.55, 1.5, x)) * (1 - hp) : p;
      mask = Math.max(mask, pp * c.fade);
      carve = Math.max(carve, c.d * pp * c.fade);
    }
    y -= carve;
    // smooth pistes, rough backcountry in between; flats at the stations
    let flat = 0;
    for (const a of this.areas) flat = Math.max(flat, smoothstep(a.s0 - 40, a.s0 + 10, s) * (1 - smoothstep(a.s1 - 10, a.s1 + 40, s)));
    flat *= 1 - smoothstep(200, 420, Math.abs(u));
    const A = (0.45 + 5.2 * (1 - mask)) * (1 - 0.75 * flat);
    y += A * fbm2(u / 85 + 11.3, s / 85 + 2.1, 3) + A * 0.32 * fbm2(u / 23 + 4.7, s / 23 + 7.9, 2);
    // big ridges between the routes
    y += (1 - mask) * (1 - flat) * Math.max(0, fbm2(u / 190 + 1.7, s / 260 + 5.2, 2)) * 14;
    // walls around the ski area
    const au = Math.abs(u);
    if (au > 425) { const e = au - 425; y += Math.min(e * e * 0.03, 25 + e * 0.6); }
    if (s < -40) { const e = -40 - s; y += e * 0.45; }
    return y;
  }

  _layout() {
    const rng = this.rng;
    const R = Object.fromEntries(this.routes.map((r) => [r.id, r]));
    const C = (id, s) => R[id].centre(s);
    const W = (id, s) => R[id].at(clamp(s, R[id].s0, R[id].s1), {}).w;

    // ------------------------------------------------ summit
    this.sign(46, -9, this.routes.slice(0, 4).map((r) => ({ route: r })), { big: true });
    for (const r of this.routes.slice(0, 4)) this.arch(150, r);
    for (const r of this.routes.slice(4)) this.arch(1300, r);
    this.sign(1236, -8, this.routes.slice(4).map((r) => ({ route: r })), { big: true });
    // start hut and lookout
    this.chalet(-22, -24, 9, 7, 4, { kind: 'hut', drift: false });
    this.lookouts = [{ s: -10, u: 36 }, { s: 640, u: -200 }, { s: 1150, u: -330 }, { s: 1560, u: 120 }];

    // ------------------------------------------------ SNOW PARK: three lanes
    {
      const lanes = [
        { off: -15, size: 0 }, { off: 0, size: 1 }, { off: 15, size: 2 },
      ];
      for (const L of lanes) {
        let s = 190 + L.size * 12;
        let n = 0;
        while (s < 1000) {
          const u0 = C('park', s) + L.off;
          const pick = (n + L.size) % 4;
          n++;
          if (pick === 0) {
            const len = 7 + L.size * 3.5, h = 1.0 + L.size * 0.8, w = 5 + L.size;
            this.kicker(s, u0, len, h, w);
            this.tokenLine(s + len + 5, s + len + 28 + L.size * 6, u0, u0, h + 2.5, 5, 2 + L.size * 2.5);
            s += len + 45 + L.size * 8;
          } else if (pick === 1) {
            const up = 7 + L.size * 2, flat = 5 + L.size * 3, down = 10 + L.size * 2, h = 1.4 + L.size * 0.7, w = 7;
            this.tabletop(s, u0, up, flat, down, h, w);
            this.tokenLine(s + up, s + up + flat + down * 0.6, u0, u0, h + 1.8, 5, 2 + L.size);
            s += up + flat + down + 30;
          } else if (pick === 2) {
            const len = 14 + L.size * 6;
            this.kicker(s - 6, u0, 5, 0.7, 2.6, 'feeder');
            this.rail(s, len, u0, 0.8 + L.size * 0.25, 'rail', 'metal');
            this.tokenLine(s + 2, s + len - 2, u0, u0, 1.8 + L.size * 0.25, Math.round(len / 5));
            s += len + 26;
          } else {
            const len = 12 + L.size * 5;
            this.kicker(s - 6, u0, 5, 0.6, 2.8, 'feeder');
            this.rail(s, len, u0, 0.6 + L.size * 0.15, 'ledge', 'box');
            this.tokenLine(s + 2, s + len - 2, u0, u0, 1.6, Math.round(len / 5));
            s += len + 26;
          }
        }
      }
      // park finale: mega kicker
      const s = 1010, u0 = C('park', s);
      const k = this.kicker(s, u0, 16, 3.2, 10, 'mega');
      k.mega = true;
      this.deck(s + 16, s + 16 + 26, u0, 10, 3.2, 5.2);
      this.landing(s + 16 + 26, u0, 34, 5.2, 15);
      this.tokenLine(s + 16, s + 16 + 30, u0, u0, 8, 7, 7);
    }

    // ------------------------------------------------ CLIFF LINE
    {
      const drops = [[250, 0, 18, 3.5], [330, -9, 14, 5], [420, 8, 16, 4], [520, -6, 20, 7], [610, 9, 14, 5.5], [700, -3, 22, 8], [800, 10, 16, 5], [900, -8, 18, 6], [990, 4, 22, 4]];
      for (const [s, off, w, d] of drops) {
        const u0 = C('cliff', s) + off;
        this.cliff(s, u0, w, d);
        this.tokenLine(s + 3, s + 18, u0, u0, 2.2 - d * 0.05, 4, d * 0.5);
      }
      // boulder gardens and wind lips between the bands
      for (let s = 200; s < 1040; s += rng.range(16, 30)) {
        const c = C('cliff', s), w = W('cliff', s);
        const u0 = c + rng.range(-0.75, 0.75) * w;
        if (!this._free(s - 2, s + 6, u0 - 3, u0 + 3, 4)) continue;
        if (rng() < 0.55) this.car(s, u0, { rot: rng.range(-0.4, 0.4) });
        else if (this._free(s - 2, s + 12, u0 - 5, u0 + 5, 6)) {
          this.kicker(s, u0, 8, 1.6 + rng() * 0.8, 5, 'kicker');
          this.tokenLine(s + 12, s + 30, u0, u0, 3.2, 4, 3);
        }
      }
    }

    // ------------------------------------------------ FOREST GULLY (natural halfpipe)
    {
      const r = R.gully;
      for (let s = 340; s < 870; s += 22) {
        const c = r.at(s, {});
        const side = Math.round((s - 340) / 22) % 2 ? 1 : -1;
        // tokens high on alternating walls
        for (let k = 0; k < 4; k++) {
          const ss = s + k * 3.5;
          const cc = r.at(ss, {});
          const uu = cc.u + side * cc.w * (0.6 + Math.sin((k / 3) * Math.PI) * 0.35);
          this.tokens.push({ s: ss, u: uu, y: this.height(ss, uu) + 1.4 });
        }
        if ((s - 340) % 66 === 0 && s > 360) this.spine(s, 18, c.u, 1.1, 3.2);
      }
      // fallen logs on the gully floor and in the trees above it
      for (const [s, off] of [[310, -3], [470, 2], [610, -2], [760, 3], [940, -4], [990, 5]]) {
        const u = C('gully', s) + off;
        if (this._free(s - 2, s + 16, u - 2, u + 2)) this.rail(s, 12 + rng() * 5, u, 0.45, 'rail', 'log');
      }
      for (let s = 180; s < 300; s += 40) {
        const u = C('gully', s) + rng.range(-8, 8);
        this.kicker(s, u, 7, 1.3, 5);
        this.tokenLine(s + 10, s + 26, u, u, 2.8, 4, 2);
      }
    }

    // ------------------------------------------------ CHALET ROAD: hamlet with rideable roofs
    {
      const r = R.village;
      for (let s = 190; s < 1080; s += 70) {
        const c = r.at(s, {});
        this.rollers(s, 3, 9, 0.9, c.u, 12);
        this.tokenLine(s + 4.5, s + 22.5, c.u, c.u, 1.6, 3, 1.2);
      }
      // hamlet
      const roofs = [];
      for (const [s, off, w, d, h] of [[520, -26, 11, 8, 4], [545, 24, 10, 8, 3.5], [600, -22, 12, 9, 4.5], [640, 28, 9, 8, 3.5], [690, -25, 10, 8, 4], [720, 22, 11, 9, 4.5]]) {
        const u = C('village', s) + off;
        roofs.push(this.chalet(s, u, w, d, h, { color: rng.pick([0x6e4c33, 0x7a5638, 0x5d4130]) }));
      }
      // two roof-gap lines in the middle of the road
      for (const s of [575, 668]) {
        const u = C('village', s);
        const b = this.chalet(s + 18, u, 12, 7, 2.6, { color: 0x6b4a32, rise: 1.6 });
        this.kicker(s, u, 9, 2.6, 5.5);
        this.tokenLine(s + 9, s + 30, u, u, 3.4, 6, 1.5);
        roofs.push(b);
      }
      for (const b of roofs) for (let k = -1; k <= 1; k++) this.tokens.push({ s: b.s + k * b.w * 0.3, u: b.u, y: b.roofH(b.s + k * b.w * 0.3, b.u) + 1.2 });
      // fence rails along the road
      for (const s of [420, 780, 880]) {
        const c = r.at(s, {});
        this.rail(s, 20, c.u + c.w * 0.55, 0.7, 'ledge', 'fence');
        this.kicker(s - 6, c.u + c.w * 0.55, 5, 0.6, 2.6, 'feeder');
      }
    }

    // ------------------------------------------------ MID STATION
    {
      for (const [s, u] of [[1180, -60], [1200, 60]]) {
        this.kicker(s, u, 9, 1.8, 6);
        this.tokenLine(s + 12, s + 32, u, u, 3, 5, 3);
      }
      this.rail(1190, 18, 0, 0.9, 'rail', 'metal');
      this.kicker(1184, 0, 5, 0.7, 2.6, 'feeder');
      this.chalet(1206, 338, 16, 10, 5, { kind: 'station', color: 0x7a5638 });
      this.chalet(1170, 232, 12, 9, 4.5, { color: 0x6e4c33 });
      this.chalet(1196, -232, 11, 9, 4, { color: 0x6b4a32 });
    }

    // ------------------------------------------------ BIG AIR LINE
    {
      const jumps = [[1360, 14, 2.4, 8, 18, 26, 4.2], [1500, 16, 3.2, 10, 26, 34, 5.2], [1680, 18, 3.8, 11, 32, 38, 6.0]];
      for (const [s, len, h, w, gap, llen, lh] of jumps) {
        const u0 = C('bigair', s);
        const k = this.kicker(s, u0, len, h, w, 'mega');
        k.mega = true;
        this.deck(s + len, s + len + gap, u0, w, h, lh);
        this.landing(s + len + gap, u0, llen, lh, w + 5);
        this.tokenLine(s + len, s + len + gap + 4, u0, u0, h + 5, 7, 7 + h);
      }
      for (const s of [1820, 1900]) {
        const u0 = C('bigair', s);
        this.tabletop(s, u0, 9, 8, 12, 2.6, 8);
        this.tokenLine(s + 9, s + 26, u0, u0, 2.4, 5, 3);
      }
    }

    // ------------------------------------------------ PILLOW WOODS
    {
      const r = R.pillow;
      for (const sc of [1360, 1480, 1600, 1720, 1840]) {
        const c = r.at(sc, {});
        const n = 9 + rng.int(0, 5);
        for (let i = 0; i < n; i++) {
          const s = sc + rng.range(-22, 22), u = c.u + rng.range(-0.7, 0.7) * c.w;
          const rr = rng.range(2.4, 4.2), h = rr * rng.range(0.35, 0.6);
          if (this.pillows.some((p) => Math.hypot(p.sc - s, p.u0 - u) < p.r + rr + 1.5)) continue;
          this.pillow(s, u, rr, h);
          if (rng() < 0.5) this.tokens.push({ s, u, y: this.ground(s, u) + h + 1.6 });
        }
      }
      for (const [s, off, d] of [[1420, 6, 3], [1545, -8, 4], [1665, 4, 3.5], [1790, -5, 4.5]]) {
        const u0 = C('pillow', s) + off;
        this.cliff(s, u0, 14, d);
      }
      for (const [s, off] of [[1395, -12], [1520, 10], [1640, -10], [1760, 12], [1880, 0]]) {
        const u = C('pillow', s) + off;
        if (this._free(s - 2, s + 18, u - 2, u + 2)) {
          this.rail(s, 14, u, 0.5, 'rail', 'log');
          this.tokenLine(s + 2, s + 12, u, u, 1.5, 3);
        }
      }
    }

    // ------------------------------------------------ RIDGE & HAMLET
    {
      const r = R.ridge;
      for (const s of [1320, 1440, 1560, 1680]) {
        const c = r.at(s, {});
        this.rollers(s, 4, 11, 1.1, c.u, 18);
        const side = s % 240 === 0 ? 1 : -1;
        this.spine(s + 50, 40, c.u + side * c.w * 0.55, 2.2, 5);
        this.tokenLine(s + 55, s + 85, c.u + side * c.w * 0.55, c.u + side * c.w * 0.55, 3.2, 5);
      }
      const roofs = [];
      for (const [s, off, w, d, h] of [[1820, -30, 11, 9, 4], [1850, 32, 12, 9, 4.5], [1905, -28, 10, 8, 3.5], [1935, 30, 11, 8, 4], [1990, -32, 12, 10, 4.5], [2010, 34, 10, 8, 4]]) {
        roofs.push(this.chalet(s, C('ridge', s) + off, w, d, h, { color: rng.pick([0x6e4c33, 0x7a5638, 0x8a6a4a]) }));
      }
      for (const s of [1870, 1955]) {
        const u = C('ridge', s);
        this.kicker(s, u, 9, 2.7, 5.5);
        roofs.push(this.chalet(s + 18, u, 12, 7, 2.6, { color: 0x6b4a32, rise: 1.6 }));
        this.tokenLine(s + 9, s + 30, u, u, 3.4, 6, 1.5);
      }
      for (const b of roofs) for (let k = -1; k <= 1; k++) this.tokens.push({ s: b.s + k * b.w * 0.3, u: b.u, y: b.roofH(b.s + k * b.w * 0.3, b.u) + 1.2 });
      this.rail(1780, 22, C('ridge', 1780), 0.85, 'rail', 'metal');
      this.kicker(1774, C('ridge', 1780), 5, 0.7, 2.6, 'feeder');
    }

    // ------------------------------------------------ BASE VILLAGE
    {
      const u0 = 0;
      this.tabletop(2060, u0 - 40, 10, 8, 12, 2.8, 9);
      this.tokenLine(2070, 2090, u0 - 40, u0 - 40, 2.6, 5, 3);
      this.kicker(2066, u0 + 40, 10, 2.2, 7);
      this.tokenLine(2080, 2100, u0 + 40, u0 + 40, 3, 5, 4);
      const cols = [0x6b4a32, 0x7a5638, 0x5a3e2a, 0x8a6a4a, 0xb8a58a];
      for (let i = 0; i < 30; i++) {
        const side = i % 2 ? 1 : -1;
        const s = 2090 + rng.range(-40, 150);
        const u = side * rng.range(110, 330);
        if (!this._free(s - 8, s + 8, u - 8, u + 8, 2)) continue;
        this.chalet(s, u, rng.range(9, 14), rng.range(7, 11), rng.range(4, 7), { color: rng.pick(cols) });
      }
      this.chalet(2165, 285, 22, 13, 7, { kind: 'station', color: 0x7a5638 });
    }

    // ------------------------------------------------ lifts (visual + pylons as obstacles)
    this.lifts.push({ a: { s: 2165, u: 300 }, b: { s: 1218, u: 326 } });
    this.lifts.push({ a: { s: 1196, u: 352 }, b: { s: 4, u: 96 } });

    // ------------------------------------------------ backcountry stash spots between routes
    for (let i = 0; i < 26; i++) {
      const s = rng.range(220, 1950), u = rng.range(-380, 380);
      if (this.routeAt(s, u)) continue;
      if (!this._free(s - 4, s + 14, u - 6, u + 6, 6)) continue;
      if (rng() < 0.5) {
        this.kicker(s, u, 8, 1.8 + rng() * 0.8, 5);
        this.tokenLine(s + 12, s + 28, u, u, 3, 3, 3);
      } else {
        this.pillow(s, u, 3.5, 1.8);
        this.tokens.push({ s, u, y: this.ground(s, u) + 3.4 });
      }
    }
  }

  // ---------------------------------------------------------------- trees and rocks
  _scatter() {
    const rng = mulberry32(this.stage.seed + 77);
    const addObst = (o) => this.addObstacle(o);
    const feats = this.features.filter((f) => f.bs0 !== undefined && f.type !== 'roller');
    const featNear = (s, u, m) => {
      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        if (s > f.bs0 - m && s < f.bs1 + m && u > f.bu0 - m && u < f.bu1 + m) return true;
      }
      return false;
    };
    const liftNear = (s, u, m) => this.lifts.some((L) => {
      const t = clamp((s - L.a.s) / (L.b.s - L.a.s), 0, 1);
      const lu = L.a.u + (L.b.u - L.a.u) * t;
      return Math.abs(u - lu) < m && s < Math.max(L.a.s, L.b.s) + 10 && s > Math.min(L.a.s, L.b.s) - 10;
    });
    this.liftNear = liftNear;
    const signNear = (s, u) => this.signs.some((g) => Math.hypot(g.s - s, g.u - u) < 14) || this.arches.some((a) => Math.abs(a.s - s) < 8 && Math.abs(a.u - u) < a.w / 2 + 6);
    const bldNear = (s, u, m) => this.buildings.some((b) => Math.abs(s - b.s) < b.w / 2 + m && Math.abs(u - b.u) < b.d / 2 + m);
    // pylons
    for (const L of this.lifts) {
      L.pylons = [];
      const len = Math.hypot(L.b.s - L.a.s, L.b.u - L.a.u);
      const n = Math.max(2, Math.round(len / 70));
      for (let i = 0; i <= n; i++) {
        let t = i / n;
        let s = L.a.s + (L.b.s - L.a.s) * t, u = L.a.u + (L.b.u - L.a.u) * t;
        // keep towers out of the pistes where possible
        for (let k = 0; k < 8 && i > 0 && i < n && (this.routeAt(s, u)?.x ?? 2) < 1.1; k++) {
          t = clamp(t + (k % 2 ? -1 : 1) * (k + 1) * 0.012, 0, 1);
          s = L.a.s + (L.b.s - L.a.s) * t; u = L.a.u + (L.b.u - L.a.u) * t;
        }
        const top = this.ground(s, u) + 11;
        L.pylons.push({ s, u, top });
        if (i > 0 && i < n) addObst({ s, u, r: 0.6, top, kind: 'pylon' });
      }
    }
    // lookout towers, signposts and arch pillars
    for (const L of this.lookouts) addObst({ s: L.s, u: L.u, r: 4.4, top: this.ground(L.s, L.u) + 12, kind: 'tower' });
    for (const g of this.signs) addObst({ s: g.s, u: g.u, r: 0.35, top: this.ground(g.s, g.u) + 3.4, kind: 'post' });
    for (const a of this.arches) for (const sd of [-1, 1]) addObst({ s: a.s, u: a.u + sd * a.w / 2, r: 0.55, top: this.ground(a.s, a.u + sd * a.w / 2) + 9, kind: 'post' });
    // forest
    const step = 8;
    for (let s = -90; s < 2360; s += step) {
      for (let u = -520; u < 520; u += step) {
        const ss = s + rng.range(-3.4, 3.4), uu = u + rng.range(-3.4, 3.4);
        let dens = 0.55 + 0.6 * fbm2(uu / 120 + 3, ss / 120, 3);
        const ra = this.routeAt(ss, uu, 0);
        if (ra) {
          // glades in the woods routes, clean pistes elsewhere
          if (ra.route.woods) dens = ra.x < 0.25 ? 0 : dens * 0.32;
          else if (ra.route.halfpipe && ss > ra.route.halfpipe[0] && ss < ra.route.halfpipe[1]) dens = ra.x < 1.05 ? 0 : dens;
          else dens = ra.x < 0.85 ? 0 : dens * (ra.x - 0.85) * 3;
        }
        for (const a of this.areas) if (ss > a.s0 - 25 && ss < a.s1 + 15 && Math.abs(uu) < 360) dens *= Math.abs(uu) < 250 ? 0 : 0.08;
        if (ss < 140 && Math.abs(uu) < 120 + ss) dens = 0;
        if (Math.abs(uu) > 470) dens *= 0.4;
        if (dens <= 0 || rng() > dens) continue;
        if (featNear(ss, uu, 4) || liftNear(ss, uu, 7) || signNear(ss, uu) || bldNear(ss, uu, 4)) continue;
        const g = this.ground(ss, uu);
        // no trees on steep rock
        const sl = Math.abs(this.ground(ss + 1, uu) - this.ground(ss - 1, uu)) / 2 + Math.abs(this.ground(ss, uu + 1) - this.ground(ss, uu - 1)) / 2;
        if (sl > 0.95) continue;
        const sc = rng.range(0.75, 1.45);
        const t = { s: ss, u: uu, y: g, sc, kind: rng.int(0, 1), rot: rng() * 6.28 };
        this.trees.push(t);
        if (Math.abs(uu) < this.uMax) addObst({ s: ss, u: uu, r: 0.75 * sc, top: g + 6.5 * sc, kind: 'tree' });
      }
    }
    // rocks: outcrops on steep ground and between routes
    for (let i = 0; i < 1400; i++) {
      const s = rng.range(-100, 2350), u = rng.range(-560, 560);
      const ra = this.routeAt(s, u);
      if (ra && ra.x < 1.0) continue;
      if (featNear(s, u, 4) || liftNear(s, u, 7) || bldNear(s, u, 4) || signNear(s, u)) continue;
      const sl = Math.abs(this.ground(s + 1, u) - this.ground(s - 1, u)) / 2 + Math.abs(this.ground(s, u + 1) - this.ground(s, u - 1)) / 2;
      if (sl < 0.35 && rng() < 0.7) continue;
      const sc = rng.range(1.2, 4.5) * (Math.abs(u) > 440 ? 2.5 : 1);
      const g = this.ground(s, u);
      this.rocks.push({ s, u, y: g, sc, rot: rng() * 6.28, kind: rng.int(0, 3) });
      if (Math.abs(u) < this.uMax && sc < 6) addObst({ s, u, r: sc * 0.95, top: g + sc * 0.65, kind: 'rock' });
    }
  }
}

export { MountainTerrain as OpenTerrain };
