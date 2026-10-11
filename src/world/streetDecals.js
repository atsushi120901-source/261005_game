import * as THREE from 'three';
import { mulberry32, clamp, smoothstep } from '../core/utils.js';

// Road surface detail draped over the city's snowy streets: wet tyre ruts and
// half-buried lane lines on the roads, zebra crossings at the junctions (with
// the diagonal ones of a scramble crossing), and old paving stones showing
// through the trampled snow of the old-town lanes.

const LANE = 3.5; // m, one lane of the rut texture
const RUT_REP = 20; // m, rut texture repeat along the road
const ZEBRA = 7.2; // m, eight bars of the zebra texture

function smoothNoise(rng, n) {
  // periodic 1D value noise with n knots
  const k = Array.from({ length: n }, () => rng());
  return (t) => {
    const f = (((t % 1) + 1) % 1) * n;
    const i = Math.floor(f), a = f - i;
    const e = a * a * (3 - 2 * a);
    return k[i] + (k[(i + 1) % n] - k[i]) * e;
  };
}

function valueNoise2(rng, nx, ny) {
  // periodic 2D value noise on an nx × ny lattice
  const k = Array.from({ length: nx * ny }, () => rng());
  return (x, y) => {
    const fx = (((x % 1) + 1) % 1) * nx, fy = (((y % 1) + 1) % 1) * ny;
    const i = Math.floor(fx), j = Math.floor(fy);
    const a = fx - i, b = fy - j;
    const ea = a * a * (3 - 2 * a), eb = b * b * (3 - 2 * b);
    const v = (ii, jj) => k[(jj % ny) * nx + (ii % nx)];
    return (v(i, j) * (1 - ea) + v(i + 1, j) * ea) * (1 - eb) + (v(i, j + 1) * (1 - ea) + v(i + 1, j + 1) * ea) * eb;
  };
}

function texture(canvas, repeat = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  return t;
}

// one lane: two wheel tracks of dark wet asphalt, a dashed lane line at the edge
function rutTexture() {
  const W = 128, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const rng = mulberry32(11);
  const wob = [smoothNoise(rng, 9), smoothNoise(rng, 13), smoothNoise(rng, 11), smoothNoise(rng, 7)];
  const str = [smoothNoise(rng, 41), smoothNoise(rng, 53), smoothNoise(rng, 37)];
  const cover = smoothNoise(rng, 17);
  const clumps = valueNoise2(rng, 24, 96), fine = valueNoise2(rng, 64, 256);
  const px = W / LANE;
  for (let y = 0; y < H; y++) {
    const t = y / H;
    // wheel tracks: one well-worn pair, a fainter pair that wandered
    const ruts = [
      [0.27 * W + (wob[0](t) - 0.5) * 9, 0.12 * px, 0.32 + 0.4 * str[0](t)],
      [0.73 * W + (wob[0](t) - 0.5) * 9, 0.12 * px, 0.32 + 0.4 * str[1](t)],
      [0.3 * W + (wob[1](t) - 0.5) * 18, 0.09 * px, 0.28 * str[2](t + 0.3)],
      [0.7 * W + (wob[1](t) - 0.5) * 18, 0.09 * px, 0.28 * str[2](t + 0.6)],
      [0.5 * W + (wob[3](t) - 0.5) * 30, 0.3 * px, 0.08],
    ];
    // dashed lane line: 5 m paint, 5 m gap
    const m = (t * RUT_REP) % 10;
    const dash = m > 0.4 && m < 5.4 ? 0.55 * smoothstep(0.25, 0.7, cover(t * 3.7)) : 0;
    for (let x = 0; x < W; x++) {
      let a = 0;
      for (const [cx, hw, k] of ruts) {
        const d = Math.abs(x - cx) / hw;
        if (d < 1.8) a = Math.max(a, k * (1 - smoothstep(0.3, 1.8, d)));
      }
      // packed-snow clumps and slushy grain
      a *= smoothstep(0.18, 0.55, clumps(x / W, t)) * (0.7 + 0.3 * fine(x / W, t));
      const g = rng();
      a *= 0.85 + 0.15 * g;
      if (g > 0.985) a = Math.max(a, 0.25);
      const i = (y * W + x) * 4;
      const lane = Math.min(x, W - 1 - x) < 0.075 * px ? dash : 0;
      if (lane > a) {
        img.data[i] = 236; img.data[i + 1] = 238; img.data[i + 2] = 240; img.data[i + 3] = lane * 255;
      } else {
        img.data[i] = 26; img.data[i + 1] = 29; img.data[i + 2] = 35; img.data[i + 3] = a * 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return texture(c);
}

// eight zebra bars, partly buried in snow
function zebraTexture() {
  const W = 512, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const rng = mulberry32(23);
  const nx = smoothNoise(rng, 29), ny = smoothNoise(rng, 7), nz = smoothNoise(rng, 13);
  const bar = W / 8;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const f = (x % bar) / bar;
      let a = smoothstep(0.02, 0.06, f) * (1 - smoothstep(0.46, 0.5, f));
      // snow drifts over the paint in patches; worn where the tyres run
      const cov = nx(x / W) * 0.6 + ny(y / H) * 0.25 + nz(x / W + y / H * 0.3) * 0.3;
      a *= 0.25 + 0.75 * smoothstep(0.35, 0.75, cov);
      a *= 0.85 + 0.15 * rng();
      const i = (y * W + x) * 4;
      img.data[i] = 240; img.data[i + 1] = 242; img.data[i + 2] = 244; img.data[i + 3] = a * 235;
    }
  }
  ctx.putImageData(img, 0, 0);
  return texture(c);
}

// old paving stones showing through trampled snow, the full width of a lane
function stoneTexture() {
  const W = 256, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const rng = mulberry32(37);
  // slabs in staggered rows
  ctx.fillStyle = '#3c3a38';
  ctx.fillRect(0, 0, W, H);
  let y = 0;
  while (y < H) {
    const rh = 22 + rng() * 18;
    let x = -rng() * 40;
    while (x < W) {
      const rw = 34 + rng() * 46;
      const v = 98 + rng() * 34;
      ctx.fillStyle = `rgb(${v + 6},${v + 2},${v - 4})`;
      ctx.fillRect(x + 1.5, y + 1.5, rw - 3, Math.min(rh, H - y) - 3);
      x += rw;
    }
    y += rh;
  }
  const rgb = ctx.getImageData(0, 0, W, H);
  // mask: exposed along the middle of the lane, in patches
  const n1 = smoothNoise(rng, 11), n2 = smoothNoise(rng, 17), n3 = smoothNoise(rng, 5);
  for (let yy = 0; yy < H; yy++) {
    for (let x = 0; x < W; x++) {
      const across = Math.abs(x / W - 0.5) * 2;
      const p = n1(yy / H + x / W * 0.2) * 0.5 + n2(yy / H * 1.0 + 0.37) * 0.3 + n3(x / W) * 0.25;
      let a = smoothstep(0.45, 0.8, p) * (1 - smoothstep(0.35, 0.95, across));
      a *= 0.8 + 0.2 * rng();
      rgb.data[(yy * W + x) * 4 + 3] = clamp(a, 0, 1) * 235;
    }
  }
  ctx.putImageData(rgb, 0, 0);
  return texture(c);
}

// A strip draped over the ground: P(a, d) maps the along/across coordinates to
// (s, u); a runs a0..a1, d runs -hw..hw.
function strip(D, P, a0, a1, hw, opts) {
  const { lw, rep, h, fade, step = 4 } = opts;
  const nA = Math.max(2, Math.ceil((2 * hw) / 2.5) + 1);
  const base = D.pos.length / 3;
  let rows = 0;
  for (let a = a0; ; a = Math.min(a1, a + step)) {
    for (let k = 0; k < nA; k++) {
      const d = -hw + (2 * hw * k) / (nA - 1);
      const [s, u] = P(a, d);
      D.pos.push(u, h(s, u), -s);
      D.uv.push((d + hw) / lw, (a - a0) / rep + (opts.v0 ?? 0));
      D.col.push(1, 1, 1, fade ? fade(s, u) : 1);
    }
    rows++;
    if (a >= a1) break;
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let k = 0; k < nA - 1; k++) {
      const i = base + r * nA + k;
      D.idx.push(i, i + 1, i + nA + 1, i, i + nA + 1, i + nA);
    }
  }
}

function decalMesh(D, mat, order) {
  if (!D.idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(D.pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(D.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(D.col, 4));
  g.setIndex(D.idx);
  g.computeVertexNormals();
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = order;
  m.frustumCulled = false;
  return m;
}

function decalMaterial(map, o) {
  return new THREE.MeshStandardMaterial({
    map, vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    ...o,
  });
}

export function buildStreetDecals(w) {
  const tr = w.track, L = tr.L, cfg = L.decals;
  if (!cfg) return;
  const lift = 0.03;
  const ground = (s, u) => tr.ground(s, u) + lift;
  // no decals on carved water or the hills beyond the streets
  const fade = (s, u) => smoothstep(-1.1, -0.6, tr.ground(s, u) - tr.baseY(s));
  const sA = Math.max(L.sMin + 110, 46), sB = tr.finishS + 40;
  const ruts = { pos: [], uv: [], col: [], idx: [] };
  const zebra = { pos: [], uv: [], col: [], idx: [] };
  const stone = { pos: [], uv: [], col: [], idx: [] };
  const byId = (id) => tr.routes.find((r) => r.id === id);
  const _c = {};
  const widthAt = (r) => r.at(clamp((r.s0 + r.s1) / 2, r.s0, r.s1), _c).w;

  // roads: ruts, lane lines and zebra crossings at the junctions
  const roads = (cfg.road || []).map(byId).filter(Boolean);
  for (const r of roads) {
    const deck = r.id === 'skyway' ? tr.structures.find((st) => st.type === 'skyway') : null;
    const hw = widthAt(r);
    const lanes = Math.max(1, Math.round((2 * hw) / LANE));
    const lw = (2 * hw) / lanes;
    const P = (a, d) => [a, r.at(a, _c).u + d];
    const med = r.median;
    if (med) {
      // two carriageways either side of a planted median
      const hc = (hw - med) / 2;
      const lc = (2 * hc) / Math.max(1, Math.round((2 * hc) / LANE));
      for (const sd of [-1, 1]) strip(ruts, (a, d) => [a, r.at(a, _c).u + sd * (med + hc) + d], Math.max(sA, r.s0), Math.min(sB, r.s1), hc, { lw: lc, rep: RUT_REP, h: ground, fade });
      continue;
    }
    if (deck) {
      const h = (s) => deck.deckY(s) + lift;
      strip(ruts, P, deck.s0 + 24, deck.gap[0] - 1, hw - 0.6, { lw, rep: RUT_REP, h: (s) => h(s) });
      strip(ruts, P, deck.gap[1] + 1, deck.s1 - 30, hw - 0.6, { lw, rep: RUT_REP, h: (s) => h(s) });
      continue;
    }
    strip(ruts, P, Math.max(sA, r.s0), Math.min(sB, r.s1), hw, { lw, rep: RUT_REP, h: ground, fade });
  }
  if (cfg.crossRoad) {
    for (const c of tr.cross) {
      if (c.s < sA || c.s > sB) continue;
      const u0 = Math.max(c.u0 ?? -L.uHalf, -L.uHalf), u1 = Math.min(c.u1 ?? L.uHalf, L.uHalf);
      const lanes = Math.max(1, Math.round((2 * c.hw) / LANE));
      strip(ruts, (a, d) => [c.s + d, a], u0, u1, c.hw, { lw: (2 * c.hw) / lanes, rep: RUT_REP, h: ground, fade });
      // zebra crossings where it meets a road
      for (const r of roads) {
        if (r.id === 'skyway') continue;
        const rc = r.at(c.s, {});
        if (!rc || rc.u < u0 || rc.u > u1) continue;
        // across the road, both sides of the junction
        for (const sd of [-1, 1]) {
          const a0 = c.s + sd * (c.hw + 1.2) - (sd < 0 ? 4 : 0);
          strip(zebra, (a, d) => [a, rc.u + d], a0, a0 + 4, rc.w - 0.4, { lw: ZEBRA, rep: 4, h: ground, step: 4 });
        }
        // across the cross street, both sides of the road
        for (const sd of [-1, 1]) {
          const a0 = rc.u + sd * (rc.w + 1.2) - (sd < 0 ? 4 : 0);
          strip(zebra, (a, d) => [c.s + d, a], a0, a0 + 4, c.hw - 0.4, { lw: ZEBRA, rep: 4, h: ground, step: 4 });
        }
      }
    }
  }
  // the scramble: two long diagonal crossings over the junction
  if (cfg.scramble) {
    const { s, u, ds, du } = cfg.scramble;
    const len = Math.hypot(ds, du);
    for (const sg of [-1, 1]) {
      const ws = ds / len, wu = (sg * du) / len; // walking direction
      const bs = -wu, bu = ws; // bar direction
      strip(zebra, (a, d) => [s + a * bs + d * ws, u + a * bu + d * wu], -2.2, 2.2, len - 2, { lw: ZEBRA, rep: 4.4, h: ground, step: 2.2 });
    }
  }
  // old town: paving stones through the snow
  for (const id of cfg.stone || []) {
    const r = byId(id);
    if (!r) continue;
    const hw = widthAt(r);
    strip(stone, (a, d) => [a, r.at(a, _c).u + d], Math.max(sA, r.s0), Math.min(sB, r.s1), hw, { lw: 2 * hw, rep: 8, h: ground, fade });
  }
  if (cfg.crossStone) {
    for (const c of tr.cross) {
      if (c.s < sA || c.s > sB) continue;
      const u0 = Math.max(c.u0 ?? -L.uHalf, -L.uHalf), u1 = Math.min(c.u1 ?? L.uHalf, L.uHalf);
      strip(stone, (a, d) => [c.s + d, a], u0, u1, c.hw, { lw: 2 * c.hw, rep: 8, h: ground, fade });
    }
  }

  const add = (D, mat, order) => {
    const m = decalMesh(D, mat, order);
    w.disposables.push(mat, mat.map);
    if (m) w.add(m, { receive: true });
  };
  if (ruts.idx.length) add(ruts, decalMaterial(rutTexture(), { roughness: 0.28, metalness: 0.05, envMapIntensity: 1.4 }), 1);
  if (zebra.idx.length) add(zebra, decalMaterial(zebraTexture(), { roughness: 0.6 }), 2);
  if (stone.idx.length) add(stone, decalMaterial(stoneTexture(), { roughness: 0.55 }), 1);
}
