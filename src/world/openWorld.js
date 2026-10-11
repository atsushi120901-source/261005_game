import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, fbm2, clamp, smoothstep } from '../core/utils.js';
import { GeoBuilder, bake } from './geom.js';
import { rockGeometry, pineGeometry, buildRanges, buildBirds, updateBirds, updateLift } from './mountain.js';
import { DIFF } from './openTerrain.js';
import { bannerTexture } from '../gfx/textures.js';

// Visuals of the open mountain: LOD terrain chunks that match the physics
// grid exactly up close, feature meshes (kickers, cliffs, pillows ...), forest
// blocks with near / far tree models, chalets with snowy hip roofs, lifts,
// route arches, signposts, piste markers, start and finish gates.

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const CHUNK = 64; // grid cells per terrain chunk (128 m)
let LOD_DIST = [190, 420, 900, 1700];
const TREE_BLOCK = 64;
let TREE_NEAR = 150;

const SNOW = [0.95, 0.97, 1.0];
const ROCK = [0.3, 0.31, 0.34];

export function buildOpenWorld(w) {
  const tr = w.track;
  const rng = mulberry32(w.stage.seed + 909);
  w.crossings = [];
  w.frontBuildings = [];
  w.open = { chunks: [], featGroups: [], timer: 0, builds: 0 };
  // lighter settings on lower quality presets
  const q = w.quality.name;
  const k = q === 'LOW' ? 0.6 : q === 'MEDIUM' ? 0.8 : 1;
  LOD_DIST = [190, 420, 900, 1700].map((d) => d * k);
  TREE_NEAR = q === 'LOW' ? 80 : q === 'MEDIUM' ? 115 : 150;
  // terrain rock material (flat shaded facets)
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  w.disposables.push(rockMat);
  w.mats.rockMat = rockMat;
  // feature meshes sit exactly on the terrain: pull them forward in depth
  const featMat = w.mats.snow.clone();
  featMat.onBeforeCompile = w.mats.snow.onBeforeCompile;
  featMat.userData = w.mats.snow.userData;
  featMat.polygonOffset = true;
  featMat.polygonOffsetFactor = -1;
  featMat.polygonOffsetUnits = -4;
  w.disposables.push(featMat);
  w.mats.featSnow = featMat;

  buildTerrainChunks(w);
  buildApron(w);
  buildRanges(w, rng, { cx: 0, cz: -1150, base: tr.baseY(1150) - 300, inner: 1750 });
  buildFeatureMeshes(w);
  buildForest(w);
  buildRocks(w, rng);
  buildBuildings(w);
  buildLookouts(w);
  buildLifts(w);
  buildSignage(w);
  buildMarkers(w);
  buildGates(w);
  buildBirds(w);
}

// ------------------------------------------------------------------ terrain
function buildTerrainChunks(w) {
  const tr = w.track;
  const { NS, NU, CELL, S_MIN, U_HALF, G } = tr.gridInfo();
  const nci = Math.ceil((NS - 1) / CHUNK), ncj = Math.ceil((NU - 1) / CHUNK);
  for (let ci = 0; ci < nci; ci++) {
    for (let cj = 0; cj < ncj; cj++) {
      const i0 = ci * CHUNK, i1 = Math.min(i0 + CHUNK, NS - 1);
      const j0 = cj * CHUNK, j1 = Math.min(j0 + CHUNK, NU - 1);
      const c = {
        i0, i1, j0, j1,
        cs: S_MIN + ((i0 + i1) / 2) * CELL, cu: -U_HALF + ((j0 + j1) / 2) * CELL,
        levels: [null, null, null, null, null], level: -1,
      };
      c.cy = G[Math.round((i0 + i1) / 2) * NU + Math.round((j0 + j1) / 2)];
      for (let L = 1; L < 5; L++) c.levels[L] = chunkMesh(w, c, 1 << L);
      w.open.chunks.push(c);
    }
  }
}

// One terrain chunk at a given grid step: smooth snow mesh + flat rock facets + skirts.
function chunkMesh(w, c, step) {
  const tr = w.track;
  const { NU, CELL, S_MIN, U_HALF, G } = tr.gridInfo();
  const rows = [], cols = [];
  for (let i = c.i0; i < c.i1; i += step) rows.push(i);
  rows.push(c.i1);
  for (let j = c.j0; j < c.j1; j += step) cols.push(j);
  cols.push(c.j1);
  const nr = rows.length, nc = cols.length;
  const NSr = tr.gridInfo().NS;
  const H = (i, j) => G[clamp(i, 0, NSr - 1) * NU + clamp(j, 0, NU - 1)];
  const pos = new Float32Array(nr * nc * 3 + (nr + nc) * 2 * 3 * 2);
  const nor = new Float32Array(pos.length);
  const col = new Float32Array(pos.length);
  const uv = new Float32Array((pos.length / 3) * 2);
  let v = 0;
  const put = (i, j, dy, n) => {
    const s = S_MIN + i * CELL, u = -U_HALF + j * CELL;
    const h = H(i, j);
    pos[v * 3] = u; pos[v * 3 + 1] = h + dy; pos[v * 3 + 2] = -s;
    // smooth normal from central differences at this LOD's spacing
    const d = Math.max(1, step);
    const gs = (H(i + d, j) - H(i - d, j)) / (2 * d * CELL);
    const gu = (H(i, j + d) - H(i, j - d)) / (2 * d * CELL);
    let nx = -gu, ny = 1, nz = gs;
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
    // snow tint: blue in hollows, greyer on steep ground
    const lap = (H(i + d, j) + H(i - d, j) + H(i, j + d) + H(i, j - d)) / 4 - h;
    const ao = 1 - clamp(lap * 0.06, -0.04, 0.12);
    const steep = smoothstep(0.7, 0.47, ny);
    const patch = fbm2(u / 26 + 3, s / 26, 2);
    const k = ao * (1 - steep * (0.25 + 0.3 * smoothstep(0.0, 0.5, patch)));
    col[v * 3] = SNOW[0] * k * (1 - 0.03 * steep); col[v * 3 + 1] = SNOW[1] * k; col[v * 3 + 2] = SNOW[2] * k;
    uv[v * 2] = u / 3; uv[v * 2 + 1] = s / 3;
    return v++;
  };
  const idx = [];
  const grid = [];
  for (let a = 0; a < nr; a++) for (let b = 0; b < nc; b++) grid.push(put(rows[a], cols[b], 0));
  // pistes stay snow-covered however steep they get
  const piste = new Uint8Array(v);
  for (let a = 0; a < nr; a++) {
    for (let b = 0; b < nc; b++) {
      const k = grid[a * nc + b];
      piste[k] = tr.routeAt(S_MIN + rows[a] * CELL, -U_HALF + cols[b] * CELL, 0) ? 1 : 0;
    }
  }
  const rock = [], rcol = [];
  const P = (k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
  const triangle = (a, b, d) => {
    const A = P(a), B = P(b), D = P(d);
    const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2];
    const e2x = D[0] - A[0], e2y = D[1] - A[1], e2z = D[2] - A[2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    let tri = [a, b, d];
    if (ny < 0) { tri = [a, d, b]; nx = -nx; ny = -ny; nz = -nz; }
    // rock where the smoothed surface is steep (avoids a checkerboard of facets)
    const sny = (nor[a * 3 + 1] + nor[b * 3 + 1] + nor[d * 3 + 1]) / 3;
    if (sny < 0.5 && !(piste[a] || piste[b] || piste[d])) {
      const shade = 0.85 + 0.3 * fbm2(A[0] / 9, A[2] / 9, 2);
      for (const k of tri) { rock.push(...P(k)); rcol.push(ROCK[0] * shade, ROCK[1] * shade, ROCK[2] * shade); }
    } else idx.push(...tri);
  };
  for (let a = 0; a < nr - 1; a++) {
    for (let b = 0; b < nc - 1; b++) {
      const p00 = grid[a * nc + b], p10 = grid[(a + 1) * nc + b], p01 = grid[a * nc + b + 1], p11 = grid[(a + 1) * nc + b + 1];
      // same diagonal as the physics surface (00 - 11)
      triangle(p00, p10, p11);
      triangle(p00, p01, p11);
    }
  }
  // skirts hide cracks between neighbouring LODs
  const drop = -(1.5 + step * CELL * 0.6);
  const skirt = (list) => {
    for (let q = 0; q < list.length - 1; q++) {
      const [ia, ja] = list[q], [ib, jb] = list[q + 1];
      const ta = grid[ia * nc + ja], tb = grid[ib * nc + jb];
      const ba = put(rows[ia], cols[ja], drop), bb = put(rows[ib], cols[jb], drop);
      idx.push(ta, ba, tb, tb, ba, bb, ta, tb, ba, tb, bb, ba); // both windings
    }
  };
  skirt(Array.from({ length: nc }, (_, b) => [0, b]));
  skirt(Array.from({ length: nc }, (_, b) => [nr - 1, b]));
  skirt(Array.from({ length: nr }, (_, a) => [a, 0]));
  skirt(Array.from({ length: nr }, (_, a) => [a, nc - 1]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, v * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor.slice(0, v * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(col.slice(0, v * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv.slice(0, v * 2), 2));
  g.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  const grp = new THREE.Group();
  const m = new THREE.Mesh(g, w.mats.snow);
  m.receiveShadow = true;
  grp.add(m);
  if (rock.length) {
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(rock, 3));
    rg.setAttribute('color', new THREE.Float32BufferAttribute(rcol, 3));
    rg.computeVertexNormals();
    rg.computeBoundingSphere();
    const rm = new THREE.Mesh(rg, w.mats.rockMat);
    rm.receiveShadow = true;
    grp.add(rm);
  }
  grp.visible = false;
  w.group.add(grp);
  return grp;
}

// Coarse low-poly land around the ski area (walls, valley, peaks behind the summit).
function buildApron(w) {
  const tr = w.track;
  const { S_MIN, U_HALF } = tr.gridInfo();
  const S_END = S_MIN + (tr.gridInfo().NS - 1) * tr.gridInfo().CELL;
  const step = 24;
  const s0 = -1400, s1 = 3700, u0 = -1700, u1 = 1700;
  const rp = tr.routes.map(() => null);
  const inside = (s, u) => Math.abs(u) < U_HALF - 2 && s > S_MIN + 2 && s < S_END - 2;
  const H = (s, u) => {
    let y = tr._terrain(s, u, rp);
    const au = Math.abs(u);
    if (au > 540) {
      // massive ridges flanking the valley
      const e = au - 540;
      y += 110 * (1 - Math.exp(-e / 300)) + Math.max(0, fbm2(u / 380, s / 380 + 4, 3)) * 200 * smoothstep(0, 500, e);
    }
    if (s < -200) y += Math.max(0, fbm2(u / 300 + 9, s / 300, 3)) * 200 * smoothstep(-200, -600, s);
    if (inside(s, u)) y -= 4;
    return y;
  };
  const ni = Math.round((s1 - s0) / step), nj = Math.round((u1 - u0) / step);
  const P = [];
  for (let i = 0; i <= ni; i++) {
    const row = [];
    for (let j = 0; j <= nj; j++) {
      const s = s0 + i * step, u = u0 + j * step;
      const jit = inside(s, u) || Math.abs(u) < U_HALF + 30 ? 0 : 1;
      const ss = s + jit * Math.sin(u * 0.13 + s * 0.07) * step * 0.3, uu = u + jit * Math.cos(s * 0.11 + u * 0.05) * step * 0.3;
      row.push([ss, uu, H(ss, uu)]);
    }
    P.push(row);
  }
  const pos = [], col = [];
  const e1 = V(), e2 = V(), n = V();
  const tri = (a, b, c) => {
    if (inside(a[0], a[1]) && inside(b[0], b[1]) && inside(c[0], c[1])) return;
    const A = V(a[1], a[2], -a[0]), B = V(b[1], b[2], -b[0]), C = V(c[1], c[2], -c[0]);
    e1.subVectors(B, A); e2.subVectors(C, A);
    n.crossVectors(e1, e2);
    let pts = [A, B, C];
    if (n.y < 0) { pts = [A, C, B]; n.negate(); }
    n.normalize();
    const patch = fbm2(A.x / 60, A.z / 60, 2);
    const cc = n.y < 0.72 && patch > -0.4 ? ROCK.map((x) => x * (0.85 + Math.abs(patch) * 0.4)) : n.y < 0.86 && patch > 0.2 ? [0.68, 0.7, 0.75] : SNOW.map((x) => x * (0.96 + patch * 0.04));
    for (const p of pts) { pos.push(p.x, p.y, p.z); col.push(...cc); }
  };
  for (let i = 0; i < ni; i++) {
    for (let j = 0; j < nj; j++) {
      tri(P[i][j], P[i + 1][j], P[i + 1][j + 1]);
      tri(P[i][j], P[i][j + 1], P[i + 1][j + 1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, w.mats.rockMat);
  m.receiveShadow = true;
  w.add(m, { receive: true });
}

// ------------------------------------------------------------------ features
// Each feature gets a mesh of its own surface (terrain + that feature), sampled
// finely only where the shape needs it (lips, cliff edges) and coarsely elsewhere.
function samples(a, b, step, fine = []) {
  const out = [];
  for (let x = a; x < b; x += step) out.push(x);
  out.push(b);
  for (const [c, half, st] of fine) for (let x = c - half; x <= c + half; x += st) if (x > a && x < b) out.push(x);
  out.sort((p, q) => p - q);
  return out.filter((x, i) => i === 0 || x - out[i - 1] > 0.004);
}

function featureSampling(f) {
  const s0 = f.bs0, s1 = f.bs1, u0 = f.bu0, u1 = f.bu1;
  // dense across the shoulders where the feature falls away to the snow
  const sides = (w, fall, st = 0.4) => [[f.u0 - w / 2 - fall / 2, fall / 2 + 0.2, st], [f.u0 + w / 2 + fall / 2, fall / 2 + 0.2, st]];
  switch (f.type) {
    case 'cliff': return [samples(s0, s1, 1.6, [[f.se - 0.6, 0.8, 0.2]]), samples(u0, u1, 1.2, sides(f.w, 5, 0.6))];
    case 'roller': return [samples(s0, s1, 1.1), samples(u0, u1, 1.5, sides(f.w, 6, 0.8))];
    case 'spine': return [samples(s0, s1, 1.2), samples(u0, u1, 0.45)];
    case 'landing': return [samples(s0, s1, 0.8), samples(u0, u1, 1.0, sides(f.w, 4, 0.5))];
    case 'pillow': return [samples(s0, s1, 0.5), samples(u0, u1, 0.5)];
    case 'drift': return [samples(s0, s1, 0.5, [[f.s1, 0.05, 0.02]]), samples(u0, u1, 0.8, sides(f.w, 2.5))];
    case 'table': return [samples(s0, s1, 0.7), samples(u0, u1, 1.0, sides(f.w, 2.5))];
    default: // kickers: crisp lip
      return [samples(s0, s1, 0.7, [[f.s1 - 0.3, 0.3, 0.15], [f.s1, 0.03, 0.02]]), samples(u0, u1, 1.0, sides(f.w, 2))];
  }
}

function buildFeatureMeshes(w) {
  const tr = w.track;
  const geos = [];
  for (const f of tr.features) {
    if (f.render === false || f.bs0 === undefined || f.type === 'car' || f.type === 'railFoot') continue;
    const [SS, UU] = featureSampling(f);
    const ns = SS.length - 1, nu = UU.length - 1;
    const W = nu + 1;
    const Hh = new Float32Array((ns + 1) * W);
    const FH = new Float32Array((ns + 1) * W);
    for (let i = 0; i <= ns; i++) {
      for (let j = 0; j <= nu; j++) {
        const s = SS[i], u = UU[j];
        const g = tr.ground(s, u);
        const fh = f.abs ? Math.max(0, f.fn(s, u) - g) : f.fn(s, u);
        Hh[i * W + j] = g + fh;
        FH[i * W + j] = fh;
      }
    }
    const pos = [], nor = [], col = [], uv = [], idx = [];
    const map = new Int32Array((ns + 1) * W).fill(-1);
    const hAt = (s, u) => { const g = tr.ground(s, u); return g + (f.abs ? Math.max(0, f.fn(s, u) - g) : f.fn(s, u)); };
    const vert = (i, j) => {
      const k = i * W + j;
      if (map[k] >= 0) return map[k];
      const s = SS[i], u = UU[j];
      const h = Hh[k];
      // normals from the neighbouring samples (one-sided at the borders)
      const ia = Math.max(0, i - 1), ib = Math.min(ns, i + 1), ja = Math.max(0, j - 1), jb = Math.min(nu, j + 1);
      let gs = (Hh[ib * W + j] - Hh[ia * W + j]) / (SS[ib] - SS[ia]);
      let gu = (Hh[i * W + jb] - Hh[i * W + ja]) / (UU[jb] - UU[ja]);
      // vertical faces (cliff / lip edges): keep the normal facing out of the face
      if (!Number.isFinite(gs)) gs = 0;
      if (!Number.isFinite(gu)) gu = 0;
      let nx = -gu, ny = 1, nz = gs;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      pos.push(u, h, -s);
      nor.push(nx, ny, nz);
      const steep = f.type === 'cliff' ? smoothstep(0.8, 0.5, ny) : smoothstep(0.55, 0.3, ny) * 0.35;
      const c = steep > 0 ? SNOW.map((x, q) => x + (ROCK[q] * (0.9 + 0.2 * Math.sin(u * 3.1 + h * 2.3)) - x) * steep) : SNOW;
      col.push(c[0], c[1], c[2]);
      uv.push(u / 3, s / 3);
      map[k] = pos.length / 3 - 1;
      return map[k];
    };
    void hAt;
    for (let i = 0; i < ns; i++) {
      for (let j = 0; j < nu; j++) {
        const any = FH[i * W + j] > 0.003 || FH[(i + 1) * W + j] > 0.003 || FH[i * W + j + 1] > 0.003 || FH[(i + 1) * W + j + 1] > 0.003;
        if (!any) continue;
        const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
        // winding: world x = u, z = -s; (a, c, b) faces up
        idx.push(a, c, b, c, d, b);
      }
    }
    if (!idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    geos.push(g);
  }
  // merge into a few spatial groups so culling still works
  const groups = new Map();
  geos.forEach((g) => {
    g.computeBoundingSphere();
    const c = g.boundingSphere.center;
    const k = Math.floor(-c.z / 250) * 100 + Math.floor(c.x / 250);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(g);
  });
  let tris = 0;
  for (const list of groups.values()) {
    const merged = mergeGeometries(list);
    merged.computeBoundingSphere();
    tris += merged.index.count / 3;
    const m = new THREE.Mesh(merged, w.mats.featSnow);
    m.receiveShadow = true;
    m.castShadow = w.quality.shadows;
    w.group.add(m);
    w.open.featGroups.push(m);
    list.forEach((g) => g.dispose());
  }
  w.open.featureTris = tris;
}

// ------------------------------------------------------------------ forest
function farTreeGeometry() {
  const c = new THREE.ConeGeometry(2.0, 7.6, 5, 1, true).translate(0, 4.2, 0);
  const g = c.toNonIndexed();
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    col.set(y > 5.2 ? [0.9, 0.93, 0.98] : [0.12, 0.22, 0.17], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// All trees are drawn with three instanced meshes: a cheap far model for every
// tree, and two detailed pine models for the trees near the camera (their far
// copies are collapsed while they are near).
function buildForest(w) {
  const tr = w.track;
  const near = [pineGeometry(5), pineGeometry(9)];
  const far = farTreeGeometry();
  w.disposables.push(...near, far);
  const vm = w.mats.vegetation;
  const trees = tr.trees;
  const n = trees.length;
  const mats = new Float32Array(n * 16);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = V();
  const blocks = new Map();
  trees.forEach((t, i) => {
    q.setFromAxisAngle(UP, t.rot);
    sc.set(t.sc, t.sc * (0.9 + (t.rot % 0.3)), t.sc);
    m.compose(V(t.u, t.y - 0.2, -t.s), q, sc);
    m.toArray(mats, i * 16);
    const k = Math.floor(t.s / TREE_BLOCK) * 1000 + Math.floor(t.u / TREE_BLOCK);
    let b = blocks.get(k);
    if (!b) blocks.set(k, (b = { cs: (Math.floor(t.s / TREE_BLOCK) + 0.5) * TREE_BLOCK, cu: (Math.floor(t.u / TREE_BLOCK) + 0.5) * TREE_BLOCK, idx: [] }));
    b.idx.push(i);
  });
  const farMesh = new THREE.InstancedMesh(far, vm, n);
  farMesh.instanceMatrix.array.set(mats);
  farMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  farMesh.frustumCulled = false;
  farMesh.receiveShadow = true;
  w.group.add(farMesh);
  const cap = Math.min(n, 4200);
  const nearMeshes = near.map((g) => {
    const im = new THREE.InstancedMesh(g, vm, cap);
    im.count = 0;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = w.quality.shadows;
    im.receiveShadow = true;
    w.group.add(im);
    return im;
  });
  w.open.forest = { mats, farMesh, nearMeshes, blocks: [...blocks.values()], isNear: new Uint8Array(n), cap, trees };
}

function updateForest(w, cx, cz) {
  const F = w.open.forest;
  if (!F) return;
  const R2 = TREE_NEAR * TREE_NEAR;
  const B2 = (TREE_NEAR + TREE_BLOCK) * (TREE_NEAR + TREE_BLOCK);
  const counts = [0, 0];
  const farArr = F.farMesh.instanceMatrix.array;
  let farDirty = false;
  const want = F.want || (F.want = new Uint8Array(F.isNear.length));
  want.fill(0);
  for (const b of F.blocks) {
    const bx = b.cu - cx, bz = -b.cs - cz;
    if (bx * bx + bz * bz > B2) continue;
    for (const i of b.idx) {
      const t = F.trees[i];
      const dx = t.u - cx, dz = -t.s - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      want[i] = 1;
      // trees right at the camera are hidden instead of filling the screen
      if (d2 < 36) continue;
      const k = t.kind;
      if (counts[0] + counts[1] >= F.cap) break;
      F.nearMeshes[k].instanceMatrix.array.set(F.mats.subarray(i * 16, i * 16 + 16), counts[k] * 16);
      counts[k]++;
    }
  }
  // swap far copies in and out
  for (let i = 0; i < want.length; i++) {
    if (want[i] === F.isNear[i]) continue;
    F.isNear[i] = want[i];
    if (want[i]) farArr.fill(0, i * 16, i * 16 + 16);
    else farArr.set(F.mats.subarray(i * 16, i * 16 + 16), i * 16);
    farDirty = true;
  }
  if (farDirty) F.farMesh.instanceMatrix.needsUpdate = true;
  F.nearMeshes.forEach((im, k) => { im.count = counts[k]; im.instanceMatrix.needsUpdate = true; });
}

function buildRocks(w, rng) {
  const tr = w.track;
  const rocks = [0, 1, 2, 3].map((i) => rockGeometry(131 + i));
  const ms = rocks.map(() => []);
  for (const r of tr.rocks) {
    ms[r.kind].push(new THREE.Matrix4().compose(
      V(r.u, r.y - r.sc * 0.3, -r.s),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.15, 0.15), r.rot, rng.range(-0.15, 0.15))),
      V(r.sc * rng.range(0.8, 1.3), r.sc * rng.range(0.6, 1.0), r.sc * rng.range(0.8, 1.2))
    ));
  }
  // outcrops studding the cliff faces and the shoulders of each rock band
  for (const c of tr.cliffs) {
    for (let u = c.u0 - c.w / 2 - 3; u <= c.u0 + c.w / 2 + 3; u += rng.range(1.6, 3.2)) {
      const side = Math.abs(u - c.u0) > c.w / 2 - 1;
      const top = tr.height(c.se - 0.3, u), low = tr.ground(c.se + 1, u);
      if (top - low < 0.8) continue;
      const sc = rng.range(0.7, 1.3) * Math.min(2.2, (top - low) * 0.32);
      const y = low + (top - low) * rng.range(0.25, 0.6);
      ms[rng.int(0, 3)].push(new THREE.Matrix4().compose(
        V(u, y, -(c.se + (side ? 0.6 : 0.15))),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.3, 0.3), rng() * 6.28, rng.range(-0.3, 0.3))),
        V(sc * 1.1, sc * rng.range(0.8, 1.2), sc * 0.55)
      ));
    }
  }
  const rmat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92 });
  w.disposables.push(rmat, ...rocks);
  rocks.forEach((g, i) => w._instanced(g, rmat, ms[i], { cast: w.quality.shadows, receive: true }));
}

// ------------------------------------------------------------------ buildings
function hipRoof(gb, b) {
  const { s, u, hw, hd, ye, rise } = b;
  const P = (ds, du, y) => V(u + du, y, -(s + ds));
  const y0 = ye + 0.12;
  const ridge = Math.max(0, hw - hd);
  const yr = y0 + rise * Math.min(1, hw / hd);
  const snowA = { color: [1, 1, 1], aFacade: [6, b.seed, 0, 1] };
  const woodA = { color: [0.12, 0.08, 0.06], aFacade: [1, b.seed, 0, 0] };
  // long sides (trapezoids) and hipped ends (triangles)
  gb.quad(P(-hw, -hd, y0), P(hw, -hd, y0), P(ridge, 0, yr), P(-ridge, 0, yr), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(-1, 1, 0));
  gb.quad(P(-hw, hd, y0), P(-ridge, 0, yr), P(ridge, 0, yr), P(hw, hd, y0), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(1, 1, 0));
  gb.tri(P(-hw, -hd, y0), P(-ridge, 0, yr), P(-hw, hd, y0), [[0, 0], [0.5, 1], [1, 0]], snowA, V(0, 1, 1));
  gb.tri(P(hw, -hd, y0), P(hw, hd, y0), P(ridge, 0, yr), [[0, 0], [1, 0], [0.5, 1]], snowA, V(0, 1, -1));
  // eave thickness and underside
  const yb = y0 - 0.32;
  const ring = [P(-hw, -hd, 0), P(hw, -hd, 0), P(hw, hd, 0), P(-hw, hd, 0)];
  for (let i = 0; i < 4; i++) {
    const a = ring[i], c = ring[(i + 1) % 4];
    const out = V((a.x + c.x) / 2 - u, 0, (a.z + c.z) / 2 + s);
    gb.quad(V(a.x, yb, a.z), V(c.x, yb, c.z), V(c.x, y0, c.z), V(a.x, y0, a.z), [[0, -9], [1, -9], [1, -9], [0, -9]], snowA, out);
  }
  gb.quad(V(ring[0].x, yb, ring[0].z), V(ring[1].x, yb, ring[1].z), V(ring[2].x, yb, ring[2].z), V(ring[3].x, yb, ring[3].z), [[0, -9], [1, -9], [1, -9], [0, -9]], woodA, V(0, -1, 0));
}

function buildBuildings(w) {
  const tr = w.track;
  const gb = new GeoBuilder({ color: 3, aFacade: 4 });
  const plain = [5, 0.4, 0, 0];
  const grey = new THREE.Color(0x8c8577);
  for (const b of tr.buildings) {
    const color = new THREE.Color(b.color ?? 0x6e4c33);
    // walls (sunk into the slope on the uphill side)
    w._box(gb, b.s, b.u, b.w, b.d, b.base - 3, b.y1, b.base, [6, b.seed, b.kind === 'station' ? 0.6 : 0.4, 0], color, false);
    hipRoof(gb, b);
    if (b.chimney && b.kind !== 'station') {
      const cy = b.roofH(b.s + b.w * 0.2, b.u + b.d * 0.22);
      w._box(gb, b.s + b.w * 0.2, b.u + b.d * 0.22, 0.6, 0.6, cy - 0.6, cy + 1.0, cy, plain, grey, true);
    }
    if (b.kind === 'station') {
      // lift bullwheel housing on the station
      w._box(gb, b.s, b.u + b.d / 2 + 3, 6, 4, b.base, b.base + 6, b.base, plain, new THREE.Color(0x9aa0a6), true);
    }
  }
  const mesh = new THREE.Mesh(gb.build(), w.mats.facade);
  w.add(mesh, { cast: w.quality.shadows, receive: true });
}

function buildLookouts(w) {
  const tr = w.track;
  const gb = new GeoBuilder({ color: 3, aFacade: 4 });
  const plain = [5, 0.4, 0, 0];
  const wood = new THREE.Color(0x6e4c33), dark = new THREE.Color(0x3b2a1e), grey = new THREE.Color(0x8c8577);
  for (const L of tr.lookouts) {
    const s = L.s, u = L.u;
    const gy = tr.ground(s, u);
    const seed = Math.random();
    for (const a of [-2.6, 2.6]) for (const b of [-2.6, 2.6]) w._box(gb, s + a, u + b, 0.42, 0.42, gy - 3, gy + 5.2, gy, plain, dark, false);
    for (const a of [-2.6, 2.6]) w._box(gb, s + a, u, 0.18, 5.2, gy + 2.4, gy + 2.6, gy, plain, dark, false);
    w._box(gb, s, u, 7.4, 7.4, gy + 5.2, gy + 5.6, gy + 5.2, plain, wood, true);
    w._box(gb, s, u, 5.4, 5.4, gy + 5.6, gy + 8.6, gy + 5.6, [6, seed, 0.35, 0], wood, false);
    w._box(gb, s, u, 6.6, 6.6, gy + 8.6, gy + 8.95, gy + 8.6, plain, dark, true);
    w._box(gb, s + 0.6, u - 0.6, 4.0, 4.0, gy + 8.95, gy + 11.4, gy + 8.95, [6, seed + 0.3, 0.35, 0], wood.clone().multiplyScalar(1.1), false);
    w._gable(gb, s + 0.6, u - 0.6, 4.0, 4.0, gy + 11.4, 1.8, dark, seed, { style: 6 });
    for (const a of [-3.6, 3.6]) w._box(gb, s + a, u, 0.12, 7.4, gy + 5.6, gy + 6.6, gy, plain, dark, true);
    for (const b of [-3.6, 3.6]) w._box(gb, s, u + b, 7.4, 0.12, gy + 5.6, gy + 6.6, gy, plain, dark, true);
    w._box(gb, s + 0.6, u - 0.6, 0.1, 0.1, gy + 12.5, gy + 16, gy, plain, grey, false);
    w._box(gb, s + 0.6, u - 0.6 + 0.6, 0.02, 1.1, gy + 15.2, gy + 15.8, gy, plain, new THREE.Color(0xd8452a), false);
  }
  w.add(new THREE.Mesh(gb.build(), w.mats.facade), { cast: w.quality.shadows, receive: true });
}

// ------------------------------------------------------------------ lifts
function buildLifts(w) {
  const tr = w.track;
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.4 });
  w.disposables.push(steel);
  const chair = mergeGeometries([
    bake(new THREE.BoxGeometry(0.05, 2.1, 0.05).translate(0, -1.05, 0), new THREE.Matrix4(), 0x333333),
    bake(new THREE.BoxGeometry(1.4, 0.1, 0.55).translate(0, -2.1, 0.05), new THREE.Matrix4(), 0x2e5d8a),
    bake(new THREE.BoxGeometry(1.4, 0.55, 0.08).translate(0, -1.82, -0.22), new THREE.Matrix4(), 0x2e5d8a),
    bake(new THREE.BoxGeometry(1.45, 0.06, 0.06).translate(0, -1.5, 0.3), new THREE.Matrix4(), 0x333333),
  ]);
  const cm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 });
  const lm = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
  w.disposables.push(chair, cm, lm);
  w.lifts = [];
  for (const L of tr.lifts) {
    const pylonM = [], armM = [];
    const tops = [[], []];
    const ds = L.b.s - L.a.s, du = L.b.u - L.a.u;
    const len = Math.hypot(ds, du);
    // horizontal direction of the line in world space and its perpendicular
    const dir = V(du / len, 0, -ds / len);
    const side = V(-dir.z, 0, dir.x);
    const yaw = Math.atan2(side.x, side.z);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    for (const p of L.pylons) {
      const gy = tr.ground(p.s, p.u);
      const hgt = p.top - gy;
      pylonM.push(new THREE.Matrix4().compose(V(p.u, gy - 1, -p.s), q, V(1, hgt + 1, 1)));
      armM.push(new THREE.Matrix4().compose(V(p.u, p.top, -p.s), q, V(1, 1, 1)));
      tops[0].push(V(p.u, p.top, -p.s).addScaledVector(side, -2.1));
      tops[1].push(V(p.u, p.top, -p.s).addScaledVector(side, 2.1));
    }
    w._instanced(new THREE.CylinderGeometry(0.28, 0.4, 1, 10).translate(0, 0.5, 0), steel, pylonM, { cast: w.quality.shadows });
    w._instanced(new THREE.BoxGeometry(5, 0.3, 0.4), steel, armM, { cast: w.quality.shadows });
    const lp = [];
    for (const line of tops) for (let i = 0; i < line.length - 1; i++) lp.push(line[i].x, line[i].y, line[i].z, line[i + 1].x, line[i + 1].y, line[i + 1].z);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    w.add(new THREE.LineSegments(lg, lm));
    const lines = tops.map((pts, k) => {
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      return { pts: k ? pts : pts.slice().reverse(), cum: k ? cum : cum.slice().reverse().map((c) => cum[cum.length - 1] - c), len: cum[cum.length - 1] };
    });
    const spacing = 18;
    const count = Math.floor(lines[0].len / spacing) * 2;
    const im = new THREE.InstancedMesh(chair, cm, count);
    im.frustumCulled = false;
    im.castShadow = w.quality.shadows;
    w.group.add(im);
    w.lifts.push({ lines, im, spacing, count, m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: V(), d: V() });
  }
}

// ------------------------------------------------------------------ signage
function boardTexture(route, arrow) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 104;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3a2a1e';
  ctx.fillRect(0, 0, 512, 104);
  ctx.fillStyle = '#4b3727';
  for (let y = 6; y < 104; y += 24) ctx.fillRect(0, y, 512, 2);
  ctx.fillStyle = '#' + new THREE.Color(route.color).getHexString();
  ctx.fillRect(0, 0, 14, 104);
  const d = DIFF[route.diff];
  ctx.font = '900 60px "Arial Black", Impact, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = d === DIFF.hard ? '#111' : '#' + new THREE.Color(d.color).getHexString();
  if (d === DIFF.hard) { ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ctx.arc(62, 54, 34, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#111'; }
  ctx.textAlign = 'center';
  ctx.fillText(d.mark, 62, 56);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 46px "Arial Black", Impact, sans-serif';
  ctx.fillText(route.name, 110, 40);
  ctx.font = '700 26px "Hiragino Sans","Noto Sans JP",sans-serif';
  ctx.fillStyle = '#e8d8b8';
  ctx.fillText(route.jp, 112, 80);
  ctx.textAlign = 'right';
  ctx.font = '900 64px "Arial Black", Impact, sans-serif';
  ctx.fillStyle = '#ffd25a';
  ctx.fillText(arrow, 498, 56);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildSignage(w) {
  const tr = w.track;
  const wood = w.mats.wood;
  for (const g of tr.signs) {
    const gy = tr.ground(g.s, g.u);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 4.2, 8).translate(0, 2.1, 0), wood);
    post.position.set(g.u, gy - 0.5, -g.s);
    w.add(post, { cast: w.quality.shadows });
    g.boards.forEach((bd, i) => {
      const r = bd.route;
      const target = r.at(Math.min(r.s1, g.s + 130), {}).u;
      const du = target - g.u;
      const arrow = du < -25 ? '←' : du > 25 ? '→' : '↓';
      const tex = boardTexture(r, arrow);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
      w.disposables.push(tex, mat);
      const board = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.53, 0.06), [wood, wood, wood, wood, mat, wood]);
      const y = gy + 3.3 - i * 0.62;
      // angle the board a little towards its route
      board.position.set(g.u + (arrow === '←' ? -0.9 : arrow === '→' ? 0.9 : 0), y, -g.s + 0.12);
      board.rotation.y = arrow === '←' ? 0.12 : arrow === '→' ? -0.12 : 0;
      w.add(board, { cast: w.quality.shadows });
    });
  }
  // route arches with banners
  for (const a of tr.arches) {
    const r = a.route;
    const gy = Math.min(tr.ground(a.s, a.u - a.w / 2), tr.ground(a.s, a.u + a.w / 2), tr.ground(a.s, a.u));
    for (const sd of [-1, 1]) {
      const u = a.u + sd * a.w / 2;
      const yb = tr.ground(a.s, u);
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.6, 9.5, 0.6).translate(0, 4.75, 0), w.mats.darkMetal);
      pil.position.set(u, yb - 0.6, -a.s);
      w.add(pil, { cast: w.quality.shadows });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.64, 8, 0.1).translate(0, 4.8, 0.3), w.emissive(r.color, 2.2));
      strip.position.copy(pil.position);
      w.add(strip);
    }
    const d = DIFF[r.diff];
    const tex = bannerTexture(`${d.mark} ${r.name}`, [r.color, new THREE.Color(r.color).multiplyScalar(0.55).getHex()], 0xffffff);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, color: new THREE.Color(1.2, 1.2, 1.2) });
    w.disposables.push(tex, mat);
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(a.w, a.w * 0.1875), mat);
    ban.position.set(a.u, gy + 8.4, -a.s);
    w.add(ban);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(a.w + 1, 0.35, 0.45), w.mats.darkMetal);
    beam.position.set(a.u, gy + 8.4 + a.w * 0.094 + 0.2, -a.s);
    w.add(beam);
  }
}

// Piste marker poles along the route edges, tinted with the route colour.
function buildMarkers(w) {
  const tr = w.track;
  const geo = mergeGeometries([
    bake(new THREE.CylinderGeometry(0.04, 0.04, 1.35, 4, 1, true).translate(0, 0.67, 0), new THREE.Matrix4(), 0xffffff),
    bake(new THREE.CylinderGeometry(0.04, 0.04, 0.45, 4, 1, false).translate(0, 1.57, 0), new THREE.Matrix4(), 0x151515),
  ]);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 });
  w.disposables.push(geo, mat);
  const ms = [], cs = [];
  for (const r of tr.routes) {
    for (let s = r.s0 + 40; s < r.s1 - 30; s += 34) {
      const c = r.at(s, {});
      for (const sd of [-1, 1]) {
        const u = c.u + sd * c.w * 1.02;
        if (tr.obstacleAt(s, u, tr.ground(s, u) + 0.5)) continue;
        ms.push(new THREE.Matrix4().compose(V(u, tr.height(s, u) - 0.05, -s), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.04 * sd, 0, 0.05)), V(1, 1, 1)));
        cs.push(new THREE.Color(r.color));
      }
    }
  }
  const im = w._instanced(geo, mat, ms);
  if (im) cs.forEach((c, i) => im.setColorAt(i, c));
}

function buildGates(w) {
  const tr = w.track;
  const mk = (s, u0, half, text, bg, fg, lights) => {
    const y0 = Math.min(tr.ground(s, u0 - half), tr.ground(s, u0), tr.ground(s, u0 + half));
    for (const side of [-1, 1]) {
      const u = u0 + side * half;
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.7, 10, 0.7).translate(0, 5, 0), w.mats.darkMetal);
      pil.position.set(u, tr.ground(s, u) - 1, -s);
      w.add(pil, { cast: w.quality.shadows });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 8, 0.74).translate(0, 4.6, 0), w.emissive(lights, 3));
      strip.position.copy(pil.position);
      w.add(strip);
      tr.addObstacle({ s, u, r: 0.6, top: y0 + 10, kind: 'post' });
    }
    const tex = bannerTexture(text, bg, fg);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, color: new THREE.Color(1.25, 1.25, 1.25) });
    w.disposables.push(mat, tex);
    const wd = half * 2 + 1.2;
    const ban = new THREE.Mesh(new THREE.PlaneGeometry(wd, wd * 0.1875), mat);
    ban.position.set(u0, y0 + 8.6, -s);
    w.add(ban);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(wd + 1.4, 0.4, 0.5), w.mats.darkMetal);
    beam.position.set(u0, y0 + 8.6 + wd * 0.094 + 0.2, -s);
    w.add(beam);
    w.lightSpots.push({ p: V(u0, y0 + 6, -s), color: new THREE.Color(lights), power: 60 });
  };
  mk(26, 0, 13, 'DROP IN', [0x1a1a2e, 0x3a2a6e], 0xffffff, 0x2de2ff);
  mk(tr.finishS, 0, 26, 'FINISH', [0xff2d6a, 0xffa02d], 0xffffff, 0xffd02d);
  // a line of flags marks the finish across the whole base area
  const flagM = [], poleM = [];
  for (let u = -420; u <= 420; u += 14) {
    if (Math.abs(u) < 30) continue;
    const y = tr.height(tr.finishS, u);
    poleM.push(new THREE.Matrix4().compose(V(u, y, -tr.finishS), new THREE.Quaternion(), V(1, 1, 1)));
    flagM.push(new THREE.Matrix4().compose(V(u + 0.45, y + 2.3, -tr.finishS), new THREE.Quaternion(), V(1, 1, 1)));
  }
  w._instanced(new THREE.CylinderGeometry(0.04, 0.04, 2.8, 6).translate(0, 1.4, 0), w.mats.darkMetal, poleM);
  w._instanced(new THREE.BoxGeometry(0.9, 0.6, 0.02), w.emissive(0xff4a2a, 1.4), flagM);
}

// ------------------------------------------------------------------ runtime
export function updateOpenWorld(w, t, focus, camera) {
  const O = w.open;
  if (!O) return;
  for (const L of w.lifts || []) updateLift(w, t, L);
  updateBirds(w, t, focus);
  O.timer -= 1;
  if (O.timer > 0) return;
  O.timer = 6; // re-evaluate LODs every few frames
  const cx = camera.position.x, cz = camera.position.z, cyy = camera.position.y;
  let builds = 0;
  for (const c of O.chunks) {
    const dx = c.cu - cx, dz = -c.cs - cz, dy = (c.cy - cyy) * 0.5;
    const d = Math.sqrt(dx * dx + dz * dz + dy * dy);
    let L = d < LOD_DIST[0] ? 0 : d < LOD_DIST[1] ? 1 : d < LOD_DIST[2] ? 2 : d < LOD_DIST[3] ? 3 : 4;
    if (L === 0 && !c.levels[0]) {
      // stream in at most one fine chunk per frame (nearest first would need sorting; the ring is small)
      if (builds < 1) { c.levels[0] = chunkMesh(w, c, 1); builds++; } else { L = 1; O.pending = true; }
    }
    if (L !== c.level) {
      if (c.level >= 0 && c.levels[c.level]) c.levels[c.level].visible = false;
      c.levels[L].visible = true;
      c.level = L;
    }
    // free fine meshes far away
    if (c.levels[0] && L !== 0 && d > LOD_DIST[0] + 160) {
      c.levels[0].traverse((o) => o.geometry?.dispose());
      w.group.remove(c.levels[0]);
      c.levels[0] = null;
    }
  }
  if (O.pending) { O.timer = 1; O.pending = false; }
  // small features vanish into the distance
  for (const m of O.featGroups) {
    const c = m.geometry.boundingSphere.center;
    const dx = c.x - cx, dz = c.z - cz;
    m.visible = Math.sqrt(dx * dx + dz * dz) - m.geometry.boundingSphere.radius < 520;
  }
  updateForest(w, cx, cz);
}
