import { noise1, smoothstep, clamp } from '../core/utils.js';

// Street plans and landmarks of the open-world city districts. Each layout
// describes its streets (named routes down the hill), cross streets and areas,
// the fall-line profile, and a build() that places buildings and features with
// the CityTerrain toolkit.

const STYLE = { glass: 0, concrete: 1, old: 2, tower: 3, shop: 4, plain: 5, timber: 6 };

// ===================================================================== NEON SHINJUKU
const NEON = {
  sMin: -70, sMax: 1530, uHalf: 250, margin: 80,
  length: 1460, finishS: 1430,
  spawn: { s: 16, u: 26 },
  sidewalk: 3,
  defaultZone: { name: 'BACKSTREETS', jp: '裏通り' },
  grade(s) {
    if (s < 30) return 0.03;
    if (s < 1360) return 0.03 + (0.115 + 0.035 * noise1(s / 120 + 2.2) + 0.05 * smoothstep(380, 420, s) * (1 - smoothstep(500, 540, s)) + 0.05 * smoothstep(900, 940, s) * (1 - smoothstep(990, 1030, s))) * smoothstep(30, 70, s);
    if (s < 1470) return 0.02 + 0.13 * (1 - smoothstep(1360, 1400, s));
    return 0;
  },
  streets: [
    { id: 'shrine', name: 'SHRINE STEPS', jp: '神社坂', diff: 'mid', color: 0xff5a3a, u: -196, hw: 4, sw: 2, paved: 0.9 },
    { id: 'omoide', name: 'OMOIDE ALLEY', jp: '思い出横丁', diff: 'mid', color: 0xffb03a, u: -126, hw: 2.8, sw: 0.6, paved: 0.84 },
    { id: 'kabuki', name: 'KABUKI STREET', jp: '歌舞伎通り', diff: 'easy', color: 0xff2d8a, u: -56, hw: 6.5 },
    { id: 'main', name: 'NEON AVENUE', jp: 'ネオン大通り', diff: 'easy', color: 0x2de2ff, u: 28, hw: 12 },
    { id: 'back', name: 'ROOFTOP LINE', jp: '屋上ライン', diff: 'hard', color: 0x9d4dff, u: 112, hw: 4.5, sw: 2, noNpc: true },
    { id: 'rail', name: 'RAILSIDE', jp: '線路沿い', diff: 'mid', color: 0x3dff8b, u: 192, hw: 6 },
  ],
  decals: { road: ['kabuki', 'main', 'back', 'rail'], crossRoad: true, scramble: { s: 700, u: 28, ds: 9, du: 12 } },
  cross: [96, 212, 330, 452, 580, 826, 948, 1070, 1192, 1312].map((s) => ({ s, hw: 5.5 })).concat([{ s: 700, hw: 9, name: 'SCRAMBLE' }]),
  areas: [
    { name: 'HILLTOP SHRINE', jp: '丘の上の社', s0: -200, s1: 42 },
    { name: 'SCRAMBLE CROSSING', jp: 'スクランブル交差点', s0: 662, s1: 742, u0: -92, u1: 82 },
    { name: 'STATION SQUARE', jp: '駅前広場', s0: 1368, s1: 9999 },
    { name: 'ROOFTOP LINE', jp: '屋上ライン', s0: 60, s1: 1360, u0: 119, u1: 137, roof: true },
  ],
  build(T) {
    const rng = T.rng;
    const st = (id) => T.street(id);
    // open spaces
    T.reserve(-200, 44, -400, 400, 'top');
    T.reserve(662, 742, -92, 82, 'scramble');
    T.reserve(1366, 1600, -400, 400, 'station');
    T.reserve(54, 1366, 119, 137, 'rooftops');
    // ---- buildings: dense mid-rise blocks, taller towards the station
    T.fillBlocks({
      lot: [8, 16], depth: [10, 20], alley: 0.55, gap: 0.15, district: 'neon',
      height(s, u, r) {
        const core = 1 - smoothstep(60, 240, Math.abs(u - 20));
        const big = smoothstep(500, 1300, s);
        return r.range(14, 30) + core * r.range(0, 30) + big * r.range(0, 25) + (r() < 0.08 ? 25 : 0);
      },
      style: (s, u, r) => (r() < 0.25 ? STYLE.glass : r() < 0.5 ? STYLE.shop : STYLE.concrete),
      color: (r) => r.pick([0x262433, 0x30303e, 0x3a3346, 0x22262f, 0x403a38, 0x4a4650, 0x2d3138]),
      lit: (r) => clamp(0.42 * r.range(0.6, 1.4), 0, 0.95),
    });
    // ---- low eaves in Omoide Alley (rideable little roofs on both sides)
    const om = st('omoide');
    for (let s = 60; s < 1350; s += rng.range(9, 14)) {
      if (T.onCross(s, 2) || T.onCross(s + 8, 2)) continue;
      for (const side of [-1, 1]) {
        const c = om.at(s, {});
        const u0 = c.u + side * (c.w + 0.6 + 1.6);
        if (rng() < 0.7) T.props.chochin.push({ s, u: c.u, w: c.w * 2 + 1.2, y: T.ground(s, c.u) + 3.6 });
        void u0;
      }
    }
    for (let s = 110; s < 1340; s += rng.range(40, 70)) {
      if (T.onCross(s, 4) || T.onCross(s + 14, 4)) continue;
      const c = om.at(s, {});
      if (rng() < 0.5) T.railLine(s, c.u + rng.range(-1, 1), rng.range(10, 14), 0.55, 'ledge', 'bench');
      else { T.kicker(s, c.u, 5, 0.8, 3.2); T.tokenLine(s + 6, s + 16, c.u, c.u, 2.2, 3, 1.5); }
    }
    // ---- shrine steps: terraces with stairs, torii at every flight
    const sh = st('shrine');
    for (let s = 120; s < 1320; s += rng.range(95, 130)) {
      if (T.onCross(s - 20, 4) || T.onCross(s + 12, 4)) { s -= 60; continue; }
      const c = sh.at(s, {});
      T.terrace(s - 26, s, c.u, c.w * 2, { stairLen: 9 });
      T.props.torii.push({ s: s - 24, u: c.u, w: c.w * 2 + 0.8, h: 6.2, y: T.ground(s - 24, c.u) + T.height(s - 24, c.u) - T.ground(s - 24, c.u) });
      T.tokenLine(s + 1, s + 12, c.u, c.u, 2.6, 4, 2.5);
      for (const sd of [-1, 1]) T.props.stoneLanterns.push({ s: s - 21, u: c.u + sd * (c.w + 1.2), y: T.height(s - 21, c.u) });
    }
    // ---- Kabuki street: neon gates, kickers, boxes, parked cars on one side
    const kb = st('kabuki');
    T.decor.neonGates.push({ s: 108, u: kb.centre(108), w: kb.at(108, {}).w * 2 + 4, text: '歌舞伎 一番街', color: 0xff2d6a });
    T.decor.neonGates.push({ s: 966, u: kb.centre(966), w: kb.at(966, {}).w * 2 + 4, text: 'KABUKI 二番街', color: 0x2de2ff });
    T.parkedRow(kb, 120, 1340, 1, { car: 0.5, bank: 0.4 });
    let n = 0;
    for (let s = 140; s < 1330; s += rng.range(55, 80)) {
      if (T.onCross(s, 6) || T.onCross(s + 16, 6)) continue;
      const u = kb.centre(s) - 2;
      if (n++ % 3 === 2) T.railLine(s, u, rng.range(12, 18), 0.7, 'ledge', 'box');
      else {
        const h = rng.range(1.2, 2.0);
        T.kicker(s, u, 7, h, 5);
        T.tokenLine(s + 10, s + 26, u, u, h + 2.4, 5, 2.5);
      }
    }
    // ---- Neon Avenue: parked taxis, plowed banks, a line of jumps down the middle
    const mn = st('main');
    T.parkedRow(mn, 60, 1350, -1, { car: 0.55, bank: 0.55, colors: [0xf2c20f, 0x1a1a1f, 0xe8e8e8, 0x2e6b4a] });
    T.parkedRow(mn, 60, 1350, 1, { car: 0.5, bank: 0.55, colors: [0xf2c20f, 0x1a1a1f, 0xe8e8e8, 0xb8261e] });
    n = 0;
    for (let s = 120; s < 1320; s += rng.range(70, 95)) {
      if (T.onCross(s, 5) || T.onCross(s + 24, 5) || (s > 640 && s < 760)) continue;
      const u = mn.centre(s) + (n % 2 ? 5 : -5);
      if (n++ % 3 === 1) {
        T.tabletop(s, u, 8, 6, 10, 2.2, 7);
        T.tokenLine(s + 8, s + 22, u, u, 2.4, 5, 2.5);
      } else {
        const h = rng.range(1.6, 2.6);
        T.kicker(s, u, 8, h, 6);
        T.tokenLine(s + 11, s + 30, u, u, h + 2.8, 5, 3);
      }
    }
    // the big one: a mega jump over the scramble crossing
    T.bigJump(646, mn.centre(646), 15, 3.2, 10, 30, 30, 4.8);
    T.decor.footbridges.push({ s: 272, u: mn.centre(272), w: mn.at(272, {}).w * 2 + 6 }, { s: 1010, u: mn.centre(1010), w: mn.at(1010, {}).w * 2 + 6 });
    // ---- rooftop line
    T.rooftopLine(128, 58, 1350, 16, { above: 8.5, len: [20, 34], gap: [2.5, 4.5], color: (r) => r.pick([0x34323e, 0x3c3a44, 0x2b2f38]) });
    // ---- railside: rails along the guard fence, banks, viaduct overhead
    const rl = st('rail');
    T.parkedRow(rl, 70, 1350, -1, { car: 0.35, bank: 0.6 });
    for (let s = 150; s < 1320; s += rng.range(80, 120)) {
      if (T.onCross(s - 6, 4) || T.onCross(s + 30, 4)) continue;
      T.railLine(s, rl.centre(s) + 3, rng.range(18, 28), 0.85, 'rail', 'metal');
    }
    T.structures.push({ type: 'viaduct', along: 's', u: 222, w: 12, s0: -120, s1: 1600, h: 9 });
    for (let s = -100; s < 1600; s += 24) T.addObstacle({ s, u: 222, r: 1.4, top: T.ground(s, 222) + 9, kind: 'pier' });
    // ---- scramble crossing: giant screens, open snow plaza with a few hits
    T.decor.landmarks.push({ type: 'scramble', s: 702, u: -5, w: 174, d: 80 });
    {
      // tall buildings whose faces look onto the plaza get giant screens
      const around = T.buildings.filter((b) => b.H > 22 && b.s0 !== undefined).map((b) => {
        if (b.u1 > -92 && b.u0 < 82 && b.s1 > 654 && b.s1 <= 663) return { b, face: 'down' };
        if (b.u1 > -92 && b.u0 < 82 && b.s0 >= 741 && b.s0 < 750) return { b, face: 'up' };
        if (b.s1 > 662 && b.s0 < 742 && b.u1 <= -91 && b.u1 > -100) return { b, face: 'right' };
        if (b.s1 > 662 && b.s0 < 742 && b.u0 >= 81 && b.u0 < 90) return { b, face: 'left' };
        return null;
      }).filter(Boolean).sort((x, y) => y.b.H - x.b.H);
      for (const { b, face } of around.slice(0, 7)) {
        const along = face === 'up' || face === 'down' ? b.d : b.w;
        const sw = Math.min(along - 2, 16);
        if (sw < 7) continue;
        const y = b.base + Math.min(b.H - sw * 0.3 - 2, 18);
        if (face === 'down') T.decor.screens.push({ s: b.s1 + 0.12, u: b.u, y, w: sw, yaw: Math.PI, seed: rng() });
        else if (face === 'up') T.decor.screens.push({ s: b.s0 - 0.12, u: b.u, y, w: sw, yaw: 0, seed: rng() });
        else if (face === 'right') T.decor.screens.push({ s: b.s, u: b.u1 + 0.12, y, w: sw, yaw: Math.PI / 2, seed: rng() });
        else T.decor.screens.push({ s: b.s, u: b.u0 - 0.12, y, w: sw, yaw: -Math.PI / 2, seed: rng() });
      }
    }
    T.kicker(684, -60, 6, 1.4, 6);
    T.tokenLine(692, 708, -60, -60, 3, 5, 2);
    T.railLine(684, -20, 16, 0.8, 'ledge', 'box');
    // ---- station square at the bottom and the station itself
    T.block(1474, 1540, -210, 210, 24, { style: STYLE.glass, face: { du: 0, ds: -1 }, seed: 0.3, lit: 0.6, color: 0x3a4250, kind: 'station', roofKind: 'flat' });
    T.decor.landmarks.push({ type: 'station', s: 1474, u: 0, w: 420, name: '新宿駅  SHINJUKU STA.' });
    T.tabletop(1376, -60, 9, 8, 12, 2.6, 9);
    T.kicker(1380, 90, 9, 2.2, 7);
    T.tokenLine(1392, 1410, 90, 90, 3, 5, 3);
    // ---- the hilltop: shrine and start plaza
    T.decor.landmarks.push({ type: 'shrine', s: -40, u: -150 });
    T.props.torii.push({ s: 30, u: -160, w: 7, h: 7, y: T.ground(30, -160) });
    // ---- lamps, signals, poles, vending
    for (const r of T.routes) T.lampsAlong(r, r.id === 'omoide' ? 1e9 : r.id === 'shrine' ? 30 : 24, { style: r.id === 'shrine' ? 'lantern' : 'city' });
    for (const c of T.cross) for (const id of ['main', 'kabuki']) {
      const r = st(id), cu = r.centre(c.s), w = r.at(c.s, {}).w;
      for (const sd of [-1, 1]) T.props.signals.push({ s: c.s - c.hw - 1.5, u: cu + sd * (w + 1.2), y: T.ground(c.s - c.hw - 1.5, cu), side: sd });
    }
    for (const id of ['omoide', 'shrine', 'back']) {
      const r = st(id);
      for (let s = 30; s < 1360; s += 32) {
        if (T.onCross(s, 2)) continue;
        const c = r.at(s, {});
        const u = c.u + (c.w + (r.sw ?? 3) - 0.4);
        T.props.poles.push({ s, u, y: T.ground(s, u), street: id });
      }
    }
    for (const id of ['kabuki', 'omoide', 'main']) {
      const r = st(id);
      for (let s = 80; s < 1340; s += rng.range(25, 60)) {
        if (T.onCross(s, 2)) continue;
        const c = r.at(s, {});
        const side = rng() < 0.5 ? -1 : 1;
        const u = c.u + side * (c.w + (r.sw ?? 3) - 0.5);
        if (T.height(s, u) - T.ground(s, u) > 0.2) continue;
        T.props.vending.push({ s, u, y: T.ground(s, u), face: -side, n: rng.int(1, 3) });
      }
    }
    // signposts at the start and halfway
    T.sign(36, -6, T.routes.slice(0, 6).map((r) => ({ route: r })), { big: true });
  },
};


// ===================================================================== GOLDEN SKYLINE
const GOLDEN = {
  sMin: -80, sMax: 1720, uHalf: 280, margin: 90,
  length: 1640, finishS: 1596, sEnd: 1648,
  spawn: { s: 18, u: -71 },
  sidewalk: 4,
  defaultZone: { name: 'DOWNTOWN', jp: 'ダウンタウン' },
  skyline: { h: [50, 170], styles: [0, 0, 3, 1], colors: [0x5a6070, 0x7a7f8a, 0x8c7a6a, 0x4a5262, 0x9a9590], lit: 0.15 },
  noSkylineBelow: true,
  grade(s) {
    if (s < 40) return 0.02;
    if (s < 1530) return 0.02 + (0.12 + 0.03 * noise1(s / 150 + 7.7) + 0.05 * smoothstep(240, 280, s) * (1 - smoothstep(330, 370, s))) * smoothstep(40, 90, s);
    if (s < 1652) return 0.01 + 0.13 * (1 - smoothstep(1530, 1570, s));
    return 0.6;
  },
  streets: [
    { id: 'park', name: 'PARK DRIVE', jp: '公園通り', diff: 'easy', color: 0x6ccf6a, u: -224, hw: 6 },
    { id: 'blvd', name: 'GOLDEN BOULEVARD', jp: '黄金大通り', diff: 'easy', color: 0xffb43a, u: -80, hw: 15, median: 1.6 },
    { id: 'plaza', name: 'PLAZA STEPS', jp: '広場の階段', diff: 'mid', color: 0x7ad8ff, u: 36, hw: 8 },
    { id: 'canal', name: 'CANAL RUN', jp: '運河ハーフパイプ', diff: 'mid', color: 0x3aa0ff, u: 128, hw: 11, paved: 0.95 },
    { id: 'skyway', name: 'SKYWAY', jp: '高架ハイウェイ', diff: 'hard', color: 0xff6a3a, u: 224, hw: 8 },
  ],
  decals: { road: ['park', 'blvd', 'skyway'], crossRoad: true },
  cross: [130, 262, 392, 528, 664, 800, 936, 1072, 1208, 1344, 1470].map((s) => ({ s, hw: 7 })),
  areas: [
    { name: 'SKY TOWER PLAZA', jp: '展望タワー広場', s0: -200, s1: 44 },
    { name: 'CENTRAL PARK', jp: 'セントラルパーク', s0: 400, s1: 920, u0: -210, u1: -103 },
    { name: 'WATERFRONT', jp: 'ウォーターフロント', s0: 1540, s1: 9999 },
    { name: 'SKYWAY', jp: '高架ハイウェイ', s0: 40, s1: 1500, u0: 214, u1: 234, under: false, sky: true },
  ],
  carves: [{ along: 's', u: 128, hw: 6, bank: 4.5, depth: 4.6, s0: 70, s1: 1520 }],
  terrainMod(s, u) {
    // rolling lawns in Central Park, flat around the pond
    if (s > 400 && s < 920 && u > -210 && u < -103) {
      const k = Math.min(1, (s - 400) / 30, (920 - s) / 30, (u + 210) / 20, (-103 - u) / 20);
      const pond = smoothstep(46, 60, Math.hypot(s - 650, u + 158));
      return k * pond * (1.6 * Math.sin(s * 0.045 + 1.3) * Math.cos(u * 0.06) + 0.9 * Math.sin(s * 0.11 + u * 0.05));
    }
    return 0;
  },
  build(T) {
    const rng = T.rng;
    const st = (id) => T.street(id);
    T.reserve(-200, 46, -400, 400, 'top');
    T.reserve(398, 922, -212, -101, 'park');
    T.reserve(1538, 1800, -400, 400, 'waterfront');
    T.reserve(40, 1520, 212, 236, 'skyway');
    // ---- towers of glass and stone
    T.fillBlocks({
      lot: [18, 34], depth: [16, 28], alley: 0.45, gap: 0.2, district: 'golden',
      height(s, u, r) {
        const core = 1 - smoothstep(40, 260, Math.abs(u - 20));
        const down = smoothstep(200, 1300, s);
        return r.range(26, 60) + core * r.range(10, 80) + down * r.range(0, 40);
      },
      style: (s, u, r) => (r() < 0.45 ? STYLE.glass : r() < 0.7 ? STYLE.tower : STYLE.concrete),
      color: (r) => r.pick([0x5a6070, 0x7a7f8a, 0x8c7a6a, 0x4a5262, 0x9a9590, 0x6a6058]),
      lit: (r) => clamp(0.18 * r.range(0.6, 1.4), 0, 0.95),
    });
    // ---- Golden Boulevard: planted median, two carriageways of jumps
    const bv = st('blvd');
    for (let s = 60; s < 1500; s += 14) {
      if (T.onCross(s, 3)) continue;
      T.props.trees.push({ s, u: bv.centre(s), y: T.ground(s, bv.centre(s)), sc: rng.range(0.8, 1.05), rot: rng() * 6, lights: 0xffd890 });
    }
    T.parkedRow(bv, 70, 1500, -1, { car: 0.4, bank: 0.6 });
    T.parkedRow(bv, 70, 1500, 1, { car: 0.4, bank: 0.6 });
    let n = 0;
    for (let s = 150; s < 1460; s += rng.range(70, 100)) {
      if (T.onCross(s, 6) || T.onCross(s + 28, 6)) continue;
      const u = bv.centre(s) + (n++ % 2 ? 7.5 : -7.5);
      if (n % 3 === 0) { T.tabletop(s, u, 9, 7, 11, 2.4, 7); T.tokenLine(s + 9, s + 24, u, u, 2.6, 5, 3); }
      else { const h = rng.range(1.8, 2.8); T.kicker(s, u, 9, h, 6); T.tokenLine(s + 12, s + 32, u, u, h + 3, 5, 3.5); }
    }
    // ---- Plaza Steps: terraced plazas with stairs, rails, ledges and planters
    const pl = st('plaza');
    for (let s = 160; s < 1460; s += rng.range(80, 110)) {
      if (T.onCross(s - 30, 4) || T.onCross(s + 12, 4)) continue;
      const c = pl.at(s, {});
      T.terrace(s - 34, s, c.u, c.w * 2 - 1, { stairLen: 10 });
      T.tokenLine(s + 1, s + 13, c.u, c.u, 3, 4, 3);
      // ledges and planters on the plaza level
      T.rail(s - 28, 14, c.u - 4.5, 0.55, 'ledge', 'box', { onTop: true });
      T.tokenLine(s - 26, s - 16, c.u - 4.5, c.u - 4.5, 1.6, 3);
      T.props.trees.push({ s: s - 20, u: c.u + 4.8, y: T.height(s - 20, c.u + 4.8), sc: 0.75, rot: rng() * 6 });
    }
    // ---- Canal Run: a frozen canal you ride like a halfpipe, bridges at every crossing
    const cn = st('canal');
    T.halfpipes.push({ route: cn, s0: 80, s1: 1510, w: 6, x0: 0.9, x1: 1.9 });
    T.iceAreas.push({ s0: 70, s1: 1520, u0: 128 - 6.5, u1: 128 + 6.5 });
    for (const c of T.cross) {
      if (c.s < 80 || c.s > 1510) continue;
      const y = T.baseY(c.s) + 0.15;
      T.slab(c.s - c.hw - 1, c.s + c.hw + 1, 128 - 11, 128 + 11, () => y, { kind: 'bridge' });
      T.structures.push({ type: 'bridge', along: 'u', s: c.s, half: c.hw + 1, u0: 117, u1: 139, y });
    }
    for (let s = 100; s < 1500; s += 22) {
      const side = Math.round(s / 22) % 2 ? 1 : -1;
      if (T.cross.some((c) => Math.abs(c.s - s) < 14)) continue;
      for (let k = 0; k < 3; k++) T.tokens.push({ s: s + k * 3, u: 128 + side * (5 + k), y: T.ground(s + k * 3, 128 + side * (5 + k)) + 1.6 });
    }
    T.structures.push({ type: 'canal', u: 128, hw: 6, bank: 4.5, s0: 70, s1: 1520 });
    // ---- Skyway: elevated highway, broken in the middle
    const sk = st('skyway');
    const hAt = (s) => Math.min(13, Math.max(0, (s - 50) * 0.075)) * (1 - smoothstep(1380, 1500, s));
    const deckY = (s) => T.baseY(s) + hAt(s) + 0.05;
    const gap = [892, 916];
    T.slab(40, gap[0], 214, 234, (s) => deckY(s), { kind: 'skyway' });
    T.slab(gap[1], 1505, 214, 234, (s) => deckY(s), { kind: 'skyway' });
    for (const sd of [-1, 1]) {
      T.slab(60, gap[0], 224 + sd * 10 - 0.25, 224 + sd * 10 + 0.25, (s) => deckY(s) + 1.0, { kind: 'barrier' });
      T.slab(gap[1], 1480, 224 + sd * 10 - 0.25, 224 + sd * 10 + 0.25, (s) => deckY(s) + 1.0, { kind: 'barrier' });
    }
    T.structures.push({ type: 'skyway', u: 224, w: 20, s0: 40, s1: 1505, gap, deckY, hAt });
    const onDeck = (s) => deckY(s);
    T.kicker(gap[0] - 13, 224, 13, 2.8, 9, 'mega', onDeck).mega = true;
    T.tokenLine(gap[0], gap[1] + 6, 224, 224, 6, 7, 6);
    for (let s = 120; s < 1440; s += rng.range(45, 80)) {
      if (s > gap[0] - 40 && s < gap[1] + 70) continue;
      const u = 224 + rng.range(-5, 5);
      if (rng() < 0.5) T.car(s, u, { kind: 'car', len: 4.4, w: 1.9, h: 1.45, color: rng.pick([0xb8261e, 0xe8e8e8, 0x1a1a1f]), base: onDeck });
      else { T.kicker(s, u, 7, 1.6, 5, 'kicker', onDeck); T.tokenLine(s + 10, s + 24, u, u, 3.2, 4, 2.5); }
    }
    for (let s = 60; s < 1500; s += 30) if (hAt(s) > 3) T.addObstacle({ s, u: 224, r: 1.6, top: deckY(s) - 1.2, kind: 'pier' });
    // ---- Park Drive and Central Park
    const pd = st('park');
    T.parkedRow(pd, 80, 1500, 1, { car: 0.35, bank: 0.5 });
    for (let s = 70; s < 1500; s += 18) {
      if (T.onCross(s, 3)) continue;
      T.props.trees.push({ s, u: pd.centre(s) - pd.at(s, {}).w - 2.5, y: T.ground(s, pd.centre(s) - 8.5), sc: rng.range(0.85, 1.2), rot: rng() * 6 });
    }
    for (let i = 0; i < 160; i++) {
      const s = rng.range(410, 910), u = rng.range(-205, -108);
      if (Math.hypot(s - 650, (u + 158) * 1.4) < 62) continue; // the pond
      if (Math.abs(u + 156) < 5 || Math.abs(s - 560) < 5 || Math.abs(s - 780) < 5) continue; // paths
      T.props.trees.push({ s, u, y: T.ground(s, u), sc: rng.range(0.8, 1.4), rot: rng() * 6, lights: rng() < 0.15 ? 0xffd890 : 0 });
    }
    T.iceAreas.push({ s: 650, u: -158, r: 44 });
    T.structures.push({ type: 'pond', s: 650, u: -158, r: 44 });
    for (const [s, u, h] of [[470, -170, 1.6], [520, -130, 2.2], [740, -185, 1.8], [850, -140, 2.4]]) { T.kicker(s, u, 7, h, 6); T.tokenLine(s + 10, s + 24, u, u, h + 2.5, 4, 2.5); }
    T.rail(560, 30, -156, 0.6, 'ledge', 'box');
    // ---- Sky Tower plaza at the top and the waterfront at the bottom
    T.decor.landmarks.push({ type: 'skytower', s: -46, u: 60 });
    T.addObstacle({ s: -46, u: 60, r: 9, top: 400, kind: 'tower' });
    T.decor.landmarks.push({ type: 'sea', s: 1652 });
    T.structures.push({ type: 'promenade', s0: 1540, s1: 1650 });
    for (let u = -260; u <= 260; u += 26) T.props.lamps.push({ s: 1620, u, y: T.ground(1620, u), dir: 1, style: 'city' });
    T.tabletop(1548, -80, 10, 8, 12, 2.8, 10);
    T.tokenLine(1558, 1578, -80, -80, 3, 5, 3);
    T.kicker(1552, 36, 9, 2.4, 7);
    // ---- street lamps and signals
    for (const r of T.routes) if (r.id !== 'canal') T.lampsAlong(r, r.id === 'blvd' ? 30 : 28);
    for (const c of T.cross) for (const id of ['blvd', 'plaza']) {
      const r = st(id), cu = r.centre(c.s), w = r.at(c.s, {}).w;
      for (const sd of [-1, 1]) T.props.signals.push({ s: c.s - c.hw - 1.5, u: cu + sd * (w + 1.2), y: T.ground(c.s - c.hw - 1.5, cu), side: sd });
    }
    T.decor.footbridges.push({ s: 600, u: bv.centre(600), w: bv.at(600, {}).w * 2 + 8 });
    T.sign(38, -60, T.routes.map((r) => ({ route: r })), { big: true });
    T.gates = { start: { s: 30, u: -80, half: 17 }, finish: { s: 1596, u: -80, half: 20 }, flags: 270 };
  },
};

// ===================================================================== AURORA OLD TOWN
const AURORA = {
  sMin: -70, sMax: 1470, uHalf: 200, margin: 70,
  length: 1400, finishS: 1376,
  spawn: { s: 14, u: 12 },
  sidewalk: 1.2,
  mountains: true,
  defaultZone: { name: 'OLD TOWN', jp: '古い町並み' },
  skyline: { h: [6, 12], styles: [2, 2, 2], colors: [0x4a3a30, 0x5a4a3e, 0x3a302c, 0x6a5a4a], lit: 0.5, pitched: true },
  grade(s) {
    if (s < 30) return 0.03;
    if (s < 1300) return 0.03 + (0.13 + 0.04 * noise1(s / 110 + 4.4)) * smoothstep(30, 70, s);
    if (s < 1420) return 0.02 + 0.12 * (1 - smoothstep(1300, 1340, s));
    return 0.02;
  },
  streets: [
    { id: 'bamboo', name: 'BAMBOO PATH', jp: '竹林の小径', diff: 'mid', color: 0x6ccf6a, sw: 0.4, paved: 0.93, noBlocks: true,
      pts: [[-70, -150, 3.5, 0], [200, -168, 3.5, 0], [420, -140, 3.5, 0], [640, -165, 3.5, 0], [860, -142, 3.5, 0], [1080, -160, 3.5, 0], [1300, -150, 3.5, 0], [1470, -150, 3.5, 0]] },
    { id: 'torii', name: 'TORII TUNNEL', jp: '千本鳥居', diff: 'mid', color: 0xff5a3a, sw: 0.4, paved: 0.92, noBlocks: true,
      pts: [[-70, -96, 2.6, 0], [180, -84, 2.6, 0], [360, -104, 2.6, 0], [560, -86, 2.6, 0], [760, -102, 2.6, 0], [960, -88, 2.6, 0], [1160, -100, 2.6, 0], [1470, -92, 2.6, 0]] },
    { id: 'sannen', name: 'SANNENZAKA', jp: '三年坂', diff: 'easy', color: 0xffb03a, sw: 1.0, paved: 0.84,
      pts: [[-70, -28, 3.4, 0], [200, -20, 3.4, 0], [430, -34, 3.4, 0], [650, -22, 3.4, 0], [900, -32, 3.4, 0], [1150, -24, 3.4, 0], [1470, -28, 3.4, 0]] },
    { id: 'roofs', name: 'ROOFTOP RUN', jp: '屋根伝い', diff: 'hard', color: 0x9d4dff, u: 46, hw: 2.5, sw: 0.6, street: false, noNpc: true },
    { id: 'temple', name: 'TEMPLE ROAD', jp: '参道', diff: 'easy', color: 0xff9a40, u: 116, hw: 5.5, sw: 1.5, paved: 0.88 },
  ],
  decals: { stone: ['sannen', 'temple'], crossStone: true },
  cross: [130, 262, 400, 540, 690, 830, 980, 1120, 1250].map((s) => ({ s, hw: 3, u0: -60, u1: 200 })),
  areas: [
    { name: 'TEMPLE GATE', jp: '山門', s0: -200, s1: 40 },
    { name: 'KAMO RIVER', jp: '鴨川', s0: 1316, s1: 9999 },
    { name: 'BAMBOO GROVE', jp: '竹林', s0: 40, s1: 1300, u0: -200, u1: -125, under: true },
    { name: 'PAGODA', jp: '五重塔', s0: 320, s1: 400, u0: 130, u1: 190 },
  ],
  carves: [{ along: 'u', s: 1340, hw: 9, bank: 6, depth: 3.6 }],
  build(T) {
    const rng = T.rng;
    const st = (id) => T.street(id);
    T.reserve(-200, 42, -400, 400, 'top');
    T.reserve(1300, 1600, -400, 400, 'river');
    T.reserve(-80, 1310, -400, -120, 'bamboo');
    T.reserve(-80, 1310, -112, -62, 'torii-woods');
    T.reserve(318, 402, 128, 192, 'pagoda');
    T.reserve(40, 1300, 36, 56, 'roofline');
    // ---- machiya: two-storey timber town houses with tiled roofs
    T.fillBlocks({
      lot: [7, 12], depth: [9, 14], alley: 0.5, gap: 0.08, district: 'aurora',
      height: (s, u, r) => r.range(6.5, 9.5) + (r() < 0.12 ? 4 : 0),
      style: () => STYLE.old,
      color: (r) => r.pick([0x4a3a30, 0x5a4a3e, 0x3a302c, 0x6a5a4a, 0x2e2a2c]),
      lit: (r) => clamp(0.6 * r.range(0.6, 1.4), 0, 0.95),
      roof: (s, u, r) => (r() < 0.6 ? 'gable' : 'hip'),
    });
    // ---- the rooftop run: a continuous line of machiya roofs stepping down
    let s = 48, k = 0, prevEnd = Infinity;
    while (s < 1290) {
      const len = rng.range(9, 14);
      const sEnd = Math.min(1290, s + len);
      const above = Math.min(6.2 + Math.min(k, 3) * 0.6, 0.8 + k * 0.3);
      const base = Math.min(T.ground(s, 46 - 5), T.ground(s, 46 + 5), T.ground(sEnd, 46 - 5), T.ground(sEnd, 46 + 5));
      const b = T.block(s, sEnd, 41, 51, above + (T.ground(sEnd, 46) - base), { style: STYLE.old, face: { du: -1, ds: 0 }, seed: rng(), lit: 0.6, color: rng.pick([0x4a3a30, 0x5a4a3e, 0x3a302c]), roofKind: 'gable', rooftop: true, baseY: base });
      // gable ridge along s, shallow enough to ride
      const rise = 1.3, hw = (sEnd - s) / 2 + 0.6, hd = 5.6, sc = (s + sEnd) / 2, flat = 1.7;
      // ridge falls with the hill so the run keeps its speed; a flat snow cap on the ridge to ride
      const slope = Math.max(0, (T.ground(s, 46) - T.ground(sEnd, 46)) / (sEnd - s));
      b.rise = rise; b.hw = hw; b.hd = hd; b.ye = b.top - 0.2; b.ridgeAlong = 's'; b.roofSlope = slope; b.slopeRef = sc + hw; b.ridgeFlat = flat;
      // never start above the roof we just left
      const startY = b.ye + rise + 0.12 + slope * 2 * hw;
      if (startY > prevEnd - 0.3) { const d = startY - (prevEnd - 0.3); b.ye -= d; b.top -= d; }
      b.roofH = (ss, uu) => (Math.abs(ss - sc) > hw || Math.abs(uu - 46) > hd ? -1e9 : b.ye + rise * (1 - Math.max(0, Math.abs(uu - 46) - flat) / (hd - flat)) + 0.12 + slope * (sc + hw - ss));
      prevEnd = b.roofH(sc + hw - 0.01, 46);
      b.feature.fn = b.roofH;
      b.feature.bs0 = sc - hw; b.feature.bs1 = sc + hw; b.feature.bu0 = 46 - hd; b.feature.bu1 = 46 + hd;
      T._addFeatureBuckets(b.feature, sc - hw, sc + hw, 46 - hd, 46 + hd);
      if (k === 0) T.drift(s - 0.6, 46, 6, b.roofH(s - 0.5, 46), 8);
      T.tokens.push({ s: sc, u: 46, y: b.roofH(sc, 46) + 1.3 });
      const crossing = T.cross.find((c) => c.s - c.hw - 1 > sEnd && c.s - c.hw - 1 < sEnd + 6);
      if (crossing) {
        T.kicker(sEnd - 3.4, 46, 3, 0.7, 3.6, 'kicker', b.roofH);
        s = crossing.s + crossing.hw + 1.4;
      } else {
        s = sEnd + (k < 5 ? 0.5 : rng.range(1.2, 3.2));
        if (k >= 5 && rng() < 0.3) T.kicker(sEnd - 3.4, 46, 3, 0.6, 3.6, 'kicker', b.roofH);
      }
      k++;
    }
    T.areas.push({ name: 'ROOFTOP RUN', jp: '屋根伝い', s0: 44, s1: 1295, u0: 39, u1: 53, roof: true });
    // ---- Sannenzaka: stone lane with flights of steps and lantern strings
    const sn = st('sannen');
    for (let s2 = 110; s2 < 1280; s2 += rng.range(90, 130)) {
      if (T.onLaneCross(s2 - 24) || T.onLaneCross(s2 + 10)) continue;
      const c = sn.at(s2, {});
      T.terrace(s2 - 22, s2, c.u, c.w * 2, { stairLen: 7 });
      T.tokenLine(s2 + 1, s2 + 9, c.u, c.u, 2.4, 3, 2);
    }
    for (let s2 = 60; s2 < 1290; s2 += rng.range(12, 18)) T.props.chochin.push({ s: s2, u: sn.centre(s2), w: sn.at(s2, {}).w * 2 + 2, y: T.ground(s2, sn.centre(s2)) + 3.3 });
    for (let s2 = 90; s2 < 1280; s2 += rng.range(50, 80)) {
      const u = sn.centre(s2);
      if (T.height(s2, u) - T.ground(s2, u) > 0.2 || !T._free(s2 - 6, s2 + 14, u - 3, u + 3, 1)) continue;
      if (rng() < 0.5) T.railLine(s2, u + 1.2, 10, 0.5, 'ledge', 'bench');
      else { T.kicker(s2, u, 5, 1.1, 4); T.tokenLine(s2 + 7, s2 + 18, u, u, 2.4, 3, 2); }
    }
    // ---- Torii tunnel: thousands of gates along a winding path through the woods
    const tt = st('torii');
    for (let s2 = 50; s2 < 1290; s2 += 2.6) {
      const inTunnel = Math.floor(s2 / 160) % 3 !== 2;
      if (!inTunnel) continue;
      const c = tt.at(s2, {});
      T.props.torii.push({ s: s2, u: c.u, w: c.w * 2 + 0.8, h: 3.4, y: T.ground(s2, c.u), small: true });
      if (Math.round(s2 / 2.6) % 9 === 0) T.tokens.push({ s: s2, u: c.u, y: T.ground(s2, c.u) + 1.4 });
    }
    for (let s2 = 70; s2 < 1290; s2 += rng.range(60, 90)) {
      const c = tt.at(s2, {});
      T.kicker(s2, c.u, 4.5, 0.8, 3.4);
    }
    for (let i = 0; i < 520; i++) {
      const s2 = rng.range(-40, 1300), u = rng.range(-120, -62);
      const c = tt.at(Math.min(Math.max(s2, tt.s0), tt.s1), {});
      if (Math.abs(u - c.u) < c.w + 2.5) continue;
      T.props.trees.push({ s: s2, u, y: T.ground(s2, u), sc: rng.range(0.7, 1.25), rot: rng() * 6 });
    }
    // ---- Bamboo path through the grove
    const bb = st('bamboo');
    for (let i = 0; i < 2600; i++) {
      const s2 = rng.range(-40, 1300), u = rng.range(-200, -122);
      const c = bb.at(Math.min(Math.max(s2, bb.s0), bb.s1), {});
      if (Math.abs(u - c.u) < c.w + 1.2) continue;
      T.props.bamboo.push({ s: s2, u, y: T.ground(s2, u), h: rng.range(10, 15), lean: rng.range(-0.08, 0.08) });
    }
    for (let s2 = 60; s2 < 1290; s2 += 22) for (const sd of [-1, 1]) {
      const c = bb.at(s2, {});
      T.props.lamps.push({ s: s2 + sd * 5, u: c.u + sd * (c.w + 0.6), y: T.ground(s2, c.u + sd * (c.w + 0.6)), dir: -sd, style: 'lantern' });
    }
    for (let s2 = 100; s2 < 1280; s2 += rng.range(70, 100)) { const u = bb.centre(s2); T.spine(s2, 10, u, 0.8, 3.4); T.tokenLine(s2 + 2, s2 + 8, u, u, 2.0, 3, 1); }
    // ---- Temple road: stone lanterns, shops, the pagoda
    const tp = st('temple');
    for (let s2 = 50; s2 < 1290; s2 += 16) for (const sd of [-1, 1]) {
      if (T.onLaneCross(s2)) continue;
      T.props.stoneLanterns.push({ s: s2, u: tp.centre(s2) + sd * (tp.at(s2, {}).w + 0.6), y: T.ground(s2, tp.centre(s2)) });
    }
    let m = 0;
    for (let s2 = 120; s2 < 1280; s2 += rng.range(70, 100)) {
      if (T.onLaneCross(s2) || T.onLaneCross(s2 + 20)) continue;
      const u = tp.centre(s2) + (m++ % 2 ? 2.5 : -2.5);
      if (m % 3 === 0) T.railLine(s2, u, 14, 0.7, 'rail', 'metal');
      else { const h = rng.range(1.4, 2.2); T.kicker(s2, u, 7, h, 5); T.tokenLine(s2 + 10, s2 + 24, u, u, h + 2.4, 4, 2.5); }
    }
    T.decor.landmarks.push({ type: 'pagoda', s: 360, u: 160 });
    T.addObstacle({ s: 360, u: 160, r: 8.5, top: T.ground(360, 160) + 40, kind: 'tower' });
    T.decor.landmarks.push({ type: 'templegate', s: 36, u: 116, w: 16 });
    for (const sd of [-1, 1]) T.addObstacle({ s: 36, u: 116 + sd * 7.4, r: 0.9, top: T.ground(36, 116) + 12, kind: 'post' });
    T.decor.landmarks.push({ type: 'temple', s: -42, u: 40 });
    T.addObstacle({ s: -42, u: 40, r: 16, top: 50, kind: 'temple' });
    // ---- Kamo river: frozen, with sloping banks and bridges
    T.iceAreas.push({ s0: 1331, s1: 1349, u0: -400, u1: 400 });
    for (const [u, w] of [[116, 14], [-28, 9]]) {
      const y = T.baseY(1322) + 0.1;
      T.slab(1322, 1358, u - w / 2, u + w / 2, (s2) => y + (T.baseY(1358) + 0.1 - y) * ((s2 - 1322) / 36) + 0.6 * Math.sin(((s2 - 1322) / 36) * Math.PI), { kind: 'bridge' });
      T.structures.push({ type: 'bridge', along: 's', s0: 1322, s1: 1358, u, w, y0: y, y1: T.baseY(1358) + 0.1, arch: 0.6 });
    }
    T.structures.push({ type: 'river', s: 1340, hw: 9, bank: 6 });
    T.kicker(1314, -120, 6, 1.2, 8);
    T.kicker(1314, 46, 6, 1.4, 8);
    // ---- lamps along the lanes
    for (const id of ['sannen', 'temple']) T.lampsAlong(st(id), 26, { style: 'lantern' });
    T.sign(36, -70, T.routes.map((r) => ({ route: r })), { big: true });
    T.gates = { start: { s: 26, u: 12, half: 8 }, finish: { s: 1376, u: 116, half: 10 }, flags: 190 };
  },
};

export const CITY_LAYOUTS = { neon: NEON, golden: GOLDEN, aurora: AURORA };
export { STYLE };
