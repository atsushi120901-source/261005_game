import * as THREE from 'three';

// Turn the typed arrays produced by BodySDF.mesh into a BufferGeometry.
export function bodyGeometry(d) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(d.color, 3));
  geo.setAttribute('aMat', new THREE.BufferAttribute(d.aMat, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(d.skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(d.skinWeight, 4));
  geo.setIndex(new THREE.BufferAttribute(d.index, 1));
  geo.computeBoundingSphere();
  return geo;
}

// Sculpts a single continuous, skinned body mesh from signed-distance
// primitives attached to bones. The surface is extracted with "surface nets"
// (one vertex per boundary cell, projected back onto the surface), then each
// vertex gets skin weights from its distance to every bone's primitives, a
// region colour and baked ambient occlusion.
//
// Primitive (all coordinates in the bone's bind-pose local frame):
//   { t: 'cone', a:[x,y,z], b:[x,y,z], ra, rb }        round cone / capsule
//   { t: 'ell',  c:[x,y,z], r:[rx,ry,rz] }              ellipsoid
//   { t: 'box',  c:[x,y,z], h:[hx,hy,hz], r }           rounded box (h = half size)
//   { t: 'torus', c:[x,y,z], R, r }                     torus in the local XZ plane
//   { t: 'cyl', c:[x,y,z], R, h, r }                    capped cylinder along Y (h = half height, r = edge rounding)
// Optional: k (blend radius), sx/sz (squash local x/z), fold: { kind, amp, freq, ph, y0, y1 }
// (geometric fabric folds), region: a palette key, or fn(local) returning a key or
// { n, d: { otherKey: distance to that colour } }.
//
// Colour seams are cut into the mesh: every vertex knows how far it is from each
// nearby colour region, and triangles that straddle a seam are clipped along the
// interpolated boundary, so panels get crisp, smooth edges instead of a smear or a
// staircase across the mesh cells.

const smin = (a, b, k) => {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

function sdRoundCone(px, py, pz, p) {
  const ax = p.a[0], ay = p.a[1], az = p.a[2];
  const bax = p.ba[0], bay = p.ba[1], baz = p.ba[2];
  const l2 = p.l2, rr = p.rr, a2 = p.a2, il2 = p.il2;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const qx = pax * l2 - bax * y, qy = pay * l2 - bay * y, qz = paz * l2 - baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - p.rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - p.ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - p.ra;
}

function sdEll(px, py, pz, p) {
  const x = px - p.c[0], y = py - p.c[1], z = pz - p.c[2];
  const rx = p.r[0], ry = p.r[1], rz = p.r[2];
  const ax = x / rx, ay = y / ry, az = z / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const bx = ax / rx, by = ay / ry, bz = az / rz;
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}

function sdBox(px, py, pz, p) {
  const r = p.r;
  const qx = Math.abs(px - p.c[0]) - p.h[0] + r;
  const qy = Math.abs(py - p.c[1]) - p.h[1] + r;
  const qz = Math.abs(pz - p.c[2]) - p.h[2] + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
}

function sdCyl(px, py, pz, p) {
  const x = px - p.c[0], y = py - p.c[1], z = pz - p.c[2];
  const dx = Math.sqrt(x * x + z * z) - p.R + p.r, dy = Math.abs(y) - p.h + p.r;
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ox * ox + oy * oy) - p.r;
}

function sdTorus(px, py, pz, p) {
  const x = px - p.c[0], y = py - p.c[1], z = pz - p.c[2];
  const q = Math.sqrt(x * x + z * z) - p.R;
  return Math.sqrt(q * q + y * y) - p.r;
}

// Geometric fabric folds as a displacement of the distance field.
function foldAt(f, x, y, z) {
  const env = f.y0 !== undefined ? Math.min(1, Math.max(0, (y - f.y0) / (f.y1 - f.y0))) : 1;
  if (env <= 0) return 0;
  if (f.kind === 'rings') {
    // wandering horizontal compression folds (pants, sleeves); angle harmonics without trig
    const r = Math.sqrt(x * x + z * z) || 1e-6;
    const c = x / r, sn = z / r;
    const c2 = c * c - sn * sn, s2 = 2 * c * sn;
    const c3 = c * c2 - sn * s2, s3 = sn * c2 + c * s2;
    const s5 = s2 * c3 + c2 * s3, c5 = c2 * c3 - s2 * s3;
    const tp = f.trig || (f.trig = [Math.cos(f.ph), Math.sin(f.ph), Math.cos(2 * f.ph), Math.sin(2 * f.ph), Math.cos(3 * f.ph), Math.sin(3 * f.ph)]);
    const w = 1.7 * (s2 * tp[0] + c2 * tp[1]) + 0.6 * (s5 * tp[2] + c5 * tp[3]);
    return f.amp * env * Math.sin(y * f.freq + w) * (0.55 + 0.45 * (s3 * tp[4] + c3 * tp[5]));
  }
  const th = Math.atan2(z, x);
  switch (f.kind) {
    case 'drape': // vertical hanging folds (jacket body)
      return f.amp * env * Math.sin(th * f.freq + 0.9 * Math.sin(y * 9 + f.ph)) * (0.6 + 0.4 * Math.sin(th * 2.3 + y * 4));
    case 'quilt': // horizontal stitched baffles
      return -f.amp * env * Math.pow(Math.abs(Math.sin(y * f.freq + f.ph)), 6);
    case 'fingers': // grooves between fingers on gloves (x across the hand)
      return -f.amp * env * Math.pow(Math.abs(Math.cos((x + 0.0105) * (Math.PI / 0.021))), 8);
    case 'knit':
      return f.amp * env * Math.pow(Math.abs(Math.sin(th * f.freq)), 0.5);
    default:
      return 0;
  }
}

function primDist(p, x, y, z) {
  let lx = x, lz = z, scale = 1;
  if (p.sx || p.sz) {
    const sx = p.sx || 1, sz = p.sz || 1;
    lx = (x - p.oc[0]) / sx + p.oc[0];
    lz = (z - p.oc[2]) / sz + p.oc[2];
    scale = Math.min(sx, sz, 1);
  }
  let d;
  switch (p.t) {
    case 'cone': d = sdRoundCone(lx, y, lz, p); break;
    case 'ell': d = sdEll(lx, y, lz, p); break;
    case 'box': d = sdBox(lx, y, lz, p); break;
    case 'cyl': d = sdCyl(lx, y, lz, p); break;
    default: d = sdTorus(lx, y, lz, p); break;
  }
  d *= scale;
  // folds only matter close to the surface
  if (p.fold && d < 0.03 && d > -0.03) d -= foldAt(p.fold, x - p.oc[0], y, z - p.oc[2]);
  return d;
}

function preparePrim(p) {
  if (p.t === 'cone') {
    const ba = [p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2]];
    p.ba = ba;
    p.l2 = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2];
    p.rr = p.ra - p.rb;
    p.a2 = p.l2 - p.rr * p.rr;
    p.il2 = 1 / p.l2;
    p.oc = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2];
    p.bc = p.oc;
    p.br = Math.sqrt(p.l2) / 2 + Math.max(p.ra, p.rb) * Math.max(p.sx || 1, p.sz || 1, 1);
  } else {
    p.oc = p.c;
    p.bc = p.c;
    const ext = p.t === 'ell' ? Math.max(...p.r) : p.t === 'box' ? Math.hypot(...p.h) : p.t === 'cyl' ? Math.hypot(p.R, p.h) : p.R + p.r;
    p.br = ext * Math.max(p.sx || 1, p.sz || 1, 1);
  }
  p.k = p.k ?? 0.03;
  p.br += (p.fold ? Math.abs(p.fold.amp) : 0) + 0.002;
}

export class BodySDF {
  // bones: [{ bind: Matrix4 (root space), prims: [...] }]
  constructor(bones, adjacency) {
    this.bones = bones;
    this.adj = adjacency;
    for (const b of bones) {
      const inv = b.bind.clone().invert().elements;
      // row-major 3x4 for fast transforms
      b.ie = [inv[0], inv[4], inv[8], inv[12], inv[1], inv[5], inv[9], inv[13], inv[2], inv[6], inv[10], inv[14]];
      b.prims.forEach(preparePrim);
      // bounding sphere of the bone's primitives in root space
      let cx = 0, cy = 0, cz = 0, n = 0;
      const pts = [];
      for (const p of b.prims) {
        const v = new THREE.Vector3(...p.bc).applyMatrix4(b.bind);
        pts.push([v, p.br]);
        cx += v.x; cy += v.y; cz += v.z; n++;
      }
      if (!n) { b.cr = -1; continue; }
      b.cx = cx / n; b.cy = cy / n; b.cz = cz / n;
      b.cr = 0;
      for (const [v, r] of pts) b.cr = Math.max(b.cr, Math.hypot(v.x - b.cx, v.y - b.cy, v.z - b.cz) + r);
    }
    this.margin = Math.max(...bones.flatMap((b) => b.prims.map((p) => p.k))) + 0.005;
    // union order (optional per-bone `order`)
    this.unionOrder = bones.filter((b) => b.cr >= 0).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  dist(x, y, z) {
    let d = 1e9;
    const m = this.margin;
    const ub = this.unionOrder;
    for (let bi = 0; bi < ub.length; bi++) {
      const b = ub[bi];
      const dx = x - b.cx, dy = y - b.cy, dz = z - b.cz;
      const lim = d + m + b.cr;
      if (lim > 0 && dx * dx + dy * dy + dz * dz > lim * lim) continue;
      const e = b.ie;
      const lx = e[0] * x + e[1] * y + e[2] * z + e[3];
      const ly = e[4] * x + e[5] * y + e[6] * z + e[7];
      const lz = e[8] * x + e[9] * y + e[10] * z + e[11];
      const prims = b.prims;
      for (let q = 0; q < prims.length; q++) {
        const p = prims[q];
        // cheap bounding-sphere rejection per primitive
        const ex = lx - p.bc[0], ey = ly - p.bc[1], ez = lz - p.bc[2];
        const lim2 = d + p.k + p.br;
        if (lim2 > 0 && ex * ex + ey * ey + ez * ez > lim2 * lim2) continue;
        d = smin(d, primDist(p, lx, ly, lz), p.k);
      }
    }
    return d;
  }

  // Per-bone nearest primitive distance and the primary primitive (for weights and colour).
  probe(x, y, z) {
    const nb = this.bones.length;
    const per = this._per || (this._per = new Float64Array(nb));
    const loc = this._loc || (this._loc = new Float64Array(nb * 3));
    per.fill(1e9);
    const cands = [];
    let best = 1e9, bestPrim = null, bestBone = -1;
    for (let bi = 0; bi < nb; bi++) {
      const b = this.bones[bi];
      if (b.cr < 0) continue;
      const dx = x - b.cx, dy = y - b.cy, dz = z - b.cz;
      const lim = best + 0.12 + b.cr;
      if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
      const e = b.ie;
      const lx = e[0] * x + e[1] * y + e[2] * z + e[3];
      const ly = e[4] * x + e[5] * y + e[6] * z + e[7];
      const lz = e[8] * x + e[9] * y + e[10] * z + e[11];
      loc[bi * 3] = lx; loc[bi * 3 + 1] = ly; loc[bi * 3 + 2] = lz;
      for (const p of b.prims) {
        const d = primDist(p, lx, ly, lz);
        if (d < per[bi]) per[bi] = d;
        // colour priority: details (straps, patches) win when on the surface
        const dd = d - (p.priority || 0);
        cands.push(dd, p, bi);
        if (dd < best) { best = dd; bestPrim = p; bestBone = bi; }
      }
    }
    return { per, prim: bestPrim, bone: bestBone, best, cands, loc };
  }

  grad(x, y, z, out) {
    // tetrahedral finite differences: 4 samples instead of 6
    const e = 0.0012;
    const a = this.dist(x + e, y - e, z - e), b = this.dist(x - e, y - e, z + e);
    const c = this.dist(x - e, y + e, z - e), d = this.dist(x + e, y + e, z + e);
    out[0] = a - b - c + d;
    out[1] = -a - b + c + d;
    out[2] = -a + b - c + d;
    const l = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }

  // Extract the surface. bounds: [min, max] in root space, h: cell size.
  mesh(bounds, h, palette) {
    const [mn, mx] = bounds;
    const nx = Math.ceil((mx[0] - mn[0]) / h), ny = Math.ceil((mx[1] - mn[1]) / h), nz = Math.ceil((mx[2] - mn[2]) / h);
    const sx = nx + 1, sy = ny + 1, sz = nz + 1;
    const F = new Float32Array(sx * sy * sz).fill(1);
    const idx = (i, j, k) => (k * sy + j) * sx + i;
    // ---- hierarchical narrow band: 6h grid -> 2h grid -> h grid, refining only near the surface
    const set = new Uint8Array(sx * sy * sz);
    const ev = (i, j, k) => {
      const id = idx(i, j, k);
      if (!set[id]) { F[id] = this.dist(mn[0] + i * h, mn[1] + j * h, mn[2] + k * h) || 1e-6; set[id] = 1; }
      return F[id];
    };
    const blocks = (i0, j0, k0, i1, j1, k1, step) => {
      const out = [];
      for (let k = k0; k < k1; k += step) for (let j = j0; j < j1; j += step) for (let i = i0; i < i1; i += step) {
        out.push(i, j, k, Math.min(i + step, i1), Math.min(j + step, j1), Math.min(k + step, k1));
      }
      return out;
    };
    const isNear = (b, q, thr) => {
      let neg = 0, near = false;
      for (let c = 0; c < 8; c++) {
        const v = ev(c & 1 ? b[q + 3] : b[q], c & 2 ? b[q + 4] : b[q + 1], c & 4 ? b[q + 5] : b[q + 2]);
        if (v < 0) neg++;
        if (Math.abs(v) < thr) near = true;
      }
      return near || (neg > 0 && neg < 8);
    };
    const L1 = blocks(0, 0, 0, nx, ny, nz, 6);
    const L2 = [];
    for (let q = 0; q < L1.length; q += 6) {
      if (!isNear(L1, q, 6 * h * 1.15)) continue;
      L2.push(...blocks(L1[q], L1[q + 1], L1[q + 2], L1[q + 3], L1[q + 4], L1[q + 5], 2));
    }
    const near = [];
    for (let q = 0; q < L2.length; q += 6) {
      if (!isNear(L2, q, 2 * h * 1.25)) continue;
      for (let k = L2[q + 2]; k <= L2[q + 5]; k++) for (let j = L2[q + 1]; j <= L2[q + 4]; j++) for (let i = L2[q]; i <= L2[q + 3]; i++) ev(i, j, k);
      near.push(L2[q], L2[q + 1], L2[q + 2], L2[q + 3], L2[q + 4], L2[q + 5]);
    }
    // ---- one vertex per cell that straddles the surface (only inside near blocks)
    const cellV = new Int32Array(nx * ny * nz).fill(-1);
    const cid = (i, j, k) => (k * ny + j) * nx + i;
    const pos = [];
    const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const cv = new Float32Array(8);
    const g = [0, 0, 0];
    const OFF = [0, 1, sx, sx + 1, sx * sy, sx * sy + 1, sx * sy + sx, sx * sy + sx + 1];
    for (let q = 0; q < near.length; q += 6) {
      const i0 = near[q], j0 = near[q + 1], k0 = near[q + 2], i1 = near[q + 3], j1 = near[q + 4], k1 = near[q + 5];
      for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
        const base = idx(i, j, k);
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = F[base + OFF[c]];
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let ax = 0, ay = 0, az = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = cv[a], vb = cv[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          ax += (a & 1) + t * ((b & 1) - (a & 1));
          ay += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          az += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
          n++;
        }
        let x = mn[0] + (i + ax / n) * h, y = mn[1] + (j + ay / n) * h, z = mn[2] + (k + az / n) * h;
        // project onto the true surface
        const d = this.dist(x, y, z);
        this.grad(x, y, z, g);
        x -= g[0] * d; y -= g[1] * d; z -= g[2] * d;
        cellV[cid(i, j, k)] = pos.length / 3;
        pos.push(x, y, z);
      }
    }
    // ---- quads across every sign-changing grid edge
    const index = [];
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      // split along the shorter diagonal
      const dAC = (pos[a * 3] - pos[c * 3]) ** 2 + (pos[a * 3 + 1] - pos[c * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[c * 3 + 2]) ** 2;
      const dBD = (pos[b * 3] - pos[d * 3]) ** 2 + (pos[b * 3 + 1] - pos[d * 3 + 1]) ** 2 + (pos[b * 3 + 2] - pos[d * 3 + 2]) ** 2;
      const t = dAC < dBD ? [a, b, c, a, c, d] : [a, b, d, b, c, d];
      if (flip) for (let q = 0; q < 6; q += 3) { const s2 = t[q + 1]; t[q + 1] = t[q + 2]; t[q + 2] = s2; }
      index.push(...t);
    };
    for (let q = 0; q < near.length; q += 6) {
      const i0 = near[q], j0 = near[q + 1], k0 = near[q + 2], i1 = near[q + 3], j1 = near[q + 4], k1 = near[q + 5];
      for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
        const base = idx(i, j, k);
        const v0 = F[base] < 0;
        if (j > 0 && k > 0 && (F[base + 1] < 0) !== v0) {
          quad(cellV[cid(i, j - 1, k - 1)], cellV[cid(i, j, k - 1)], cellV[cid(i, j, k)], cellV[cid(i, j - 1, k)], !v0);
        }
        if (i > 0 && k > 0 && (F[base + sx] < 0) !== v0) {
          quad(cellV[cid(i - 1, j, k - 1)], cellV[cid(i - 1, j, k)], cellV[cid(i, j, k)], cellV[cid(i, j, k - 1)], !v0);
        }
        if (i > 0 && j > 0 && (F[base + sx * sy] < 0) !== v0) {
          quad(cellV[cid(i - 1, j - 1, k)], cellV[cid(i, j - 1, k)], cellV[cid(i, j, k)], cellV[cid(i - 1, j, k)], !v0);
        }
      }
    }
    return this._attributes(pos, index, palette);
  }

  _attributes(pos, index, palette) {
    const nv = pos.length / 3;
    const nor = new Float32Array(nv * 3);
    const occl = new Float32Array(nv);
    const sIdx = new Uint16Array(nv * 4);
    const sW = new Float32Array(nv * 4);
    const g = [0, 0, 0];
    const sigma = 0.022;
    const keys = Object.keys(palette);
    const NR = keys.length;
    const kidx = Object.fromEntries(keys.map((k, i) => [k, i]));
    const ri = (n) => kidx[n] ?? kidx.default ?? 0;
    const CAP = 0.06;
    const own = new Int16Array(nv);
    const D = new Float32Array(nv * NR).fill(CAP);
    const l = [0, 0, 0];
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      this.grad(x, y, z, g);
      nor[v * 3] = g[0]; nor[v * 3 + 1] = g[1]; nor[v * 3 + 2] = g[2];
      // ambient occlusion from the distance field
      let occ = 0, w = 1;
      for (let s = 1; s <= 3; s++) {
        const dl = s * 0.024;
        const d = this.dist(x + g[0] * dl, y + g[1] * dl, z + g[2] * dl);
        occ += (dl - Math.max(0, d)) * w;
        w *= 0.55;
      }
      occl[v] = Math.max(0.42, Math.min(1, 1 - occ * 6.5));
      // skin weights restricted to the primary bone and its neighbours
      const pr = this.probe(x, y, z);
      const cand = [pr.bone, ...(this.adj[pr.bone] || [])];
      const dmin = pr.per[pr.bone];
      const ws = cand.map((bi) => [bi, Math.exp(-Math.max(0, pr.per[bi] - dmin) / sigma)])
        .sort((a, b) => b[1] - a[1]).slice(0, 4);
      const tot = ws.reduce((a, b) => a + b[1], 0);
      ws.forEach(([bi, wt], q) => { sIdx[v * 4 + q] = bi; sW[v * 4 + q] = wt / tot; });
      // distance from this vertex to every nearby colour region
      const c = pr.cands, base = v * NR;
      for (let q = 0; q < c.length; q += 3) {
        const df = c[q] - pr.best;
        if (df >= CAP) continue;
        const p = c[q + 1], bi = c[q + 2];
        let r = p.region;
        if (typeof r === 'function') {
          l[0] = pr.loc[bi * 3]; l[1] = pr.loc[bi * 3 + 1]; l[2] = pr.loc[bi * 3 + 2];
          r = r(l);
        }
        if (r && typeof r === 'object') {
          const i0 = base + ri(r.n);
          if (df < D[i0]) D[i0] = df;
          for (const k in r.d) {
            const i1 = base + ri(k), dv = df + r.d[k];
            if (dv < D[i1]) D[i1] = dv;
          }
          if (p === pr.prim) own[v] = ri(r.n);
        } else {
          const i0 = base + ri(r);
          if (df < D[i0]) D[i0] = df;
          if (p === pr.prim) own[v] = ri(r);
        }
      }
      D[base + own[v]] = 0;
    }

    // ---- cut triangles along colour seams
    const oPos = [], oNor = [], oCol = [], oMat = [], oSI = [], oSW = [], oIdx = [];
    const vmap = new Map();
    const emit = (rec, r) => {
      const key = rec.key + '|' + r;
      let id = vmap.get(key);
      if (id !== undefined) return id;
      id = oPos.length / 3;
      oPos.push(rec.p[0], rec.p[1], rec.p[2]);
      oNor.push(rec.n[0], rec.n[1], rec.n[2]);
      const pal = palette[keys[r]] || palette.default;
      oCol.push(pal.color.r * rec.ao, pal.color.g * rec.ao, pal.color.b * rec.ao);
      oMat.push(pal.rough, pal.fabric);
      for (let q = 0; q < 4; q++) { oSI.push(rec.si[q]); oSW.push(rec.sw[q]); }
      vmap.set(key, id);
      return id;
    };
    const orig = (v, S) => ({
      key: v, v,
      p: [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], n: [nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]], ao: occl[v],
      si: [sIdx[v * 4], sIdx[v * 4 + 1], sIdx[v * 4 + 2], sIdx[v * 4 + 3]],
      sw: [sW[v * 4], sW[v * 4 + 1], sW[v * 4 + 2], sW[v * 4 + 3]],
      d: S.map((r) => D[v * NR + r]),
    });
    const emitOrig = (v, r) => vmap.get(v + '|' + r) ?? emit(orig(v, []), r);
    let uid = 0;
    const lerpRec = (A, B, t, key) => {
      const p = [0, 1, 2].map((q) => A.p[q] + (B.p[q] - A.p[q]) * t);
      const n = [0, 1, 2].map((q) => A.n[q] + (B.n[q] - A.n[q]) * t);
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      const acc = new Map();
      for (let q = 0; q < 4; q++) {
        acc.set(A.si[q], (acc.get(A.si[q]) || 0) + A.sw[q] * (1 - t));
        acc.set(B.si[q], (acc.get(B.si[q]) || 0) + B.sw[q] * t);
      }
      const ws = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
      while (ws.length < 4) ws.push([0, 0]);
      const tw = ws.reduce((a, b) => a + b[1], 0) || 1;
      return {
        key, p, n: [n[0] / nl, n[1] / nl, n[2] / nl], ao: A.ao + (B.ao - A.ao) * t,
        si: ws.map((e) => e[0]), sw: ws.map((e) => e[1] / tw), d: A.d.map((dv, q) => dv + (B.d[q] - dv) * t),
      };
    };
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      if (own[a] === own[b] && own[a] === own[c]) {
        // fast path: one colour, shared vertices
        oIdx.push(emitOrig(a, own[a]), emitOrig(b, own[a]), emitOrig(c, own[a]));
        continue;
      }
      const S = [...new Set([own[a], own[b], own[c]])];
      const tri = [orig(a, S), orig(b, S), orig(c, S)];
      for (let si = 0; si < S.length; si++) {
        let poly = tri;
        for (let sj = 0; sj < S.length && poly.length >= 3; sj++) {
          if (sj === si) continue;
          const gv = (R) => R.d[si] - R.d[sj];
          const lo = Math.min(S[si], S[sj]), hi = Math.max(S[si], S[sj]);
          const out = [];
          for (let q = 0; q < poly.length; q++) {
            const A = poly[q], B = poly[(q + 1) % poly.length];
            const ga = gv(A), gb = gv(B);
            if (ga <= 0) out.push(A);
            if ((ga <= 0) !== (gb <= 0)) {
              if (A.v !== undefined && B.v !== undefined) {
                // canonical edge split so neighbouring triangles agree exactly
                const [P, Q, gp, gq] = A.v < B.v ? [A, B, ga, gb] : [B, A, gb, ga];
                out.push(lerpRec(P, Q, gp / (gp - gq), `e${P.v}_${Q.v}_${lo}_${hi}`));
              } else {
                out.push(lerpRec(A, B, ga / (ga - gb), 'x' + uid++));
              }
            }
          }
          poly = out;
        }
        if (poly.length < 3) continue;
        const ids = poly.map((R) => emit(R, S[si]));
        for (let q = 1; q < ids.length - 1; q++) oIdx.push(ids[0], ids[q], ids[q + 1]);
      }
    }
    const no = oPos.length / 3;
    return {
      position: new Float32Array(oPos), normal: new Float32Array(oNor), color: new Float32Array(oCol), aMat: new Float32Array(oMat),
      skinIndex: new Uint16Array(oSI), skinWeight: new Float32Array(oSW),
      index: no > 65535 ? new Uint32Array(oIdx) : new Uint16Array(oIdx),
    };
  }
}
