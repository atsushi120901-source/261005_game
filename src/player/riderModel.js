import * as THREE from 'three';
import { BodySDF } from './sdfBody.js';

// Bone layout of the rider (all bones are flat children of the rider root).
export const BONES = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
  'upperArmL', 'foreArmL', 'handL', 'upperArmR', 'foreArmR', 'handR',
];
const B = Object.fromEntries(BONES.map((n, i) => [n, i]));
const ADJ = {
  pelvis: ['spine', 'thighL', 'thighR'], spine: ['pelvis', 'chest'], chest: ['spine', 'neck', 'upperArmL', 'upperArmR'],
  neck: ['chest', 'head'], head: ['neck'],
  thighL: ['pelvis', 'shinL'], shinL: ['thighL', 'footL'], footL: ['shinL'],
  thighR: ['pelvis', 'shinR'], shinR: ['thighR', 'footR'], footR: ['shinR'],
  upperArmL: ['chest', 'foreArmL'], foreArmL: ['upperArmL', 'handL'], handL: ['foreArmL'],
  upperArmR: ['chest', 'foreArmR'], foreArmR: ['upperArmR', 'handR'], handR: ['foreArmR'],
};
export const ADJACENCY = BONES.map((n) => ADJ[n].map((m) => B[m]));

// Ankle joint inside the foot (binding) frame.
export const ANKLE = new THREE.Vector3(-0.025, 0.125, 0);

// Colour rules: ordered [signedDistance(local) (> 0 inside), region] pairs; the first
// rule that holds wins, otherwise `def`. Also reports how far the other colours are
// (used to cut crisp seams, see BodySDF).
function rules(def, list) {
  return (l) => {
    const ss = list.map((e) => e[0](l));
    const wi = ss.findIndex((v) => v > 0);
    const n = wi < 0 ? def : list[wi][1];
    const d = {};
    const put = (r, v) => { if (r !== n && !(d[r] <= v)) d[r] = v; };
    for (let j = 0; j < list.length; j++) if (wi < 0 || j < wi) put(list[j][1], -ss[j]);
    if (wi >= 0) {
      let out = def;
      for (let j = wi + 1; j < list.length; j++) if (ss[j] > 0) { out = list[j][1]; break; }
      put(out, ss[wi]);
    }
    return { n, d };
  };
}
const above = (a, v) => (l) => l[a] - v;
const below = (a, v) => (l) => v - l[a];
const band = (a, c, hw) => (l) => hw - Math.abs(l[a] - c);
const all = (...fs) => (l) => Math.min(...fs.map((fn) => fn(l)));

function bodyPrims(L) {
  const P = {};
  // front storm flap over the zip
  const flap = all(above(0, 0.05), band(2, 0, 0.018));
  const spineRegion = rules('jacket', [[below(1, -0.162), 'jacket2'], [flap, 'jacket2']]);
  const chestRegion = rules('jacket', [[flap, 'jacket2'], [above(1, 0.205), 'yoke']]);

  P.pelvis = [
    { t: 'box', c: [-0.006, -0.04, 0], h: [0.114, 0.092, 0.168], r: 0.085, region: 'pants', k: 0.04 },
    { t: 'ell', c: [0.0, -0.1, 0], r: [0.095, 0.065, 0.11], region: 'pants', k: 0.03 },
  ];
  P.spine = [
    // loose jacket body, straight cut with a defined hem over the hips
    { t: 'cyl', c: [0.0, -0.042, 0], R: 0.198, h: 0.152, r: 0.03, sx: 0.76, region: spineRegion, k: 0.014,
      fold: { kind: 'drape', amp: 0.005, freq: 9, ph: 1.3, y0: 0.04, y1: -0.19 } },
    // hand-warmer pocket flaps
    { t: 'box', c: [0.128, -0.07, -0.1], h: [0.026, 0.014, 0.058], r: 0.01, region: 'jacket2', k: 0.012 },
    { t: 'box', c: [0.128, -0.07, 0.1], h: [0.026, 0.014, 0.058], r: 0.01, region: 'jacket2', k: 0.012 },
  ];
  P.chest = [
    { t: 'box', c: [-0.006, 0.11, 0], h: [0.142, 0.162, 0.192], r: 0.125, region: chestRegion, k: 0.05,
      fold: { kind: 'drape', amp: 0.003, freq: 7, ph: 0.4, y0: 0.2, y1: 0.0 } },
    // sloping shoulders (neck to shoulder joint), no anatomy showing through
    { t: 'cone', a: [-0.012, 0.262, -0.07], b: [-0.012, 0.245, -0.2], ra: 0.08, rb: 0.08, region: 'yoke', k: 0.07 },
    { t: 'cone', a: [-0.012, 0.262, 0.07], b: [-0.012, 0.245, 0.2], ra: 0.08, rb: 0.08, region: 'yoke', k: 0.07 },
    // tall collar covering most of the neck
    { t: 'cyl', c: [-0.006, 0.335, 0], R: 0.1, h: 0.055, r: 0.024, region: 'jacket2', k: 0.025,
      fold: { kind: 'rings', amp: 0.003, freq: 60, ph: 0.3 } },
    // rolled hood on the back
    { t: 'ell', c: [-0.128, 0.315, 0], r: [0.062, 0.07, 0.13], region: 'yoke', k: 0.035 },
  ];
  if (L.backpack) {
    // flat shoulder straps and a sternum strap of the backpack
    for (const z of [-0.105, 0.105]) {
      const pts = [[-0.15, 0.24, z], [-0.07, 0.338, z], [0.06, 0.33, z], [0.152, 0.2, z * 1.05], [0.156, 0.03, z * 1.12]];
      for (let i = 0; i < pts.length - 1; i++) {
        P.chest.push({ t: 'cone', a: pts[i], b: pts[i + 1], ra: 0.01, rb: 0.01, sz: 2.1, region: 'webbing', k: 0.005, priority: 0.006 });
      }
    }
    P.chest.push({ t: 'box', c: [0.162, 0.13, 0], h: [0.01, 0.014, 0.12], r: 0.007, region: 'webbing', k: 0.004, priority: 0.006 });
  }
  P.neck = [
    { t: 'cone', a: [0, -0.03, 0], b: [0.012, 0.09, 0], ra: 0.08, rb: 0.07, region: 'gaiter', k: 0.035,
      fold: { kind: 'rings', amp: 0.004, freq: 60, ph: 0.5 } },
  ];
  // balaclava / gaiter: the face is fully covered below the goggles
  P.head = [
    { t: 'ell', c: [-0.01, 0.025, 0], r: [0.108, 0.122, 0.096], region: 'gaiter', k: 0.03 },
    { t: 'ell', c: [0.028, -0.042, 0], r: [0.084, 0.074, 0.084], region: 'gaiter', k: 0.045 },
    { t: 'cone', a: [0.094, 0.004, 0], b: [0.11, -0.026, 0], ra: 0.016, rb: 0.022, region: 'gaiter', k: 0.025 },
  ];
  for (const [side, sfx] of [[-1, 'L'], [1, 'R']]) {
    P['thigh' + sfx] = [
      // top of the thigh tucked inwards so the pants stay under the jacket at the hips
      { t: 'cone', a: [-side * 0.025, 0.0, 0], b: [0, 0.43, 0.005], ra: 0.108, rb: 0.097, k: 0.045, region: 'pants',
        fold: { kind: 'rings', amp: 0.007, freq: 30, ph: side * 1.3 } },
      { t: 'ell', c: [0, 0.43, 0.035], r: [0.088, 0.08, 0.072], region: 'pants', k: 0.04 },
      // cargo pocket on the outside of the thigh
      { t: 'box', c: [side * 0.103, 0.2, 0.0], h: [0.017, 0.072, 0.06], r: 0.014, region: 'pants', k: 0.02 },
    ];
    P['shin' + sfx] = [
      { t: 'cone', a: [0, 0, 0], b: [0, 0.3, -0.005], ra: 0.097, rb: 0.093, k: 0.04, region: 'pants',
        fold: { kind: 'rings', amp: 0.006, freq: 36, ph: side * 2.1 } },
      // pants stacking over the boots
      { t: 'cone', a: [0, 0.2, -0.01], b: [0, 0.37, -0.02], ra: 0.096, rb: 0.116, region: 'pants', k: 0.03,
        fold: { kind: 'rings', amp: 0.01, freq: 50, ph: 2, y0: 0.2, y1: 0.36 } },
    ];
    const shaftRegion = rules('boots', [[above(1, 0.19), 'boots2'], [all(above(0, 0.015), band(2, 0, 0.024)), 'laces']]);
    P['foot' + sfx] = [
      { t: 'box', c: [0.005, 0.038, 0], h: [0.158, 0.014, 0.06], r: 0.01, region: 'sole', k: 0.006 },
      { t: 'box', c: [0.0, 0.085, 0], h: [0.14, 0.045, 0.056], r: 0.035, region: rules('boots', [[all(above(0, 0.03), band(2, 0, 0.022), above(1, 0.11)), 'laces']]), k: 0.02 },
      { t: 'ell', c: [0.105, 0.075, 0], r: [0.06, 0.042, 0.057], region: 'boots', k: 0.02 },
      { t: 'cone', a: [-0.03, 0.09, 0], b: [-0.025, 0.15, 0], ra: 0.068, rb: 0.062, region: shaftRegion, k: 0.02 },
      { t: 'cone', a: [0.04, 0.11, 0], b: [0.015, 0.16, 0], ra: 0.034, rb: 0.038, region: 'laces', k: 0.02 },
    ];
    const t = -side; // thumb points forward
    P['upperArm' + sfx] = [
      { t: 'ell', c: [0, 0.03, 0], r: [0.082, 0.09, 0.082], region: rules('jacket', [[below(1, 0.07), 'yoke']]), k: 0.05 },
      { t: 'cone', a: [0, 0, 0], b: [0, 0.29, 0], ra: 0.08, rb: 0.068, k: 0.035,
        region: rules('jacket', [[below(1, 0.07), 'yoke']]),
        fold: { kind: 'rings', amp: 0.006, freq: 38, ph: side } },
    ];
    P['foreArm' + sfx] = [
      { t: 'cone', a: [0, 0, 0], b: [0, 0.19, 0], ra: 0.069, rb: 0.058, k: 0.035,
        region: rules('jacket', [[above(1, 0.15), 'jacket2']]),
        fold: { kind: 'rings', amp: 0.005, freq: 46, ph: 0.7 } },
      // glove gauntlet over the cuff
      { t: 'cone', a: [0, 0.165, 0], b: [0, 0.255, 0], ra: 0.072, rb: 0.07, region: 'gloves', k: 0.01,
        fold: { kind: 'rings', amp: 0.003, freq: 70, ph: 0.2 } },
    ];
    P['hand' + sfx] = [
      { t: 'box', c: [0, 0.055, 0], h: [0.045, 0.05, 0.026], r: 0.02, region: 'gloves', k: 0.022 },
      { t: 'box', c: [0, 0.118, -0.009], h: [0.043, 0.032, 0.022], r: 0.018, region: 'gloves', k: 0.02,
        fold: { kind: 'fingers', amp: 0.0035 } },
      { t: 'ell', c: [0, 0.145, -0.026], r: [0.041, 0.019, 0.021], region: 'gloves', k: 0.02 },
      { t: 'cone', a: [t * 0.034, 0.035, -0.01], b: [t * 0.048, 0.085, -0.032], ra: 0.019, rb: 0.016, region: 'gloves', k: 0.016 },
    ];
  }
  return P;
}

function palette(L) {
  const c = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
  const lace = L.leather ? 0x6e5a44 : 0x2a2b2e;
  return {
    default: { color: c(L.jacket), rough: 0.8, fabric: 1 },
    jacket: { color: c(L.jacket), rough: 0.78, fabric: 1 },
    jacket2: { color: c(L.jacket2), rough: 0.8, fabric: 1 },
    yoke: { color: c(L.yoke ?? L.jacket2), rough: 0.8, fabric: 1 },
    pants: { color: c(L.pants), rough: 0.88, fabric: 1.2 },
    gloves: { color: c(L.gloves), rough: 0.7, fabric: 0.8 },
    boots: { color: c(L.boots), rough: L.leather ? 0.7 : 0.45, fabric: 0.6 },
    boots2: { color: c(L.boots, 0.7), rough: 0.75, fabric: 0.6 },
    laces: { color: c(lace), rough: 0.85, fabric: 0.8 },
    sole: { color: c(0x2a2624), rough: 0.9, fabric: 0.2 },
    gaiter: { color: c(L.gaiter), rough: 0.95, fabric: 1.2 },
    webbing: { color: c(L.webbing ?? 0x2e3033), rough: 0.8, fabric: 0.9 },
    metal: { color: c(0x8f949a), rough: 0.35, fabric: 0 },
  };
}

// Order in which bones join the smooth union: the legs are merged before the jacket
// so its hem keeps a crisp edge over the pants instead of melting into them.
const UNION_ORDER = { pelvis: 0, thighL: 1, thighR: 1, shinL: 1, shinR: 1, footL: 1, footR: 1, spine: 2, chest: 3, neck: 4, head: 4 };

// Sculpt the rider's body. look: the rider's look data; bind: 17 column-major
// 4x4 bind matrices (arrays). Returns plain typed arrays (worker friendly).
export function buildRiderData(look, bind, cell = 0.012) {
  const prims = bodyPrims(look);
  const bones = BONES.map((name, i) => ({ name, bind: new THREE.Matrix4().fromArray(bind[i]), prims: prims[name] || [], order: UNION_ORDER[name] ?? 5 }));
  const sdf = new BodySDF(bones, ADJACENCY);
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const b of bones) {
    if (b.cr < 0) continue;
    const c = [b.cx, b.cy, b.cz];
    for (let a2 = 0; a2 < 3; a2++) { mn[a2] = Math.min(mn[a2], c[a2] - b.cr); mx[a2] = Math.max(mx[a2], c[a2] + b.cr); }
  }
  return sdf.mesh([mn.map((v) => v - 0.03), mx.map((v) => v + 0.03)], cell, palette(look));
}
