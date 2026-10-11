import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, clamp, fbm2 } from '../core/utils.js';
import { GeoBuilder, bake } from './geom.js';
import { setupOpenWorld, buildTerrainChunks, buildFeatureMeshes, buildSignage, buildGates } from './openWorld.js';
import { buildRanges } from './mountain.js';
import { neonSignTexture, bannerTexture, vendingTexture } from '../gfx/textures.js';
import { createScreenMaterial } from '../gfx/materials.js';
import { buildStreetDecals } from './streetDecals.js';

// Visuals of the open-world city districts: lit buildings, stairs and terraces,
// skybridges, an elevated railway with trains, neon gates, lanterns, torii,
// street furniture, neon signs and a skyline beyond the playable area.

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const CH = 160; // geometry chunk size for culling

export function buildCityWorld(w) {
  const tr = w.track;
  const L = tr.L;
  setupOpenWorld(w);
  w.crossings = [];
  w.frontBuildings = [];
  w.cityRng = mulberry32(w.stage.seed + 31);
  const gbs = new Map();
  w.cityGB = (s, u) => {
    const k = Math.floor(s / CH) * 1000 + Math.floor(u / CH);
    if (!gbs.has(k)) gbs.set(k, new GeoBuilder({ color: 3, aFacade: 4 }));
    return gbs.get(k);
  };
  buildTerrainChunks(w);
  buildFeatureMeshes(w);
  buildStreetDecals(w);
  buildCityBuildings(w);
  buildTerraces(w);
  buildSkybridges(w);
  buildSkyline(w);
  for (const gb of gbs.values()) {
    if (!gb.count) continue;
    w.add(new THREE.Mesh(gb.build(), w.mats.facade), { cast: w.quality.shadows, receive: true });
  }
  buildViaducts(w);
  buildCityStructures(w);
  buildFootbridges(w);
  buildNeonGates(w);
  buildStreetProps(w);
  buildFacadeSigns(w);
  buildLandmarks(w);
  L.decorate?.(w);
  buildSignage(w);
  buildGates(w);
  if (L.mountains) buildRanges(w, mulberry32(7), { cx: 0, cz: -tr.length / 2, base: tr.baseY(tr.length / 2) - 120, inner: 1500 });
  w.cityUpdate = (t) => updateCity(w, t);
}

// ------------------------------------------------------------------ buildings
function faceInfo(b, face) {
  // facade plane of a building side facing a street
  if (face.du) return { du: face.du, ds: 0, s: b.s, u: face.du < 0 ? b.u0 : b.u1, len: b.w };
  return { du: 0, ds: face.ds, s: face.ds < 0 ? b.s0 : b.s1, u: b.u, len: b.d };
}

function buildCityBuildings(w) {
  const tr = w.track;
  const rng = w.cityRng;
  const plain = (seed) => [5, seed, 0, 0];
  for (const b of tr.buildings) {
    if (b.kind === 'station' || b.top === undefined) continue;
    const gb = w.cityGB(b.s, b.u);
    const col = new THREE.Color(b.color ?? 0x444444);
    const fac = [b.style ?? 1, b.seed, b.lit ?? 0.4, 0];
    const pitched = b.roofKind === 'gable' || b.roofKind === 'hip';
    if (b.roofSlope) {
      // walls follow the sloping roof of a rooftop line
      slopedWalls(gb, b, fac, col);
      if (pitched) pitchedRoof(gb, b);
      else slopedSnowRoof(gb, b, col);
      w.frontBuildings.push(b);
      continue;
    }
    w._box(gb, b.s, b.u, b.w, b.d, b.base - 4, b.top, b.base, fac, col, !pitched);
    if (pitched) {
      pitchedRoof(gb, b);
    } else {
      // cornice and a thick cap of snow
      w._box(gb, b.s, b.u, b.w + 0.5, b.d + 0.5, b.top - 0.45, b.top, b.base, plain(b.seed), col.clone().multiplyScalar(0.75), false);
      w._box(gb, b.s, b.u, b.w + 0.6, b.d + 0.6, b.top, b.top + 0.3, b.top, [1, b.seed, 0, 1], col, true);
      if (!b.rooftop && b.H > 9) w._roofClutter(gb, { sm: b.s, u0: b.u, w: b.w, d: b.d, y1: b.top + 0.3, seed: b.seed, H: b.H }, rng);
    }
    // street-facing details
    const f = b.face || { du: -1, ds: 0 };
    const fi = faceInfo(b, f);
    if ((b.style === 4 || b.style === 1) && b.H > 6) {
      const awn = new THREE.Color(rng.pick([0x7a1c18, 0x1f3b6b, 0x245a3a, 0x3a3a3f, 0x8a6a20]));
      if (fi.du) w._box(gb, b.s, fi.u + fi.du * 0.7, b.w - 0.8, 1.4, b.base + 3.95, b.base + 4.2, b.base, plain(b.seed), awn, true);
      else w._box(gb, fi.s + fi.ds * 0.7, b.u, 1.4, b.d - 0.8, b.base + 3.95, b.base + 4.2, b.base, plain(b.seed), awn, true);
    }
    // window AC units on older concrete blocks
    if (b.style === 1 && b.H > 12) {
      const rows = Math.min(10, Math.floor((b.H - 6) / 3.2));
      for (let k = 1; k <= rows; k++) {
        const n = Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const yb = b.base + 4.4 + k * 3.2 + 0.15;
          const o = rng.range(-fi.len / 2 + 1, fi.len / 2 - 1);
          if (fi.du) w._box(gb, b.s + o, fi.u + fi.du * 0.2, 0.8, 0.36, yb, yb + 0.58, b.base, plain(b.seed), new THREE.Color(0xc9cbcd), true);
          else w._box(gb, fi.s + fi.ds * 0.2, b.u + o, 0.36, 0.8, yb, yb + 0.58, b.base, plain(b.seed), new THREE.Color(0xc9cbcd), true);
        }
      }
    }
    if (b.H > 8) w.frontBuildings.push(b);
  }
  // the station: a long glass hall with a lit canopy
  for (const b of tr.buildings.filter((q) => q.kind === 'station')) {
    const gb = w.cityGB(b.s, b.u);
    w._box(gb, b.s, b.u, b.w, b.d, b.base - 4, b.top, b.base, [0, b.seed, 0.7, 0], new THREE.Color(b.color), false);
    w._box(gb, b.s, b.u, b.w + 1, b.d + 1, b.top, b.top + 0.4, b.top, [1, b.seed, 0, 1], new THREE.Color(0x8a8f96), true);
    w._box(gb, b.s0 - 3, b.u, 6, b.d * 0.8, b.base + 6.5, b.base + 7.0, b.base, [5, b.seed, 0, 0], new THREE.Color(0x2a2e34), true);
  }
}

// Walls whose top edge follows a roof sloping down the hill (rooftop lines).
function slopedWalls(gb, b, fac, col) {
  const s0 = b.s0, s1 = b.s1, u0 = b.u0, u1 = b.u1;
  const ref = b.slopeRef ?? s1;
  const topAt = (s) => b.top + b.roofSlope * (ref - s);
  const y0 = b.base - 4;
  const A = { color: [col.r, col.g, col.b], aFacade: fac };
  const P = (s, u, y) => V(u, y, -s);
  const v0 = y0 - b.base;
  // long walls (along s) at u0 and u1
  for (const [u, out] of [[u0, V(-1, 0, 0)], [u1, V(1, 0, 0)]]) {
    gb.quad(P(s0, u, y0), P(s1, u, y0), P(s1, u, topAt(s1)), P(s0, u, topAt(s0)), [[0, v0], [s1 - s0, v0], [s1 - s0, topAt(s1) - b.base], [0, topAt(s0) - b.base]], A, out);
  }
  // end walls
  for (const [ss, out] of [[s0, V(0, 0, 1)], [s1, V(0, 0, -1)]]) {
    const yt = topAt(ss);
    gb.quad(P(ss, u0, y0), P(ss, u1, y0), P(ss, u1, yt), P(ss, u0, yt), [[0, v0], [u1 - u0, v0], [u1 - u0, yt - b.base], [0, yt - b.base]], A, out);
  }
}

// Snow slab on a roof that falls with the hill.
function slopedSnowRoof(gb, b, col) {
  const s0 = b.s0 - 0.3, s1 = b.s1 + 0.3, u0 = b.u0 - 0.3, u1 = b.u1 + 0.3;
  const yAt = (s) => b.roofH(Math.min(b.s1, Math.max(b.s0, s)), b.u);
  const snowA = { color: [1, 1, 1], aFacade: [1, b.seed, 0, 1] };
  const edgeA = { color: [col.r * 0.75, col.g * 0.75, col.b * 0.75], aFacade: [5, b.seed, 0, 0] };
  const P = (s, u, y) => V(u, y, -s);
  gb.quad(P(s0, u0, yAt(s0)), P(s0, u1, yAt(s0)), P(s1, u1, yAt(s1)), P(s1, u0, yAt(s1)), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, UP);
  for (const [u, out] of [[u0, V(-1, 0, 0)], [u1, V(1, 0, 0)]]) {
    gb.quad(P(s0, u, yAt(s0) - 0.45), P(s1, u, yAt(s1) - 0.45), P(s1, u, yAt(s1)), P(s0, u, yAt(s0)), [[0, -9], [1, -9], [1, -9], [0, -9]], edgeA, out);
  }
  for (const [ss, out] of [[s0, V(0, 0, 1)], [s1, V(0, 0, -1)]]) {
    gb.quad(P(ss, u0, yAt(ss) - 0.45), P(ss, u1, yAt(ss) - 0.45), P(ss, u1, yAt(ss)), P(ss, u0, yAt(ss)), [[0, -9], [1, -9], [1, -9], [0, -9]], edgeA, out);
  }
}

// Pitched roof (gable or hip) with snow and dark eaves.
function pitchedRoof(gb, b) {
  const { s, u, hw, hd, ye, rise } = b;
  const slope = b.roofSlope || 0, ref = b.slopeRef ?? 0;
  const P = (ds, du, y) => V(u + du, y + slope * (ref - (s + ds)), -(s + ds));
  const y0 = ye + 0.12;
  const snowA = { color: [1, 1, 1], aFacade: [b.style ?? 2, b.seed, 0, 1] };
  const tileA = { color: [0.16, 0.17, 0.2], aFacade: [5, b.seed, 0, 0] };
  const hip = b.roofKind === 'hip';
  if (b.ridgeAlong === 's' && b.ridgeFlat) {
    // gable with a flat, snow-filled ridge (rooftop run)
    const f = b.ridgeFlat, yr = y0 + rise;
    gb.quad(P(-hw, -hd, y0), P(hw, -hd, y0), P(hw, -f, yr), P(-hw, -f, yr), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(-1, 1, 0));
    gb.quad(P(-hw, hd, y0), P(-hw, f, yr), P(hw, f, yr), P(hw, hd, y0), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(1, 1, 0));
    gb.quad(P(-hw, -f, yr), P(hw, -f, yr), P(hw, f, yr), P(-hw, f, yr), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, UP);
    for (const [ds, out] of [[-hw, V(0, 0, 1)], [hw, V(0, 0, -1)]]) {
      gb.quad(P(ds, -hd, y0), P(ds, -f, yr), P(ds, f, yr), P(ds, hd, y0), [[0, 0], [0.3, 1], [0.7, 1], [1, 0]], tileA, out);
    }
  } else if (b.ridgeAlong === 's') {
    const r = hip ? Math.max(0, hw - hd) : hw;
    const yr = y0 + rise;
    gb.quad(P(-hw, -hd, y0), P(hw, -hd, y0), P(r, 0, yr), P(-r, 0, yr), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(-1, 1, 0));
    gb.quad(P(-hw, hd, y0), P(-r, 0, yr), P(r, 0, yr), P(hw, hd, y0), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(1, 1, 0));
    gb.tri(P(-hw, -hd, y0), P(-r, 0, yr), P(-hw, hd, y0), [[0, 0], [0.5, 1], [1, 0]], hip ? snowA : tileA, V(0, 1, 1));
    gb.tri(P(hw, -hd, y0), P(hw, hd, y0), P(r, 0, yr), [[0, 0], [1, 0], [0.5, 1]], hip ? snowA : tileA, V(0, 1, -1));
  } else {
    const r = hip ? Math.max(0, hd - hw) : hd;
    const yr = y0 + rise;
    gb.quad(P(-hw, -hd, y0), P(-hw, hd, y0), P(0, r, yr), P(0, -r, yr), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(0, 1, 1));
    gb.quad(P(hw, -hd, y0), P(0, -r, yr), P(0, r, yr), P(hw, hd, y0), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(0, 1, -1));
    gb.tri(P(-hw, -hd, y0), P(0, -r, yr), P(hw, -hd, y0), [[0, 0], [0.5, 1], [1, 0]], hip ? snowA : tileA, V(-1, 1, 0));
    gb.tri(P(-hw, hd, y0), P(hw, hd, y0), P(0, r, yr), [[0, 0], [1, 0], [0.5, 1]], hip ? snowA : tileA, V(1, 1, 0));
  }
  // thick dark tile edge under the snow
  const yb = y0 - 0.3;
  const ring = [P(-hw, -hd, 0), P(hw, -hd, 0), P(hw, hd, 0), P(-hw, hd, 0)];
  const Y = (p, y) => V(p.x, y + p.y, p.z); // p.y carries the slope offset
  for (let i = 0; i < 4; i++) {
    const a = ring[i], c = ring[(i + 1) % 4];
    const out = V((a.x + c.x) / 2 - u, 0, (a.z + c.z) / 2 + s);
    gb.quad(Y(a, yb), Y(c, yb), Y(c, y0), Y(a, y0), [[0, -9], [1, -9], [1, -9], [0, -9]], tileA, out);
  }
  gb.quad(Y(ring[0], yb), Y(ring[1], yb), Y(ring[2], yb), Y(ring[3], yb), [[0, -9], [1, -9], [1, -9], [0, -9]], { color: [0.1, 0.07, 0.05], aFacade: [5, b.seed, 0, 0] }, V(0, -1, 0));
}

// Raised plazas with a flight of snowy stone steps down to the street.
function buildTerraces(w) {
  const tr = w.track;
  const stone = new THREE.Color(0x8a8780);
  for (const t of tr.structures.filter((x) => x.type === 'terrace')) {
    const gb = w.cityGB(t.s0, t.u0);
    const lo = Math.min(tr.ground(t.sEdge, t.u0), tr.ground(t.sEdge, t.u0 - t.w / 2), tr.ground(t.sEdge, t.u0 + t.w / 2)) - 1.2;
    // platform (top is snow)
    w._box(gb, (t.s0 + t.sEdge) / 2, t.u0, t.sEdge - t.s0, t.w, lo, t.yTop, lo, [5, 0.4, 0, 0], stone, true);
    // steps
    const n = Math.max(3, Math.round((t.drop) / 0.2));
    const len = t.sEnd - t.sEdge;
    for (let i = 0; i < n; i++) {
      const sa = t.sEdge + (i / n) * len, sb = t.sEdge + ((i + 1) / n) * len;
      const top = t.yTop + (t.sEnd - t.sEdge > 0 ? ((tr.ground(t.sEnd, t.u0) - t.yTop) * (i + 1)) / n : 0);
      const g = Math.min(tr.ground(sb, t.u0 - t.w / 2), tr.ground(sb, t.u0 + t.w / 2)) - 0.6;
      w._box(gb, (sa + sb) / 2, t.u0, sb - sa + 0.02, t.w, g, top, g, [5, 0.4 + i * 0.01, 0, 0], stone.clone().multiplyScalar(0.92 + (i % 2) * 0.06), true);
    }
    // low side walls
    for (const sd of [-1, 1]) w._box(gb, (t.s0 + t.sEnd) / 2, t.u0 + sd * (t.w / 2 + 0.2), t.sEnd - t.s0, 0.4, lo, t.yTop + 0.35, lo, [5, 0.4, 0, 0], stone.clone().multiplyScalar(0.8), true);
  }
}

function buildSkybridges(w) {
  const tr = w.track;
  const steel = new THREE.Color(0x4a5058);
  for (const b of tr.structures.filter((x) => x.type === 'skybridge')) {
    const gb = w.cityGB(b.s0, b.u0);
    const n = Math.max(2, Math.ceil((b.s1 - b.s0) / 1.5));
    for (let i = 0; i < n; i++) {
      const sa = b.s0 + ((b.s1 - b.s0) * i) / n, sb = b.s0 + ((b.s1 - b.s0) * (i + 1)) / n;
      const y = b.y0 + (b.y1 - b.y0) * ((i + 0.5) / n);
      w._box(gb, (sa + sb) / 2, b.u0, sb - sa + 0.05, b.w, y - 0.7, y, y, [5, 0.6, 0, 0], steel, true);
      for (const sd of [-1, 1]) w._box(gb, (sa + sb) / 2, b.u0 + sd * (b.w / 2 - 0.05), sb - sa + 0.05, 0.08, y, y + 1.05, y, [5, 0.6, 0, 0], new THREE.Color(0x9aa3ad), false);
    }
    // support columns down to the street
    for (const sp of [b.s0 + 2, (b.s0 + b.s1) / 2, b.s1 - 2]) {
      const y = b.y0 + (b.y1 - b.y0) * ((sp - b.s0) / (b.s1 - b.s0));
      for (const sd of [-1, 1]) {
        const uu = b.u0 + sd * (b.w / 2 - 0.3);
        w._box(gb, sp, uu, 0.3, 0.3, tr.ground(sp, uu) - 0.5, y - 0.7, tr.ground(sp, uu), [5, 0.6, 0, 0], steel, false);
      }
    }
    const mid = tr.toWorld((b.s0 + b.s1) / 2, b.u0, b.y0 - 1);
    w.lightSpots.push({ p: mid, color: new THREE.Color(0xd8e4ff), power: 10 });
  }
}

// ------------------------------------------------------------------ skyline beyond the city
function buildSkyline(w) {
  const tr = w.track;
  const L = tr.L;
  const rng = mulberry32(w.stage.seed + 808);
  const sk = L.skyline || { h: [30, 120], styles: [0, 1, 3], colors: [0x2a2c36, 0x3a3c46], lit: 0.3 };
  const edge = L.uHalf + L.margin;
  for (const side of [-1, 1]) {
    for (let s = L.sMin - 200; s < L.sMax + 300; s += rng.range(30, 60)) {
      for (let k = 0; k < 4; k++) {
        const u = side * (edge + 10 + k * 70 + rng.range(0, 40));
        const wd = rng.range(24, 44), dp = rng.range(24, 40);
        const g = tr.baseY(s) - 4 - k * 2;
        const H = rng.range(sk.h[0], sk.h[1]) * (1 + k * 0.25);
        const gb = w.cityGB(s, u);
        w._box(gb, s, u, wd, dp, g - 30, g + H, g, [rng.pick(sk.styles), rng(), sk.lit * rng.range(0.6, 1.3), 0], new THREE.Color(rng.pick(sk.colors)).multiplyScalar(rng.range(0.8, 1.2)), true);
        if (sk.pitched) w._gable(gb, s, u, wd, dp, g + H, 4, new THREE.Color(rng.pick(sk.colors)), rng(), { style: 2 });
      }
    }
  }
  // beyond the bottom of the map
  for (let u = -edge - 200; u < edge + 200; u += rng.range(30, 55)) {
    for (let k = 0; k < 3; k++) {
      const s = L.sMax + 20 + k * 70 + rng.range(0, 30);
      if (L.noSkylineBelow) continue;
      const g = tr.baseY(s) - 3;
      const H = rng.range(sk.h[0], sk.h[1]);
      const gb = w.cityGB(s, u);
      w._box(gb, s, u, rng.range(24, 40), rng.range(24, 40), g - 30, g + H, g, [rng.pick(sk.styles), rng(), sk.lit, 0], new THREE.Color(rng.pick(sk.colors)), true);
    }
  }
  // ground plane under the skyline
  const geo = new THREE.PlaneGeometry(edge * 2 + 900, L.sMax - L.sMin + 900, 1, 30).rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = -p.getZ(i) + (L.sMin + L.sMax) / 2;
    p.setZ(i, -s);
    p.setY(i, tr.baseY(s) - 3.5);
  }
  geo.computeVertexNormals();
  const col = new Float32Array(p.count * 3).fill(0.9);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  w.add(new THREE.Mesh(geo, w.mats.snow), { receive: true });
}

// ------------------------------------------------------------------ viaduct and trains
function buildViaducts(w) {
  const tr = w.track;
  const vs = tr.structures.filter((x) => x.type === 'viaduct');
  if (!vs.length) return;
  const conc = new THREE.Color(0x8c8a86), steel = new THREE.Color(0x56606a);
  w.trains = [];
  for (const v of vs) {
    const deckY = (s) => tr.ground(s, v.u) + v.h;
    // smooth the deck so trains do not bob over street bumps
    const S = [];
    for (let s = v.s0; s <= v.s1; s += 12) S.push([s, deckY(s)]);
    const yAt = (s) => {
      const f = clamp((s - v.s0) / 12, 0, S.length - 1.001);
      const i = Math.floor(f);
      return S[i][1] + (S[i + 1][1] - S[i][1]) * (f - i);
    };
    v.yAt = yAt;
    for (let s = v.s0; s < v.s1; s += 12) {
      const gb = w.cityGB(s, v.u);
      const y = yAt(s + 6);
      w._box(gb, s + 6, v.u, 12.05, v.w, y - 1.6, y, y, [5, 0.5, 0, 0], conc, true);
      for (const sd of [-1, 1]) w._box(gb, s + 6, v.u + sd * (v.w / 2 - 0.15), 12.05, 0.3, y, y + 1.1, y, [5, 0.5, 0, 0], conc, true);
      for (const off of [-2.6, -1.4, 1.4, 2.6]) w._box(gb, s + 6, v.u + off, 12.05, 0.12, y, y + 0.2, y, [5, 0.5, 0, 0], new THREE.Color(0x2a2a2a), false);
      if (Math.round(s) % 24 === 0) {
        w._box(gb, s, v.u, 2.4, 2.4, tr.ground(s, v.u) - 2, y - 1.6, tr.ground(s, v.u), [5, 0.5, 0, 0], conc, false);
        w._box(gb, s, v.u + v.w / 2 - 0.4, 0.25, 0.25, y, y + 6.4, y, [5, 0.5, 0, 0], steel, false);
        w._box(gb, s, v.u, 0.2, v.w - 0.6, y + 6.2, y + 6.4, y, [5, 0.5, 0, 0], steel, false);
        const p = tr.toWorld(s, v.u, y - 1.8);
        w.glowPts.pos.push(p.x, p.y, p.z);
        w.glowPts.col.push(0.35, 0.33, 0.3);
        w.glowPts.size.push(2.2);
      }
    }
    // trains in both directions
    for (const dir of [1, -1]) {
      const cars = [];
      const body = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.75, roughness: 0.3 });
      const stripe = new THREE.MeshStandardMaterial({ color: dir > 0 ? 0x3cb84a : 0xf08a1c, roughness: 0.4 });
      const winMat = w.emissive(0xfff0d0, 1.1);
      w.disposables.push(body, stripe);
      for (let i = 0; i < 6; i++) {
        const g = new THREE.Group();
        const car = new THREE.Mesh(new RoundedBoxGeometry(2.9, 3.4, 19.8, 2, 0.25), body);
        car.position.y = 2.25;
        const str = new THREE.Mesh(new THREE.BoxGeometry(2.92, 0.28, 19.82), stripe);
        str.position.y = 1.65;
        const win = new THREE.Mesh(new THREE.BoxGeometry(2.96, 0.95, 17.5), winMat);
        win.position.y = 2.75;
        const roof = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.16, 19.2), w.mats.plainSnow);
        roof.position.y = 4.0;
        g.add(car, str, win, roof);
        g.traverse((o) => { if (o.isMesh) o.castShadow = w.quality.shadows; });
        w.group.add(g);
        cars.push(g);
      }
      w.trains.push({ v, cars, dir, off: dir > 0 ? 0 : 900, lane: dir * 2.0, speed: 24 });
    }
  }
}

function updateCity(w, t) {
  if (w.seaMap) w.seaMap.offset.set(t * 0.004, t * 0.006);
  for (const T of w.trains || []) {
    const v = T.v;
    const len = v.s1 - v.s0 - 160;
    const head = ((t * T.speed + T.off) % (len + 600)) - 300;
    T.cars.forEach((g, i) => {
      const s = T.dir > 0 ? v.s0 + 80 + head - i * 20.2 : v.s1 - 80 - head + i * 20.2;
      const inside = s > v.s0 + 10 && s < v.s1 - 10;
      g.visible = inside;
      if (!inside) return;
      const y = v.yAt(s);
      const pitch = Math.atan2(v.yAt(s - 5) - v.yAt(s + 5), 10);
      g.position.set(v.u + T.lane, y, -s);
      g.rotation.set(pitch, 0, 0);
    });
  }
}

// Blue pedestrian footbridges over the avenue.
function buildFootbridges(w) {
  const tr = w.track;
  const steel = new THREE.Color(0x56606a), blue = new THREE.Color(0x2f6fb0);
  for (const f of tr.decor.footbridges) {
    const gb = w.cityGB(f.s, f.u);
    const g = tr.ground(f.s, f.u);
    const yb = g + 5.4;
    w._box(gb, f.s, f.u, 3.2, f.w, yb - 0.65, yb, yb, [5, 0.5, 0, 0], steel, true);
    w._box(gb, f.s - 1.55, f.u, 0.12, f.w, yb, yb + 1.2, yb, [5, 0.5, 0, 0], blue, true);
    w._box(gb, f.s + 1.55, f.u, 0.12, f.w, yb, yb + 1.2, yb, [5, 0.5, 0, 0], blue, true);
    for (const sd of [-1, 1]) {
      const uu = f.u + sd * (f.w / 2 - 1.2);
      for (const ds of [-1.2, 1.2]) {
        w._box(gb, f.s + ds, uu, 0.45, 0.45, tr.ground(f.s + ds, uu) - 1, yb - 0.65, tr.ground(f.s, uu), [5, 0.5, 0, 0], steel, false);
        tr.addObstacle({ s: f.s + ds, u: uu, r: 0.4, top: yb, kind: 'post' });
      }
    }
    const tex = bannerTexture(w.stage.id === 'golden' ? 'CENTRAL STA.  中央駅 →' : '新宿駅  SHINJUKU STA. →', [0x1d4fa0, 0x245cb8], 0xffffff);
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(0.9, 0.9, 0.9), side: THREE.DoubleSide });
    w.disposables.push(mat, tex);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 9 * 0.1875), mat);
    sign.position.set(f.u, yb + 0.25, -(f.s - 1.63));
    w.add(sign);
    for (const du of [-6, 0, 6]) {
      const p = V(f.u + du, yb - 0.75, -f.s);
      w.glowPts.pos.push(p.x, p.y, p.z);
      w.glowPts.col.push(0.45, 0.45, 0.42);
      w.glowPts.size.push(1.6);
      w.lightSpots.push({ p, color: new THREE.Color(0xfff2d8), power: 12 });
    }
  }
}

// Neon arch gates over a street (歌舞伎町一番街 style).
function buildNeonGates(w) {
  const tr = w.track;
  for (const g of tr.decor.neonGates) {
    const y0 = tr.ground(g.s, g.u);
    const gb = w.cityGB(g.s, g.u);
    const red = new THREE.Color(0x8a1020);
    for (const sd of [-1, 1]) {
      const uu = g.u + sd * g.w / 2;
      w._box(gb, g.s, uu, 0.6, 0.6, tr.ground(g.s, uu) - 0.5, y0 + 9, y0, [5, 0.3, 0, 0], red, true);
      tr.addObstacle({ s: g.s, u: uu, r: 0.45, top: y0 + 9, kind: 'post' });
    }
    const tex = neonSignTexture(g.text, g.color, false, 77);
    const h = 2.4, wd = Math.min(g.w - 1, h * tex.aspect);
    const mat = new THREE.MeshBasicMaterial({ map: tex.map, color: new THREE.Color(1.8, 1.8, 1.8), side: THREE.DoubleSide });
    w.disposables.push(mat, tex.map);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(wd, wd / tex.aspect), mat);
    sign.position.set(g.u, y0 + 7.4, -g.s);
    w.add(sign);
    w._box(gb, g.s, g.u, 0.5, g.w + 0.6, y0 + 8.7, y0 + 9.1, y0, [5, 0.3, 0, 0], red, true);
    const p = V(g.u, y0 + 7.4, -g.s);
    w.lightSpots.push({ p, color: new THREE.Color(g.color), power: 40 });
    w.glowPts.pos.push(p.x, p.y, p.z);
    const c = new THREE.Color(g.color).multiplyScalar(0.5);
    w.glowPts.col.push(c.r, c.g, c.b);
    w.glowPts.size.push(9);
    w.groundGlows.push({ s: g.s + 3, u: g.u, size: g.w + 4, color: g.color, k: 0.35 });
  }
}

// ------------------------------------------------------------------ street furniture
function buildStreetProps(w) {
  const tr = w.track;
  const P = tr.props;
  const st = w.stage;
  const lampColor = new THREE.Color(st.city.lamp);
  const M = (x, y, z, yaw = 0, sc = 1) => new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), V(sc, sc, sc));

  // --- lamps
  const poles = [], arms = [], heads = [], bulbs = [], posts = [], lanternHeads = [];
  for (const l of P.lamps) {
    const x = l.u, z = -l.s;
    if (l.style === 'lantern') {
      posts.push(M(x, l.y, z));
      lanternHeads.push(M(x, l.y + 1.9, z));
      const p = V(x, l.y + 1.9, z);
      w.glowPts.pos.push(p.x, p.y, p.z);
      w.glowPts.col.push(0.6, 0.36, 0.14);
      w.glowPts.size.push(1.8);
      w.lightSpots.push({ p, color: new THREE.Color(0xffa050), power: 10 });
      w.groundGlows.push({ s: l.s, u: l.u, size: 4.5, color: 0xff9a40, k: 0.45 });
      continue;
    }
    // arm reaches out over the road (towards l.dir in u)
    const yaw = l.dir > 0 ? 0 : Math.PI;
    poles.push(M(x, l.y, z, yaw));
    arms.push(M(x + l.dir * 0.65, l.y + 6.3, z, yaw));
    heads.push(M(x + l.dir * 1.35, l.y + 6.2, z, yaw));
    const bp = V(x + l.dir * 1.35, l.y + 6.08, z);
    bulbs.push(M(bp.x, bp.y, bp.z, yaw));
    w.lightSpots.push({ p: bp.clone().setY(bp.y - 0.4), color: lampColor, power: 38 });
    w.glowPts.pos.push(bp.x, bp.y - 0.1, bp.z);
    const gc = lampColor.clone().multiplyScalar(0.55);
    w.glowPts.col.push(gc.r, gc.g, gc.b);
    w.glowPts.size.push(3.2);
    w.groundGlows.push({ s: l.s, u: l.u + l.dir * 1.35, size: 9, color: st.city.lamp, k: 0.4 });
  }
  const sh = w.quality.shadows;
  w._instanced(new THREE.CylinderGeometry(0.07, 0.11, 6.4, 8).translate(0, 3.2, 0), w.mats.darkMetal, poles, { cast: sh });
  w._instanced(new THREE.BoxGeometry(1.4, 0.07, 0.07), w.mats.darkMetal, arms);
  w._instanced(new THREE.BoxGeometry(0.75, 0.16, 0.35), w.mats.darkMetal, heads);
  w._instanced(new THREE.BoxGeometry(0.6, 0.04, 0.26), w.emissive(st.city.lamp, 6), bulbs);
  if (st.night > 0.5 || st.id !== 'golden') w._lightCones(bulbs, lampColor);
  w._instanced(new THREE.CylinderGeometry(0.06, 0.08, 1.7, 6).translate(0, 0.85, 0), w.mats.wood, posts, { cast: sh });
  w._instanced(new THREE.BoxGeometry(0.34, 0.42, 0.34), w.emissive(0xffa040, 2.6), lanternHeads);

  // --- traffic signals (shared with the street stages)
  for (const g of P.signals) w.signals.push({ base: V(g.u, g.y, -g.s), yaw: 0, side: g.side, s: g.s });
  w._buildSignals();

  // --- power poles and wires
  if (P.poles.length) {
    const poleList = [], armList = [];
    const byStreet = new Map();
    for (const p of P.poles) {
      poleList.push(M(p.u, p.y, -p.s));
      armList.push(M(p.u, p.y + 8.6, -p.s, Math.PI / 2));
      if (!byStreet.has(p.street)) byStreet.set(p.street, []);
      byStreet.get(p.street).push(p);
    }
    for (const list of byStreet.values()) {
      list.sort((a, b) => a.s - b.s);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        if (b.s - a.s > 50) continue;
        for (const o of [-0.9, 0, 0.9]) w._wire(V(a.u + o, a.y + 8.65, -a.s), V(b.u + o, b.y + 8.65, -b.s), 0.9);
        if (i % 3 === 0) w._wire(V(b.u, b.y + 8.3, -b.s), V(b.u - 14, b.y + 7.6, -b.s - 2), 1.4);
      }
    }
    w._instanced(new THREE.CylinderGeometry(0.14, 0.18, 9.4, 8).translate(0, 4.7, 0), w.mats.concrete, poleList, { cast: sh });
    w._instanced(new THREE.BoxGeometry(0.12, 0.12, 2.6), w.mats.darkMetal, armList);
  }

  // --- vending machines
  if (P.vending.length) {
    const texs = [0, 1, 2].map((i) => vendingTexture(st.seed + i));
    const lists = [[], [], []];
    let k = 0;
    for (const v of P.vending) {
      for (let i = 0; i < v.n; i++) {
        const s = v.s + i * 1.05;
        lists[k++ % 3].push(M(v.u, v.y + 0.92, -s, v.face > 0 ? Math.PI / 2 : -Math.PI / 2));
      }
      w.groundGlows.push({ s: v.s + 0.5, u: v.u + v.face * 1.5, size: 4.5, color: 0xd8f0ff, k: 0.45 });
      w.lightSpots.push({ p: V(v.u + v.face * 1.2, v.y + 1.2, -v.s), color: new THREE.Color(0xd0f0ff), power: 6 });
    }
    const vg = new THREE.BoxGeometry(1.0, 1.84, 0.8);
    texs.forEach((t, i) => {
      const side = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.4, metalness: 0.2 });
      const front = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: new THREE.Color(1.6, 1.6, 1.6), roughness: 0.25 });
      w.disposables.push(side, front, t);
      w._instanced(vg, [side, side, w.mats.plainSnow, side, front, side], lists[i], { cast: sh });
    });
  }

  // --- chochin lantern strings across narrow alleys
  if (P.chochin.length) {
    const list = [];
    for (const c of P.chochin) {
      const a = V(c.u - c.w / 2, c.y + 0.6, -c.s), b = V(c.u + c.w / 2, c.y + 0.6, -c.s);
      const n = Math.max(3, Math.round(c.w / 1.4));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const p = V().lerpVectors(a, b, t);
        p.y -= Math.sin(t * Math.PI) * 0.5 + 0.35;
        list.push(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
        if (i % 2) {
          w.glowPts.pos.push(p.x, p.y, p.z);
          w.glowPts.col.push(0.7, 0.18, 0.08);
          w.glowPts.size.push(1.6);
        }
      }
      w._wire(a, b, 0.5);
      w.lightSpots.push({ p: V(c.u, c.y - 0.6, -c.s), color: new THREE.Color(0xff6030), power: 14 });
      w.groundGlows.push({ s: c.s, u: c.u, size: c.w + 2, color: 0xff5a28, k: 0.35 });
    }
    const g = new THREE.SphereGeometry(0.24, 8, 6).scale(1, 1.35, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc02818, emissive: new THREE.Color(0xff4a1a), emissiveIntensity: 2.2, roughness: 0.6 });
    w.disposables.push(mat);
    w._instanced(g, mat, list);
  }
  w._buildWires();

  // --- torii gates
  if (P.torii.length) {
    const ver = new THREE.MeshStandardMaterial({ color: 0xc8321e, roughness: 0.55 });
    const black = new THREE.MeshStandardMaterial({ color: 0x1a1414, roughness: 0.6 });
    w.disposables.push(ver, black);
    const pil = [], beam = [], top = [], snow = [];
    for (const t of P.torii) {
      for (const sd of [-1, 1]) pil.push(new THREE.Matrix4().compose(V(t.u + sd * t.w / 2, t.y, -t.s), new THREE.Quaternion(), V(1, t.h, 1)));
      beam.push(new THREE.Matrix4().compose(V(t.u, t.y + t.h * 0.78, -t.s), new THREE.Quaternion(), V(t.w + 0.9, 1, 1)));
      top.push(new THREE.Matrix4().compose(V(t.u, t.y + t.h + 0.12, -t.s), new THREE.Quaternion(), V(t.w + 2.4, 1, 1)));
      snow.push(new THREE.Matrix4().compose(V(t.u, t.y + t.h + 0.32, -t.s), new THREE.Quaternion(), V(t.w + 2.3, 1, 1)));
    }
    w._instanced(new THREE.CylinderGeometry(0.22, 0.26, 1, 12).translate(0, 0.5, 0), ver, pil, { cast: w.quality.shadows });
    w._instanced(new THREE.BoxGeometry(1, 0.32, 0.3), ver, beam);
    w._instanced(new THREE.BoxGeometry(1, 0.28, 0.5), black, top, { cast: w.quality.shadows });
    w._instanced(new THREE.BoxGeometry(1, 0.12, 0.46), w.mats.plainSnow, snow);
  }

  // --- stone lanterns
  if (P.stoneLanterns.length) {
    const base = [], lights = [];
    for (const l of P.stoneLanterns) {
      base.push(M(l.u, l.y, -l.s));
      lights.push(M(l.u, l.y + 1.25, -l.s));
      w.glowPts.pos.push(l.u, l.y + 1.25, -l.s);
      w.glowPts.col.push(0.6, 0.35, 0.12);
      w.glowPts.size.push(1.8);
      w.groundGlows.push({ s: l.s, u: l.u, size: 4, color: 0xff9a40, k: 0.5 });
    }
    w._instanced(w._lanternGeometry(), w.mats.stone, base, { cast: w.quality.shadows });
    w._instanced(new THREE.BoxGeometry(0.34, 0.3, 0.34), w.emissive(0xffa040, 3), lights);
  }

  // --- trees
  if (P.trees.length) {
    const tg = w._treeGeometry();
    const list = P.trees.map((t) => new THREE.Matrix4().compose(V(t.u, t.y - 0.1, -t.s), new THREE.Quaternion().setFromAxisAngle(UP, t.rot ?? 0), V(t.sc ?? 1, (t.sc ?? 1) * 1.1, t.sc ?? 1)));
    w._instanced(tg, w.mats.vegetation, list, { cast: w.quality.shadows });
    for (const t of P.trees.filter((q) => q.lights)) {
      for (let k = 0; k < 14; k++) {
        const f = k / 14, a = k * 2.4;
        const rr = (1 - f) * 1.6 * (t.sc ?? 1);
        w.glowPts.pos.push(t.u + Math.cos(a) * rr, t.y + (1.2 + f * 4.5) * (t.sc ?? 1), -t.s + Math.sin(a) * rr);
        const c = new THREE.Color(t.lights).multiplyScalar(0.9);
        w.glowPts.col.push(c.r, c.g, c.b);
        w.glowPts.size.push(0.5);
      }
    }
  }
}

// ------------------------------------------------------------------ neon signs and screens
function buildFacadeSigns(w) {
  const tr = w.track;
  const st = w.stage;
  const city = st.city;
  const rng = mulberry32(st.seed + 99);
  const texCache = new Map();
  const groups = new Map();
  const getTex = (text, color, vertical) => {
    const key = text + color + vertical;
    if (!texCache.has(key)) texCache.set(key, neonSignTexture(text, color, vertical, rng.int(1, 9999)));
    return texCache.get(key);
  };
  const addPlane = (tex, w2, h, pos, yaw, intensity) => {
    const key = tex.map.uuid;
    if (!groups.has(key)) {
      const mat = new THREE.MeshBasicMaterial({ map: tex.map, color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide });
      w.disposables.push(mat, tex.map);
      groups.set(key, { mat, geos: [] });
    }
    const g = new THREE.PlaneGeometry(w2, h);
    g.applyMatrix4(new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromAxisAngle(UP, yaw), V(1, 1, 1)));
    groups.get(key).geos.push(g);
  };
  const neonAmt = city.neon;
  if (neonAmt > 0) {
    for (const b of w.frontBuildings) {
      if (b.rooftop && rng() < 0.6) continue;
      if ((b.style === 0 || b.style === 3) && rng() > neonAmt * 0.35) continue;
      const fi = faceInfo(b, b.face || { du: -1, ds: 0 });
      const n = Math.round(rng() * 3 * neonAmt + (neonAmt > 0.5 ? 0.6 : 0));
      for (let i = 0; i < n; i++) {
        const text = rng.pick(city.signs);
        const color = rng.pick(city.neonColors);
        const vertical = rng() < 0.62;
        const tex = getTex(text, color, vertical);
        const o = rng.range(-fi.len / 2 + 0.8, fi.len / 2 - 0.8);
        if (vertical) {
          const sw = rng.range(1.1, 1.6), sh = sw / tex.aspect;
          const maxY = Math.max(5, b.H - sh - 1);
          const y = b.base + 4.5 + rng() * Math.min(maxY - 4.5, 14) + sh / 2;
          // hangs off the facade, plane perpendicular to it
          const pos = fi.du ? V(fi.u + fi.du * (sw / 2 + 0.2), y, -(b.s + o)) : V(b.u + o, y, -(fi.s + fi.ds * (sw / 2 + 0.2)));
          addPlane(tex, sw, sh, pos, fi.du ? 0 : Math.PI / 2, 1.7);
          w.lightSpots.push({ p: pos, color: new THREE.Color(color), power: 14 });
          w.glowPts.pos.push(pos.x, pos.y, pos.z);
          const gc = new THREE.Color(color).multiplyScalar(0.35);
          w.glowPts.col.push(gc.r, gc.g, gc.b);
          w.glowPts.size.push(sh * 2.2);
          if (fi.du) w.groundGlows.push({ s: b.s + o, u: fi.u + fi.du * 3, size: 6, color, k: 0.3 });
        } else {
          const sh = rng.range(1.1, 1.6);
          const sw = Math.min(sh * tex.aspect, fi.len - 1);
          const hh = sw / tex.aspect;
          const y = b.base + (b.style === 2 ? 3.4 : 4.9) + hh / 2;
          const pos = fi.du ? V(fi.u + fi.du * 0.06, y, -(b.s + o * 0.3)) : V(b.u + o * 0.3, y, -(fi.s + fi.ds * 0.06));
          addPlane(tex, sw, hh, pos, fi.du ? (fi.du > 0 ? Math.PI / 2 : -Math.PI / 2) : (fi.ds > 0 ? Math.PI : 0), 1.5);
          if (fi.du) w.groundGlows.push({ s: b.s, u: fi.u + fi.du * 2.5, size: 5, color, k: 0.25 });
        }
      }
    }
  }
  for (const { mat, geos } of groups.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    geos.forEach((g) => g.dispose());
    w.add(mesh);
  }
  // giant video screens facing plazas
  for (const sc of tr.decor.screens) {
    const g = new THREE.PlaneGeometry(sc.w, sc.w * 0.5625);
    const mesh = new THREE.Mesh(g, createScreenMaterial(sc.seed ?? Math.random()));
    w.disposables.push(mesh.material);
    mesh.position.set(sc.u, sc.y, -sc.s);
    mesh.rotation.y = sc.yaw;
    w.add(mesh);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(sc.w + 0.5, sc.w * 0.5625 + 0.5, 0.3), w.mats.darkMetal);
    frame.position.copy(mesh.position).add(V(-Math.sin(sc.yaw) * 0.2, 0, -Math.cos(sc.yaw) * 0.2));
    frame.rotation.y = sc.yaw;
    w.add(frame);
    w.lightSpots.push({ p: mesh.position.clone(), color: new THREE.Color(0x88aaff), power: 40 });
  }
}

// ------------------------------------------------------------------ landmarks
function buildLandmarks(w) {
  const tr = w.track;
  for (const lm of tr.decor.landmarks) {
    if (lm.type === 'station') {
      const tex = bannerTexture(lm.name, [0x1d4fa0, 0x245cb8], 0xffffff);
      const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.3, 1.3, 1.3) });
      w.disposables.push(mat, tex);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(36, 36 * 0.1875), mat);
      const y = tr.ground(lm.s - 1, lm.u) + 13;
      sign.position.set(lm.u, y, -(lm.s - 0.6));
      w.add(sign);
      w.lightSpots.push({ p: V(lm.u, y - 3, -(lm.s - 4)), color: new THREE.Color(0xd8e8ff), power: 60 });
    } else if (lm.type === 'scramble') {
      // zebra crossings painted through the snow
      const geos = [];
      for (let i = -8; i <= 8; i++) {
        for (const [ds, du, len, rot] of [[-lm.d / 2 + 6, i * 1.6, 5, 0], [lm.d / 2 - 6, i * 1.6, 5, 0]]) {
          const g = new THREE.PlaneGeometry(0.8, len).rotateX(-Math.PI / 2);
          const s = lm.s + ds, u = lm.u + du;
          g.rotateY(rot);
          g.translate(u, tr.ground(s, u) + 0.03, -s);
          geos.push(g);
        }
      }
      for (let k = -1; k <= 1; k += 2) {
        for (let i = -10; i <= 10; i++) {
          const g = new THREE.PlaneGeometry(5, 0.8).rotateX(-Math.PI / 2);
          const s = lm.s + i * 1.6, u = lm.u + k * (lm.w / 2 - 14);
          g.translate(u, tr.ground(s, u) + 0.03, -s);
          geos.push(g);
        }
        // diagonals of the scramble
        for (let i = -12; i <= 12; i++) {
          const g = new THREE.PlaneGeometry(0.8, 4.5).rotateX(-Math.PI / 2).rotateY(k * Math.PI / 4);
          const s = lm.s + i * 1.6, u = lm.u + k * i * 1.6;
          g.translate(u, tr.ground(s, u) + 0.035, -s);
          geos.push(g);
        }
      }
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -2 });
      w.disposables.push(mat);
      w.add(new THREE.Mesh(mergeGeometries(geos), mat), { receive: true });
    } else if (lm.type === 'skytower') {
      // tapering steel tower with an observation deck and aviation lights
      const gb = w.cityGB(lm.s, lm.u);
      const g = tr.ground(lm.s, lm.u);
      const steel = new THREE.Color(0xc8cdd4), dark = new THREE.Color(0x4a5058);
      const H = 240;
      for (let i = 0; i < 12; i++) {
        const y0 = g + (i / 12) * H, y1 = g + ((i + 1) / 12) * H;
        const wd = 16 * (1 - i / 14);
        w._box(gb, lm.s, lm.u, wd, wd, y0, y1, g, [3, 0.31, 0.25, 0], i % 2 ? steel : steel.clone().multiplyScalar(0.92), false);
      }
      w._box(gb, lm.s, lm.u, 22, 22, g + 150, g + 162, g, [0, 0.33, 0.7, 0], dark, true);
      w._box(gb, lm.s, lm.u, 24, 24, g + 162, g + 163, g, [5, 0.3, 0, 1], steel, true);
      w._box(gb, lm.s, lm.u, 1.2, 1.2, g + H, g + H + 40, g, [5, 0.3, 0, 0], steel, false);
      for (const y of [g + 100, g + 163, g + H, g + H + 40]) w._aviation(lm.s, lm.u, y);
      w.lightSpots.push({ p: V(lm.u, g + 4, -lm.s), color: new THREE.Color(0xffd9a0), power: 40 });
    } else if (lm.type === 'sea') {
      const y = tr.baseY(lm.s) - 1.6;
      const g = new THREE.PlaneGeometry(6000, 3000).rotateX(-Math.PI / 2).translate(0, y, -(lm.s + 1500));
      const nm = w.mats.snow.normalMap.clone();
      nm.repeat.set(220, 110);
      nm.wrapS = nm.wrapT = THREE.RepeatWrapping;
      nm.needsUpdate = true;
      const mat = new THREE.MeshStandardMaterial({ color: 0x1b2c44, roughness: 0.08, metalness: 0.6, normalMap: nm, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.6 });
      w.disposables.push(mat, nm);
      const sea = new THREE.Mesh(g, mat);
      sea.receiveShadow = true;
      w.add(sea);
      w.seaMap = nm;
      // a pier and a few moored boats
      const gb = w.cityGB(lm.s + 40, 0);
      const py = y + 2.2;
      w._box(gb, lm.s + 60, 120, 120, 8, y - 4, py, py, [5, 0.5, 0, 0], new THREE.Color(0x6a5a48), true);
      for (let k = 0; k < 8; k++) w._box(gb, lm.s + 6 + k * 15, 124.5, 0.25, 0.25, py, py + 3, py, [5, 0.5, 0, 0], new THREE.Color(0x2a2a2a), false);
      for (const [ds, u] of [[30, 95], [50, 150], [80, 92], [26, -60], [70, -140]]) {
        w._box(gb, lm.s + ds, u, 9, 3.2, y - 0.5, y + 1.0, y, [5, 0.5, 0, 0], new THREE.Color(0xe8e4dc), true);
        w._box(gb, lm.s + ds - 1, u, 3.5, 2.4, y + 1.0, y + 2.4, y, [0, 0.5, 0.6, 0], new THREE.Color(0xe8e4dc), true);
      }
    } else if (lm.type === 'pagoda') {
      const gb = w.cityGB(lm.s, lm.u);
      const g = tr.ground(lm.s, lm.u);
      const red = new THREE.Color(0x8a2a1a);
      let y = g;
      for (let i = 0; i < 5; i++) {
        const wd = 12 - i * 1.6, h = i === 0 ? 5.2 : 3.9;
        w._box(gb, lm.s, lm.u, wd, wd, y - (i === 0 ? 1 : 0), y + h, y, [2, 0.5 + i * 0.05, 0.45, 0], red, false);
        const rb = { s: lm.s, u: lm.u, hw: wd / 2 + 2.6, hd: wd / 2 + 2.6, ye: y + h - 0.1, rise: 1.6, roofKind: 'hip', ridgeAlong: 's', seed: 0.4 + i * 0.1, style: 2 };
        pitchedRoof(gb, rb);
        y += h + 1.6;
      }
      w._box(gb, lm.s, lm.u, 0.5, 0.5, y, y + 9, y, [5, 0.4, 0, 0], new THREE.Color(0x8a7a50), false);
      for (let k = 0; k < 9; k++) w._box(gb, lm.s, lm.u, 1.2, 1.2, y + 1 + k * 0.8, y + 1.2 + k * 0.8, y, [5, 0.4, 0, 0], new THREE.Color(0x8a7a50), false);
      w.lightSpots.push({ p: V(lm.u, g + 3, -lm.s + 8), color: new THREE.Color(0xffa050), power: 30 });
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.78;
        const p = V(lm.u + Math.cos(a) * 9, g + 0.2, -lm.s + Math.sin(a) * 9);
        w.groundGlows.push({ s: -p.z, u: p.x, size: 10, color: 0xff9a40, k: 0.35 });
      }
    } else if (lm.type === 'templegate') {
      const gb = w.cityGB(lm.s, lm.u);
      const g = tr.ground(lm.s, lm.u);
      const red = new THREE.Color(0xb02a18), white = new THREE.Color(0xe8e2d4);
      for (const du of [-7.4, -2.6, 2.6, 7.4]) for (const ds of [-2.2, 2.2]) w._box(gb, lm.s + ds, lm.u + du, 0.8, 0.8, g - 0.5, g + 7, g, [5, 0.5, 0, 0], red, false);
      w._box(gb, lm.s, lm.u, 5.6, lm.w + 1, g + 7, g + 10.5, g, [2, 0.62, 0.5, 0], white, false);
      pitchedRoof(gb, { s: lm.s, u: lm.u, hw: 5.2, hd: lm.w / 2 + 2.2, ye: g + 10.4, rise: 3, roofKind: 'hip', ridgeAlong: 'u', seed: 0.6, style: 2 });
      for (const du of [-7.4, 7.4]) {
        const p = V(lm.u + du, g + 5.5, -(lm.s - 2.6));
        w.glowPts.pos.push(p.x, p.y, p.z);
        w.glowPts.col.push(0.7, 0.3, 0.1);
        w.glowPts.size.push(3);
      }
      w.lightSpots.push({ p: V(lm.u, g + 5, -(lm.s - 4)), color: new THREE.Color(0xff9a40), power: 40 });
    } else if (lm.type === 'temple') {
      const gb = w.cityGB(lm.s, lm.u);
      const g = tr.ground(lm.s, lm.u);
      w._box(gb, lm.s, lm.u, 24, 34, g - 1, g + 1.2, g, [5, 0.5, 0, 0], new THREE.Color(0x8a8780), true);
      w._box(gb, lm.s, lm.u, 20, 30, g + 1.2, g + 9, g + 1.2, [2, 0.72, 0.55, 0], new THREE.Color(0x6a3a24), false);
      pitchedRoof(gb, { s: lm.s, u: lm.u, hw: 13.5, hd: 18.5, ye: g + 8.9, rise: 7, roofKind: 'hip', ridgeAlong: 'u', seed: 0.72, style: 2 });
      w.lightSpots.push({ p: V(lm.u, g + 4, -(lm.s - 14)), color: new THREE.Color(0xffa050), power: 50 });
    } else if (lm.type === 'shrine') {
      const gb = w.cityGB(lm.s, lm.u);
      const g = tr.ground(lm.s, lm.u);
      w._box(gb, lm.s, lm.u, 12, 9, g - 1, g + 5, g, [2, 0.7, 0.6, 0], new THREE.Color(0x6a3a24), false);
      w._gable(gb, lm.s, lm.u, 12, 9, g + 5, 3.6, new THREE.Color(0x3a2a22), 0.7, { style: 2 });
    }
  }
}

// ------------------------------------------------------------------ canals, bridges, decks, water
function iceMaterial(w) {
  if (w.mats.ice) return w.mats.ice;
  const m = new THREE.MeshPhysicalMaterial({ color: 0xc4ddef, roughness: 0.07, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  w.disposables.push(m);
  w.mats.ice = m;
  return m;
}

// A strip of ice following the ground (canal or river bed).
function iceStrip(w, pts) {
  const geo = new THREE.BufferGeometry();
  const pos = [], idx = [];
  pts.forEach(([a, b], i) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    if (i) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  });
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if (geo.attributes.normal.getY(0) < 0) {
    const ia = geo.index.array;
    for (let i = 0; i < ia.length; i += 3) { const t = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = t; }
    geo.computeVertexNormals();
  }
  w.add(new THREE.Mesh(geo, iceMaterial(w)), { receive: true });
}

function buildCityStructures(w) {
  const tr = w.track;
  const stoneC = new THREE.Color(0x8a8780), conc = new THREE.Color(0x9a978f);
  for (const st of tr.structures) {
    if (st.type === 'canal') {
      const pts = [];
      for (let s = st.s0; s <= st.s1; s += 4) pts.push([V(st.u - st.hw - 0.4, tr.ground(s, st.u) + 0.04, -s), V(st.u + st.hw + 0.4, tr.ground(s, st.u) + 0.04, -s)]);
      iceStrip(w, pts);
      // stone coping along both edges
      for (let s = st.s0; s < st.s1; s += 8) {
        if (tr.cross.some((c) => Math.abs(c.s - s - 4) < c.hw + 2)) continue;
        for (const sd of [-1, 1]) {
          const u = st.u + sd * (st.hw + st.bank + 0.4);
          const gb = w.cityGB(s, u);
          const g = tr.ground(s + 4, u);
          w._box(gb, s + 4, u, 8.05, 0.6, g - 0.5, g + 0.25, g, [5, 0.4, 0, 0], stoneC, true);
        }
      }
    } else if (st.type === 'river') {
      const pts = [];
      for (let u = -tr.L.uHalf - tr.L.margin; u <= tr.L.uHalf + tr.L.margin; u += 8) pts.push([V(u, tr.ground(st.s + st.hw, u) + 0.04, -(st.s + st.hw + 0.4)), V(u, tr.ground(st.s - st.hw, u) + 0.04, -(st.s - st.hw - 0.4))]);
      iceStrip(w, pts);
      const rng = mulberry32(5);
      const rocks = [];
      for (let u = -tr.L.uHalf; u < tr.L.uHalf; u += rng.range(3, 7)) {
        const s = st.s + (rng() < 0.5 ? -1 : 1) * (st.hw + rng.range(0.5, 3));
        rocks.push(new THREE.Matrix4().compose(V(u, tr.ground(s, u) - 0.2, -s), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng() * 6, 0)), V(rng.range(0.6, 1.2), rng.range(0.3, 0.6), rng.range(0.6, 1.2))));
      }
      w._instanced(new THREE.DodecahedronGeometry(1, 0), w.mats.stone, rocks, { receive: true });
    } else if (st.type === 'bridge') {
      if (st.along === 'u') {
        const gb = w.cityGB(st.s, (st.u0 + st.u1) / 2);
        w._box(gb, st.s, (st.u0 + st.u1) / 2, st.half * 2, st.u1 - st.u0, st.y - 1.0, st.y, st.y, [5, 0.5, 0, 0], conc, true);
        for (const sd of [-1, 1]) w._box(gb, st.s + sd * (st.half - 0.15), (st.u0 + st.u1) / 2, 0.3, st.u1 - st.u0 - 2, st.y, st.y + 1.0, st.y, [5, 0.5, 0, 0], new THREE.Color(0x6d7480), true);
      } else {
        // arched timber bridge with vermilion railings
        const gb = w.cityGB((st.s0 + st.s1) / 2, st.u);
        const n = 18;
        const yAt = (s) => st.y0 + (st.y1 - st.y0) * ((s - st.s0) / (st.s1 - st.s0)) + st.arch * Math.sin(((s - st.s0) / (st.s1 - st.s0)) * Math.PI);
        for (let i = 0; i < n; i++) {
          const sa = st.s0 + ((st.s1 - st.s0) * i) / n, sb = st.s0 + ((st.s1 - st.s0) * (i + 1)) / n;
          const y = yAt((sa + sb) / 2);
          w._box(gb, (sa + sb) / 2, st.u, sb - sa + 0.04, st.w, y - 0.5, y, y, [5, 0.6, 0, 0], new THREE.Color(0x5a3a28), true);
          for (const sd of [-1, 1]) w._box(gb, (sa + sb) / 2, st.u + sd * (st.w / 2 - 0.1), sb - sa + 0.04, 0.16, y + 0.9, y + 1.05, y, [5, 0.6, 0, 0], new THREE.Color(0xb8321e), true);
          if (i % 3 === 0) for (const sd of [-1, 1]) w._box(gb, sa, st.u + sd * (st.w / 2 - 0.1), 0.2, 0.2, y, y + 1.1, y, [5, 0.6, 0, 0], new THREE.Color(0xb8321e), true);
        }
        for (const ss of [st.s0 + 12, st.s1 - 12]) for (const sd of [-1, 1]) {
          const u = st.u + sd * (st.w / 2 - 1);
          w._box(gb, ss, u, 0.7, 0.7, tr.ground(ss, u) - 0.5, yAt(ss) - 0.5, tr.ground(ss, u), [5, 0.6, 0, 0], new THREE.Color(0x3a2a20), false);
        }
      }
    } else if (st.type === 'skyway') {
      const deck = new THREE.Color(0x8c8a86), barrier = new THREE.Color(0xb4b0a8);
      for (let s = st.s0; s < st.s1; s += 6) {
        if (s + 6 > st.gap[0] && s < st.gap[1]) continue;
        const gb = w.cityGB(s, st.u);
        const y = st.deckY(s + 3);
        const h = st.hAt(s + 3);
        w._box(gb, s + 3, st.u, 6.05, st.w, y - Math.min(1.6, h + 0.5), y, y, [5, 0.55, 0, 0], deck, true);
        if (s > 56) for (const sd of [-1, 1]) w._box(gb, s + 3, st.u + sd * (st.w / 2), 6.05, 0.5, y, y + 1.0, y, [5, 0.55, 0, 0], barrier, true);
        if (Math.round(s) % 30 === 0 && h > 3) {
          const g = tr.ground(s, st.u);
          w._box(gb, s, st.u, 2.6, 3.2, g - 1, y - 1.5, g, [5, 0.55, 0, 0], deck.clone().multiplyScalar(0.9), false);
          w._box(gb, s, st.u, 2.2, st.w - 1, y - 2.4, y - 1.5, g, [5, 0.55, 0, 0], deck.clone().multiplyScalar(0.85), true);
        }
        if (Math.round(s) % 36 === 0 && s > 60) {
          // lamps on the barrier
          const p = V(st.u - st.w / 2 + 1.4, y + 8, -s);
          const pole = new THREE.Matrix4().makeTranslation(st.u - st.w / 2, y + 1, -s);
          (w._skyLamps ||= []).push(pole);
          w.glowPts.pos.push(p.x, p.y, p.z);
          w.glowPts.col.push(0.55, 0.45, 0.3);
          w.glowPts.size.push(3);
          w.lightSpots.push({ p, color: new THREE.Color(0xffd9a0), power: 26 });
        }
      }
      // broken ends of the gap with bent rebar
      const rebar = [];
      for (const [s, dir] of [[st.gap[0], 1], [st.gap[1], -1]]) {
        const y = st.deckY(s);
        for (let u = st.u - st.w / 2 + 0.6; u < st.u + st.w / 2; u += 0.9) {
          rebar.push(new THREE.Matrix4().compose(V(u, y - 0.4, -(s + dir * 0.6)), new THREE.Quaternion().setFromEuler(new THREE.Euler(dir * 1.2 + (u % 0.5), 0, 0)), V(1, 1, 1)));
        }
      }
      w._instanced(new THREE.CylinderGeometry(0.02, 0.02, 1.4, 4), w.mats.darkMetal, rebar);
      if (w._skyLamps) w._instanced(new THREE.CylinderGeometry(0.08, 0.1, 7, 6).translate(0, 3.5, 0), w.mats.darkMetal, w._skyLamps);
      // green highway signs
      for (const ss of [120, 520, 1100]) {
        const y = st.deckY(ss);
        const tex = bannerTexture(ss === 120 ? 'SKYWAY ▲ HARBOR' : ss === 520 ? '工事中 ROAD CLOSED' : 'EXIT ▶ WATERFRONT', ss === 520 ? [0xc06010, 0xe08a1c] : [0x1d6a3a, 0x248a4a], 0xffffff);
        const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.1, 1.1, 1.1), side: THREE.DoubleSide });
        w.disposables.push(mat, tex);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(12, 2.25), mat);
        sign.position.set(st.u, y + 6.8, -ss);
        w.add(sign);
        const gb = w.cityGB(ss, st.u);
        for (const sd of [-1, 1]) w._box(gb, ss, st.u + sd * 6.4, 0.3, 0.3, y + 1, y + 8, y, [5, 0.5, 0, 0], new THREE.Color(0x56606a), false);
      }
    } else if (st.type === 'pond') {
      const g = new THREE.CircleGeometry(st.r + 1, 48).rotateX(-Math.PI / 2);
      const y = tr.ground(st.s, st.u) + 0.05;
      g.translate(st.u, y, -st.s);
      w.add(new THREE.Mesh(g, iceMaterial(w)), { receive: true });
      // low stone rim
      const rim = new THREE.TorusGeometry(st.r + 1.2, 0.35, 6, 64).rotateX(Math.PI / 2).translate(st.u, y + 0.1, -st.s);
      w.add(new THREE.Mesh(rim, w.mats.stone), { receive: true });
    } else if (st.type === 'promenade') {
      // sea wall railing along the water
      const gb = w.cityGB(st.s1, 0);
      const y = tr.ground(1648, 0);
      for (let u = -tr.L.uHalf - 40; u < tr.L.uHalf + 40; u += 2.5) {
        w._box(gb, 1648.5, u, 0.12, 0.12, y, y + 1.1, y, [5, 0.5, 0, 0], new THREE.Color(0x3a3f46), false);
      }
      w._box(gb, 1648.5, 0, 0.14, (tr.L.uHalf + 40) * 2, y + 1.0, y + 1.12, y, [5, 0.5, 0, 0], new THREE.Color(0x3a3f46), true);
      w._box(gb, 1650, 0, 3, (tr.L.uHalf + 80) * 2, y - 6, y, y, [5, 0.5, 0, 0], new THREE.Color(0x7a766e), true);
    }
  }
  // bamboo grove
  const B = tr.props.bamboo;
  if (B.length) {
    const stalk = new THREE.CylinderGeometry(0.06, 0.08, 1, 5, 1, true).translate(0, 0.5, 0);
    const leaves = new THREE.ConeGeometry(1.1, 3.2, 5, 1, true).translate(0, -1.4, 0);
    const sm = [], lm = [];
    for (const b of B) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(b.lean, (b.s * 7.1) % 6.28, b.lean * 0.7));
      sm.push(new THREE.Matrix4().compose(V(b.u, b.y - 0.2, -b.s), q, V(1, b.h, 1)));
      const top = V(0, b.h, 0).applyQuaternion(q).add(V(b.u, b.y, -b.s));
      lm.push(new THREE.Matrix4().compose(top, q, V(1, 1, 1)));
    }
    const sMat = new THREE.MeshStandardMaterial({ color: 0x5f8a3a, roughness: 0.6 });
    const lMat = new THREE.MeshStandardMaterial({ color: 0x3d6a2e, roughness: 0.8, side: THREE.DoubleSide });
    w.disposables.push(sMat, lMat);
    w._instanced(stalk, sMat, sm, { cast: w.quality.shadows });
    w._instanced(leaves, lMat, lm);
  }
}

export function cityMinimapInfo(tr) {
  return { buildings: tr.buildings.map((b) => ({ s0: b.s0 ?? b.s - b.w / 2, s1: b.s1 ?? b.s + b.w / 2, u0: b.u0 ?? b.u - b.d / 2, u1: b.u1 ?? b.u + b.d / 2 })) };
}

void fbm2;
