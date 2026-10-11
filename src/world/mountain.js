import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, fbm2, clamp } from '../core/utils.js';
import { BUILD_U, EDGE_U, BANK_TOP } from './track.js';
import { GeoBuilder, bake } from './geom.js';

// Backcountry mountain environment: faceted terrain with snow and rock,
// distant ranges, a valley village, rocks, wind-crusted snow chunks, trees,
// timber lookout towers and huts, safety fencing, piste poles and a chairlift.

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const D0 = BUILD_U + 1; // where the track mesh ends and the terrain begins

const SNOW = [0.94, 0.96, 1.0];
const ROCK = [0.29, 0.3, 0.33];

// --------------------------------------------------------------------------- geometry helpers
// Low-poly boulder: displaced icosahedron, flat shaded, snow on top-facing facets.
export function rockGeometry(seed, snowy = 0.74) {
  const rng = mulberry32(seed);
  let g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const ph = [rng() * 10, rng() * 10, rng() * 10];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.28 * Math.sin(x * 2.3 + ph[0]) * Math.cos(z * 2.1 + ph[1]) + 0.18 * Math.sin(y * 3.1 + ph[2]);
    p.setXYZ(i, x * k * 1.15, Math.max(-0.35, y * k * 0.8), z * k);
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  const n = g.attributes.normal;
  const col = new Float32Array(n.count * 3);
  for (let f = 0; f < n.count; f += 3) {
    const ny = (n.getY(f) + n.getY(f + 1) + n.getY(f + 2)) / 3;
    const v = 0.85 + rng() * 0.3;
    const c = ny > snowy ? SNOW.map((x) => x * (0.95 + rng() * 0.05)) : ROCK.map((x) => x * v);
    for (let k = 0; k < 3; k++) col.set(c, (f + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// Wind-crusted snow block: flattened faceted lump.
export function chunkGeometry(seed) {
  const rng = mulberry32(seed);
  let g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.75 + rng() * 0.5;
    p.setXYZ(i, p.getX(i) * k * 1.3, Math.max(-0.2, p.getY(i) * k * 0.55), p.getZ(i) * k);
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let f = 0; f < col.length; f += 9) {
    const v = 0.93 + rng() * 0.07;
    for (let k = 0; k < 3; k++) col.set([v, v * 1.01, v * 1.04 > 1 ? 1 : v * 1.04], f + k * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// Taller, more detailed snowy conifer.
export function pineGeometry(seed) {
  const rng = mulberry32(seed);
  const parts = [bake(new THREE.CylinderGeometry(0.1, 0.18, 1.6, 5, 1, true).translate(0, 0.8, 0), new THREE.Matrix4(), 0x3a2a1e)];
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = 2.0 * (1 - t * 0.85), h = 1.9 - t * 0.6, y = 1.3 + t * 5.6;
    const c = new THREE.ConeGeometry(r, h, 7, 1, true);
    c.translate(0, y, 0);
    c.rotateY(rng() * 6.28);
    const g = bake(c, new THREE.Matrix4());
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      const ty = (pos.getY(k) - (y - h / 2)) / h;
      const snow = ty > 0.42 || (ty > 0.2 && Math.sin(k * 7.1) > 0.3);
      col.set(snow ? [0.92, 0.95, 1.0] : [0.08, 0.17 + rng() * 0.04, 0.12], k * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  }
  const g = mergeGeometries(parts);
  return g.toNonIndexed();
}

// --------------------------------------------------------------------------- terrain
export function buildMountainWorld(w) {
  const tr = w.track;
  const st = w.stage;
  const rng = mulberry32(st.seed + 404);
  w.crossings = [];
  w.frontBuildings = [];
  const L = tr.length;

  // Height of the land beside the course. u < 0: mountain wall, u > 0: valley.
  const terrainH = (s, u) => {
    const d = Math.max(0, Math.abs(u) - D0);
    const p = tr.toWorld(s, u, 0, _tmp);
    const n = fbm2(p.x / 75, p.z / 75, 4);
    const n2 = fbm2(p.x / 21 + 9, p.z / 21, 3);
    let r;
    if (u < 0) {
      r = d * 0.3 + d * d * 0.0034 + n * Math.min(d, 45) * 0.38 + n2 * Math.min(d, 10) * 0.14;
      // ridges and gullies across the wall
      r += Math.max(0, fbm2(p.x / 160, p.z / 160, 3)) * Math.min(d, 120) * 0.5;
    } else {
      const lip = 17 + n * 6;
      r = n2 * Math.min(d, 8) * 0.14 + n * Math.min(d, 16) * 0.1;
      if (d > lip) {
        const e = d - lip;
        r -= Math.min(190, e * 0.95 + e * e * 0.0014);
        r += n * Math.min(e, 70) * 0.35;
      }
    }
    return tr.baseY(s) + BANK_TOP + 0.15 + r;
  };
  w.terrainH = terrainH;

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88 });
  w.disposables.push(mat);
  w.mats.rockMat = mat;
  const mountD = [0, 1.5, 3.5, 6, 10, 15, 22, 31, 43, 58, 76, 98, 125, 160, 200, 250];
  const valleyD = [0, 1.5, 3.5, 6, 10, 14, 18, 23, 30, 40, 55, 75, 100, 130, 170, 220, 280, 350, 430, 520, 620];
  const step = 5;
  for (const side of [-1, 1]) {
    const dl = side < 0 ? mountD : valleyD;
    const CH = 200;
    for (let s0 = -80; s0 < L + 80; s0 += CH) {
      const rows = CH / step;
      const P = [];
      for (let r = 0; r <= rows; r++) {
        const s = s0 + r * step;
        const row = [];
        for (const d of dl) {
          const u = side * (D0 + d);
          // jitter interior vertices a little so facets look natural
          const j = d > 2 ? (Math.sin(s * 1.7 + d * 3.1) * 0.5) * Math.min(1, d / 10) : 0;
          const y = terrainH(s + j, u);
          row.push(tr.toWorld(s + j, u, y));
        }
        P.push(row);
      }
      const pos = [], col = [];
      const tri = (a, b, c, d) => {
        _e1.subVectors(b, a); _e2.subVectors(c, a);
        _n.crossVectors(_e1, _e2);
        if (_n.y < 0) { const t = b; b = c; c = t; _n.negate(); }
        _n.normalize();
        const steep = _n.y < 0.74;
        const patch = fbm2(a.x / 30, a.z / 30, 2);
        let cc;
        const band = fbm2(a.x / 11 + 4, a.z / 11, 2);
        if (d < 3) cc = SNOW;
        else if (steep && patch > -0.35) cc = ROCK.map((x) => x * (0.85 + Math.abs(patch) * 0.4));
        else if (d > 8 && _n.y < 0.93 && patch + band * 0.6 > 0.32) cc = ROCK.map((x) => x * (0.95 + band * 0.3));
        else if (_n.y < 0.86 && patch > 0.15) cc = [0.66, 0.68, 0.72];
        else cc = SNOW.map((x) => x * (0.96 + patch * 0.04));
        for (const v of [a, b, c]) { pos.push(v.x, v.y, v.z); col.push(...cc); }
      };
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < dl.length - 1; k++) {
          const a = P[r][k], b = P[r][k + 1], c = P[r + 1][k], d2 = P[r + 1][k + 1];
          tri(a, b, c, dl[k]);
          tri(b, d2, c, dl[k]);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      w.add(new THREE.Mesh(g, mat), { cast: w.quality.shadows, receive: true });
    }
  }

  buildRanges(w, rng);
  buildVillage(w, rng);
  scatter(w, rng);
  buildStructures(w, rng);
  buildLift(w, rng);
  buildBirds(w);
}

// Distant mountain ranges in a ring around the course.
export function buildRanges(w, rng, opts = {}) {
  const tr = w.track;
  const n = tr.n - 1;
  const cx = opts.cx ?? (tr.px[0] + tr.px[n]) / 2, cz = opts.cz ?? (tr.pz[0] + tr.pz[n]) / 2;
  const base = opts.base ?? tr.baseY(tr.length * 0.5) - 260;
  const R0 = opts.inner ?? 1250;
  const A = 160, R = 20;
  const pos = [], col = [];
  const H = (a, r) => {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // broad massifs with a few dominant peaks rather than spiky noise
    const ridged = 1 - Math.abs(fbm2(x / 950, z / 950, 3));
    const massif = 0.5 + 0.5 * fbm2(x / 1700 + 3, z / 1700, 2);
    const peaks = Math.pow(ridged, 1.7) * (0.45 + 0.75 * massif);
    const k = clamp((r - R0) / 900, 0, 1);
    return base + peaks * (420 + 900 * k) * (0.35 + 0.65 * k) + fbm2(x / 260, z / 260, 3) * 55 * k;
  };
  const grid = [];
  for (let i = 0; i <= A; i++) {
    const a = (i / A) * Math.PI * 2;
    const row = [];
    for (let j = 0; j <= R; j++) {
      const r = R0 + Math.pow(j / R, 1.3) * 2300;
      row.push(V(cx + Math.cos(a) * r, H(a, r), cz + Math.sin(a) * r));
    }
    grid.push(row);
  }
  const tri = (a, b, c) => {
    _e1.subVectors(b, a); _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2);
    if (_n.y < 0) { const t = b; b = c; c = t; _n.negate(); }
    _n.normalize();
    const hy = (a.y + b.y + c.y) / 3 - base;
    const rock = _n.y < 0.68 || hy < 60;
    const cc = rock ? [0.36, 0.4, 0.48] : [0.9, 0.94, 1.0];
    for (const v of [a, b, c]) { pos.push(v.x, v.y, v.z); col.push(...cc); }
  };
  for (let i = 0; i < A; i++) {
    for (let j = 0; j < R; j++) {
      tri(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
      tri(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  // aerial perspective: much lighter fog than the course so ranges stay visible
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `
      #ifdef USE_FOG
        float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * 0.12);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fogF, 0.0, 0.88));
      #endif`);
  };
  w.disposables.push(mat);
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  w.add(mesh);
}

// A cluster of timber houses on the valley floor.
function buildVillage(w, rng) {
  const tr = w.track;
  const gb = new GeoBuilder({ color: 3, aFacade: 4 });
  const woods = [0x6b4a32, 0x7a5638, 0x5a3e2a, 0x8a6a4a, 0xb8a58a];
  for (let k = 0; k < 3; k++) {
    const sc = tr.length * (0.2 + k * 0.3) + rng.range(-60, 60);
    for (let i = 0; i < 18; i++) {
      const s = sc + rng.range(-90, 90);
      const u = BUILD_U + rng.range(330, 520);
      const gy = w.terrainH(s, u);
      const bw = rng.range(6, 11), bd = rng.range(6, 10), bh = rng.range(4, 8);
      const col = new THREE.Color(rng.pick(woods));
      const seed = rng();
      w._box(gb, s, u, bw, bd, gy - 3, gy + bh, gy, [6, seed, 0.6, 0], col, false);
      w._gable(gb, s, u, bw, bd, gy + bh, rng.range(2, 3.5), col.clone().multiplyScalar(0.6), seed, { style: 6 });
    }
    // church / tower
    const s = sc, u = BUILD_U + 420, gy = w.terrainH(s, u);
    w._box(gb, s, u, 5, 5, gy - 3, gy + 18, gy, [6, 0.7, 0.5, 0], new THREE.Color(0xd8d0c0), false);
    w._gable(gb, s, u, 5, 5, gy + 18, 5, new THREE.Color(0x5a2a22), 0.7, { style: 6 });
  }
  const mesh = new THREE.Mesh(gb.build(), w.mats.facade);
  w.add(mesh, { receive: true });
}

// Rocks, snow chunks and pine trees.
function scatter(w, rng) {
  const tr = w.track;
  const L = tr.length;
  const rocks = [0, 1, 2, 3].map((i) => rockGeometry(31 + i));
  const rockM = rocks.map(() => []);
  const addRock = (s, u, scale, sink = 0.35) => {
    const y = w.terrainH(s, u) - scale * sink;
    const m = new THREE.Matrix4().compose(
      tr.toWorld(s, u, y),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.15, 0.15), rng() * 6.28, rng.range(-0.15, 0.15))),
      V(scale * rng.range(0.8, 1.4), scale * rng.range(0.6, 1.1), scale * rng.range(0.8, 1.3))
    );
    rockM[rng.int(0, 3)].push(m);
  };
  for (let s = -40; s < L + 60; s += rng.range(6, 16)) {
    // outcrops along the valley lip and up the mountain wall
    if (rng() < 0.7) addRock(s, BUILD_U + rng.range(14, 28), rng.range(2, 6));
    if (rng() < 0.6) addRock(s, -(BUILD_U + rng.range(8, 70)), rng.range(2.5, 9));
    if (rng() < 0.25) addRock(s, -(BUILD_U + rng.range(70, 180)), rng.range(8, 20));
    if (rng() < 0.15) addRock(s, BUILD_U + rng.range(40, 160), rng.range(5, 14), 0.5);
  }
  // rocky cliffs at the course drops
  for (const d of tr.drops) {
    for (let i = 0; i < 6; i++) addRock(d.s + rng.range(-2, d.len + 2), (rng() < 0.5 ? -1 : 1) * rng.range(EDGE_U + 1, BUILD_U + 3), rng.range(1.5, 3.5), 0.5);
  }
  const rmat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 });
  w.disposables.push(rmat);
  rocks.forEach((g, i) => w._instanced(g, rmat, rockM[i], { cast: w.quality.shadows, receive: true }));

  // wind-crusted snow chunks on the shoulders of the course
  const chunks = [0, 1, 2].map((i) => chunkGeometry(77 + i));
  const chunkM = chunks.map(() => []);
  for (let s = 0; s < L; s += rng.range(1.5, 4)) {
    for (const side of [-1, 1]) {
      if (rng() < 0.55) {
        const u = side * rng.range(EDGE_U + 0.6, BUILD_U + 4);
        const y = Math.max(tr.height(s, Math.sign(u) * Math.min(Math.abs(u), BUILD_U - 0.8)), Math.abs(u) > D0 ? w.terrainH(s, u) : -1e9);
        const sc = rng() < 0.18 ? rng.range(1.8, 3.4) : rng.range(0.5, 1.6);
        chunkM[rng.int(0, 2)].push(new THREE.Matrix4().compose(
          tr.toWorld(s, u, y - sc * 0.15),
          new THREE.Quaternion().setFromAxisAngle(UP, rng() * 6.28),
          V(sc, sc * rng.range(0.7, 1.2), sc)
        ));
      }
    }
  }
  const cmat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.75 });
  w.disposables.push(cmat);
  chunks.forEach((g, i) => w._instanced(g, cmat, chunkM[i], { cast: w.quality.shadows, receive: true }));

  // pines
  const pines = [pineGeometry(5), pineGeometry(9)];
  const pineM = [[], []];
  const addPine = (s, u, sc) => {
    const y = Math.abs(u) > D0 ? w.terrainH(s, u) : tr.height(s, u);
    pineM[rng.int(0, 1)].push(new THREE.Matrix4().compose(tr.toWorld(s, u, y - 0.2), new THREE.Quaternion().setFromAxisAngle(UP, rng() * 6.28), V(sc, sc * rng.range(0.85, 1.25), sc)));
  };
  for (let s = -40; s < L + 60; s += rng.range(3, 9)) {
    if (rng() < 0.5) addPine(s, -(BUILD_U + rng.range(1, 45)), rng.range(0.7, 1.4));
    if (rng() < 0.25) addPine(s, BUILD_U + rng.range(1.5, 14), rng.range(0.6, 1.2));
    if (rng() < 0.6) addPine(s, BUILD_U + rng.range(220, 600), rng.range(0.9, 1.6));
  }
  // groves
  for (let k = 0; k < 14; k++) {
    const s0 = rng() * L, u0 = -(BUILD_U + rng.range(10, 60));
    for (let i = 0; i < 9; i++) addPine(s0 + rng.range(-14, 14), u0 + rng.range(-10, 10), rng.range(0.8, 1.5));
  }
  const vm = w.mats.vegetation;
  pines.forEach((g, i) => w._instanced(g, vm, pineM[i], { cast: w.quality.shadows, receive: true }));
}

// Timber lookout towers, huts, fence, piste poles.
function buildStructures(w, rng) {
  const tr = w.track;
  const L = tr.length;
  const gb = new GeoBuilder({ color: 3, aFacade: 4 });
  const plain = [5, 0.4, 0, 0];
  const wood = new THREE.Color(0x6e4c33), dark = new THREE.Color(0x3b2a1e), grey = new THREE.Color(0x8c8577);

  const tower = (s, u) => {
    const gy = w.terrainH(s, u);
    const seed = rng();
    for (const a of [-2.6, 2.6]) for (const b of [-2.6, 2.6]) w._box(gb, s + a, u + b, 0.42, 0.42, gy - 2, gy + 5.2, gy, plain, dark, false);
    // cross bracing
    for (const a of [-2.6, 2.6]) w._box(gb, s + a, u, 0.18, 5.2, gy + 2.4, gy + 2.6, gy, plain, dark, false);
    w._box(gb, s, u, 7.4, 7.4, gy + 5.2, gy + 5.6, gy + 5.2, plain, wood, true);
    w._box(gb, s, u, 5.4, 5.4, gy + 5.6, gy + 8.6, gy + 5.6, [6, seed, 0.35, 0], wood, false);
    w._box(gb, s, u, 6.6, 6.6, gy + 8.6, gy + 8.95, gy + 8.6, plain, dark, true);
    w._box(gb, s + 0.6, u - 0.6, 4.0, 4.0, gy + 8.95, gy + 11.4, gy + 8.95, [6, seed + 0.3, 0.35, 0], wood.clone().multiplyScalar(1.1), false);
    w._gable(gb, s + 0.6, u - 0.6, 4.0, 4.0, gy + 11.4, 1.8, dark, seed, { style: 6 });
    // deck railing
    for (const a of [-3.6, 3.6]) w._box(gb, s + a, u, 0.12, 7.4, gy + 5.6, gy + 6.6, gy, plain, dark, true);
    for (const b of [-3.6, 3.6]) w._box(gb, s, u + b, 7.4, 0.12, gy + 5.6, gy + 6.6, gy, plain, dark, true);
    // ladder
    for (const b of [-0.3, 0.3]) w._box(gb, s - 3.9, u + 1.5 + b, 0.08, 0.08, gy, gy + 5.6, gy, plain, dark, false);
    for (let y = 0.4; y < 5.6; y += 0.4) w._box(gb, s - 3.9, u + 1.5, 0.06, 0.7, gy + y, gy + y + 0.05, gy, plain, dark, false);
    // mast with a pennant
    w._box(gb, s + 0.6, u - 0.6, 0.1, 0.1, gy + 12.5, gy + 16, gy, plain, grey, false);
    w._box(gb, s + 0.6, u - 0.6 + 0.6, 0.02, 1.1, gy + 15.2, gy + 15.8, gy, plain, new THREE.Color(0xd8452a), false);
  };
  const hut = (s, u, big = false) => {
    const gy = w.terrainH(s, u);
    const seed = rng();
    const bw = big ? 9 : rng.range(5, 7), bd = big ? 7 : rng.range(4.5, 6), bh = big ? 4.5 : rng.range(2.8, 3.6);
    const col = new THREE.Color(rng.pick([0x6e4c33, 0x7a5638, 0x5d4130]));
    w._box(gb, s, u, bw, bd, gy - 2, gy + bh, gy, [6, seed, 0.3, 0], col, false);
    w._gable(gb, s, u, bw, bd, gy + bh, bd * 0.42, dark, seed, { style: 6 });
    w._box(gb, s + bw * 0.25, u + bd * 0.2, 0.6, 0.6, gy + bh, gy + bh + bd * 0.5, gy, plain, grey, true); // chimney
    // stacked firewood
    w._box(gb, s - bw / 2 - 0.5, u, 0.8, bd * 0.7, gy, gy + 1.1, gy, plain, new THREE.Color(0x8a6544), true);
  };
  // lookout towers on the ridge, huts along the course
  // two on the valley ridge (silhouetted against the sky), one up the mountain side
  for (const t of [0.09, 0.42, 0.74]) tower(L * t, BUILD_U + 1 + rng.range(6, 9));
  tower(L * 0.58, -(BUILD_U + 24));
  for (let i = 0; i < 9; i++) {
    const side = rng() < 0.65 ? -1 : 1;
    hut(rng.range(40, L - 40), side * (BUILD_U + (side < 0 ? rng.range(8, 30) : rng.range(4, 10))), i === 0);
  }
  // timber safety fence with orange netting along the valley edge
  const postM = [], railM = [], netGeo = [];
  for (let s = -20; s < L + 20; s += 3.2) {
    const u = BUILD_U + 0.4;
    const y = w.terrainH(s, u);
    postM.push(new THREE.Matrix4().compose(tr.toWorld(s, u, y), new THREE.Quaternion().setFromAxisAngle(UP, tr.yawAt(s)), V(1, 1, 1)));
    const y2 = w.terrainH(s + 3.2, u);
    const a = tr.toWorld(s, u, y + 0.15), b = tr.toWorld(s + 3.2, u, y2 + 0.15);
    const pg = new THREE.PlaneGeometry(1, 1);
    // stretch a quad between the two posts
    const p = pg.attributes.position;
    const corners = [[a, 1.15], [b, 1.15], [a, 0], [b, 0]];
    corners.forEach(([c, h], i) => p.setXYZ(i, c.x, c.y + h, c.z));
    pg.computeVertexNormals();
    netGeo.push(pg);
    railM.push(new THREE.Matrix4().compose(tr.toWorld(s + 1.6, u, (y + y2) / 2 + 1.2), new THREE.Quaternion().setFromAxisAngle(UP, tr.yawAt(s)), V(1, 1, 1)));
  }
  w._instanced(new THREE.BoxGeometry(0.1, 1.35, 0.1).translate(0, 0.67, 0), w.mats.wood, postM, { cast: w.quality.shadows });
  w._instanced(new THREE.BoxGeometry(0.06, 0.06, 3.2), w.mats.wood, railM);
  const net = new THREE.MeshStandardMaterial({ color: 0xff6a1a, alphaMap: netTexture(), transparent: true, side: THREE.DoubleSide, roughness: 0.8, depthWrite: false });
  w.disposables.push(net);
  w.add(new THREE.Mesh(mergeGeometries(netGeo), net));
  netGeo.forEach((g) => g.dispose());

  // orange piste marker poles
  const poleM = [];
  for (let s = 10; s < L; s += 24) {
    for (const side of [-1, 1]) {
      const u = side * (EDGE_U + 1.3);
      poleM.push(new THREE.Matrix4().compose(tr.toWorld(s + side * 6, u, tr.height(s + side * 6, u)), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.05, 0, side * 0.04)), V(1, 1, 1)));
    }
  }
  const poleGeo = mergeGeometries([0, 1, 2, 3, 4].map((i) => bake(new THREE.CylinderGeometry(0.035, 0.035, 0.38, 8).translate(0, 0.19 + i * 0.38, 0), new THREE.Matrix4(), i % 2 ? 0x1a1a1a : 0xff5a14)));
  const pm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 });
  w.disposables.push(pm);
  w._instanced(poleGeo, pm, poleM);

  w.add(new THREE.Mesh(gb.build(), w.mats.facade), { cast: w.quality.shadows, receive: true });
}

export function netTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  for (let i = -64; i < 128; i += 16) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 64, 64); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i, 64); ctx.lineTo(i + 64, 0); ctx.stroke();
  }
  ctx.fillRect(0, 0, 64, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1.4);
  return t;
}

// Chairlift running up the mountain side with moving chairs.
function buildLift(w, rng) {
  const tr = w.track;
  const L = tr.length;
  const uL = -(BUILD_U + 36);
  const tops = [[], []];
  const pylonM = [], armM = [];
  for (let s = 20; s < L - 10; s += 65) {
    const gy = w.terrainH(s, uL);
    const hgt = 11;
    const q = new THREE.Quaternion().setFromAxisAngle(UP, tr.yawAt(s));
    pylonM.push(new THREE.Matrix4().compose(tr.toWorld(s, uL, gy - 1), q, V(1, hgt + 1, 1)));
    armM.push(new THREE.Matrix4().compose(tr.toWorld(s, uL, gy + hgt), q, V(1, 1, 1)));
    tops[0].push(tr.toWorld(s, uL - 2.1, gy + hgt));
    tops[1].push(tr.toWorld(s, uL + 2.1, gy + hgt));
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.4 });
  w.disposables.push(steel);
  w._instanced(new THREE.CylinderGeometry(0.28, 0.4, 1, 10).translate(0, 0.5, 0), steel, pylonM, { cast: w.quality.shadows });
  w._instanced(new THREE.BoxGeometry(5, 0.3, 0.4), steel, armM, { cast: w.quality.shadows });
  // cables
  const lp = [];
  for (const line of tops) for (let i = 0; i < line.length - 1; i++) lp.push(line[i].x, line[i].y, line[i].z, line[i + 1].x, line[i + 1].y, line[i + 1].z);
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const lm = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
  w.disposables.push(lm);
  w.add(new THREE.LineSegments(lg, lm));
  // chairs
  const chair = mergeGeometries([
    bake(new THREE.BoxGeometry(0.05, 2.1, 0.05).translate(0, -1.05, 0), new THREE.Matrix4(), 0x333333),
    bake(new THREE.BoxGeometry(1.4, 0.1, 0.55).translate(0, -2.1, 0.05), new THREE.Matrix4(), 0x2e5d8a),
    bake(new THREE.BoxGeometry(1.4, 0.55, 0.08).translate(0, -1.82, -0.22), new THREE.Matrix4(), 0x2e5d8a),
    bake(new THREE.BoxGeometry(1.45, 0.06, 0.06).translate(0, -1.5, 0.3), new THREE.Matrix4(), 0x333333),
  ]);
  const lines = tops.map((pts, k) => {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    return { pts: k ? pts : pts.slice().reverse(), cum: k ? cum : cum.slice().reverse().map((c) => cum[cum.length - 1] - c), len: cum[cum.length - 1] };
  });
  const spacing = 16;
  const count = Math.floor(lines[0].len / spacing) * 2;
  const cm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 });
  w.disposables.push(cm);
  const im = new THREE.InstancedMesh(chair, cm, count);
  im.frustumCulled = false;
  im.castShadow = w.quality.shadows;
  w.group.add(im);
  w.lift = { lines, im, spacing, count, m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: V(), d: V() };
}

export function updateLift(w, t, lift = w.lift) {
  const L = lift;
  if (!L) return;
  const per = L.count / 2;
  for (let k = 0; k < 2; k++) {
    const line = L.lines[k];
    for (let i = 0; i < per; i++) {
      let x = (t * 2.2 + i * L.spacing) % line.len;
      // find segment
      let j = 1;
      while (j < line.cum.length - 1 && line.cum[j] < x) j++;
      const a = line.pts[j - 1], b = line.pts[j];
      const seg = line.cum[j] - line.cum[j - 1] || 1;
      const f = clamp((x - line.cum[j - 1]) / seg, 0, 1);
      L.p.lerpVectors(a, b, f);
      L.d.subVectors(b, a);
      L.q.setFromAxisAngle(UP, Math.atan2(L.d.x, L.d.z));
      L.m.compose(L.p, L.q, _one);
      L.im.setMatrixAt(k * per + i, L.m);
    }
  }
  L.im.instanceMatrix.needsUpdate = true;
}

// A small flock circling over the slope ahead of the rider.
export function buildBirds(w) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0.25, -0.7, 0.25, -0.1, 0, 0, -0.15,
    0, 0, 0.25, 0, 0, -0.15, 0.7, 0.25, -0.1,
  ], 3));
  g.computeVertexNormals();
  const m = new THREE.MeshBasicMaterial({ color: 0x1b1d22, side: THREE.DoubleSide });
  w.disposables.push(m);
  const n = 11;
  const im = new THREE.InstancedMesh(g, m, n);
  im.frustumCulled = false;
  w.group.add(im);
  w.birds = { im, n, c: V(), m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: V(), p: V() };
}

export function updateBirds(w, t, focus) {
  const B = w.birds;
  if (!B) return;
  B.c.lerp(_tmp.set(focus.x, focus.y + 55, focus.z), B.c.lengthSq() ? 0.005 : 1);
  for (let i = 0; i < B.n; i++) {
    const a = t * 0.25 + i * 0.57;
    const r = 26 + (i % 4) * 6;
    B.p.set(B.c.x + Math.cos(a) * r, B.c.y + Math.sin(t * 0.7 + i) * 3 + (i % 3) * 2, B.c.z + Math.sin(a) * r);
    B.q.setFromAxisAngle(UP, -a);
    const flap = 0.4 + 0.9 * Math.sin(t * 9 + i * 1.3);
    B.s.set(1.6, 1.6 * flap, 1.6);
    B.m.compose(B.p, B.q, B.s);
    B.im.setMatrixAt(i, B.m);
  }
  B.im.instanceMatrix.needsUpdate = true;
}

const _tmp = V();
const _e1 = V(), _e2 = V(), _n = V();
const _one = V(1, 1, 1);
