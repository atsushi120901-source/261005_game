import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { damp, clamp } from '../core/utils.js';
import { boardTexture, glowTexture } from '../gfx/textures.js';
import { fabricNormal } from '../gfx/fabric.js';

// Procedural snowboarder.
// Local space: board long axis = Z (nose at -Z), rider faces +X (toe edge),
// y = 0 is the board base. Legs and arms are solved with two-bone IK every
// frame so feet stay locked in the bindings and hands can really grab the board.

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Y = V(0, 1, 0);

// Fresnel rim light so the rider reads well against busy backgrounds.
function rimPatch(mat, rim = 0.35, color = 0x9fc8ff) {
  const c = new THREE.Color(color);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = { value: rim };
    sh.uniforms.uRimColor = { value: c };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform vec3 uRimColor;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        { float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          totalEmissiveRadiance += uRimColor * pow(1.0 - nv, 3.0) * uRim; }`
      );
  };
  mat.customProgramCacheKey = () => 'rim' + rim;
  return mat;
}

function fabric(color, opts = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color,
    roughness: opts.roughness ?? 0.72,
    metalness: 0,
    sheen: opts.sheen ?? 0.6,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35),
    clearcoat: opts.clearcoat ?? 0,
    clearcoatRoughness: 0.4,
  });
  if (opts.weave) {
    // per-material clone so each garment can tile its folds differently
    const n = fabricNormal(opts.weave).clone();
    n.needsUpdate = true;
    n.repeat.set(...(opts.repeat || [2, 3]));
    m.normalMap = n;
    m.normalScale.set(opts.bump ?? 0.6, opts.bump ?? 0.6);
  }
  return rimPatch(m, opts.rim ?? 0.12);
}

// Tube along +Y with elliptical rings: [y, rx (lateral), rz (front/back), oz (front offset)].
function profileGeo(rings, radial = 20) {
  const pos = [], uv = [], idx = [];
  const n = rings.length;
  for (let i = 0; i < n; i++) {
    const [y, rx, rz, oz = 0, ox = 0] = rings[i];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      pos.push(ox + Math.cos(a) * rx, y, oz + Math.sin(a) * rz);
      uv.push(j / radial, i / (n - 1));
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Side silhouette of a snowboard boot, extruded and bevelled.
function bootGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.13, 0);
  s.lineTo(0.12, 0);
  s.quadraticCurveTo(0.168, 0.0, 0.168, 0.05);
  s.quadraticCurveTo(0.168, 0.098, 0.118, 0.108);
  s.quadraticCurveTo(0.07, 0.122, 0.048, 0.16);
  s.lineTo(0.03, 0.272);
  s.quadraticCurveTo(-0.04, 0.29, -0.108, 0.283);
  s.quadraticCurveTo(-0.128, 0.2, -0.142, 0.11);
  s.quadraticCurveTo(-0.158, 0.02, -0.13, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.022, bevelSize: 0.02, bevelSegments: 3, curveSegments: 10 });
  g.translate(0, 0, -0.05);
  g.computeVertexNormals();
  return g;
}

// Segment geometry that spans from origin to +Y*len.
function limbGeo(r0, r1, len, seg = 14) {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 3);
  g.translate(0, len / 2, 0);
  return g;
}

// Orient an object so its +Y spans a->b and its +Z points to the bend side.
const _m = new THREE.Matrix4();
const _x = V(), _y = V(), _z = V();
function placeSegment(obj, a, b, bend) {
  _y.subVectors(b, a).normalize();
  _z.copy(bend).addScaledVector(_y, -bend.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _z.normalize();
  _x.crossVectors(_y, _z).normalize();
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(a);
}

// Two bone IK. Returns the middle joint position into `out`.
function solveIK(a, t, l1, l2, pole, out) {
  const d = V().subVectors(t, a);
  let dist = d.length();
  const maxD = (l1 + l2) * 0.999;
  if (dist > maxD) {
    d.multiplyScalar(maxD / dist);
    t = V().addVectors(a, d);
    dist = maxD;
  }
  dist = Math.max(dist, Math.abs(l1 - l2) + 0.01);
  const dir = d.normalize();
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const b = V().copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (b.lengthSq() < 1e-6) b.set(1, 0, 0);
  b.normalize();
  out.copy(a).addScaledVector(dir, l1 * cosA).addScaledVector(b, l1 * sinA);
  return t;
}

// Verlet strand (ponytail, scarf) simulated in world space.
class Strand {
  constructor(count, segLen, stiff = 0.12) {
    this.n = count;
    this.len = segLen;
    this.stiff = stiff;
    this.p = Array.from({ length: count }, () => V());
    this.o = Array.from({ length: count }, () => V());
    this.init = false;
  }
  reset(anchor, dir) {
    for (let i = 0; i < this.n; i++) {
      this.p[i].copy(anchor).addScaledVector(dir, i * this.len);
      this.o[i].copy(this.p[i]);
    }
    this.init = true;
  }
  update(dt, anchor, restDir, gravity = 9.8, wind = null) {
    if (!this.init) this.reset(anchor, restDir);
    const dt2 = Math.min(dt, 1 / 30);
    this.p[0].copy(anchor);
    this.o[0].copy(anchor);
    for (let i = 1; i < this.n; i++) {
      const p = this.p[i], o = this.o[i];
      const vx = (p.x - o.x) * 0.96, vy = (p.y - o.y) * 0.96, vz = (p.z - o.z) * 0.96;
      o.copy(p);
      p.x += vx;
      p.y += vy - gravity * dt2 * dt2;
      p.z += vz;
      if (wind) p.addScaledVector(wind, dt2 * dt2);
      // stiffness toward rest direction
      _t.copy(this.p[i - 1]).addScaledVector(restDir, this.len);
      p.lerp(_t, this.stiff * (1 - i / (this.n + 2)));
    }
    for (let k = 0; k < 3; k++) {
      for (let i = 1; i < this.n; i++) {
        const a = this.p[i - 1], b = this.p[i];
        _t.subVectors(b, a);
        const l = _t.length() || 1e-4;
        b.copy(a).addScaledVector(_t, this.len / l);
      }
    }
  }
}
const _t = V();
const _q = new THREE.Quaternion();

export class Character {
  constructor(def) {
    this.def = def;
    const L = def.look;
    this.root = new THREE.Group();
    this.root.name = 'rider';
    this.extras = new THREE.Group(); // world-space attachments (scarf, ponytail)
    this.meshes = [];

    const M = (this.mats = {
      jacket: fabric(L.jacket, { weave: 'nylon', repeat: [1, 2], bump: 0.45, sheen: 0.35 }),
      jacket2: fabric(L.jacket2, { weave: 'nylon', repeat: [1, 1], bump: 0.4, sheen: 0.35 }),
      sleeve: fabric(L.jacket, { weave: 'nylon', repeat: [1, 1], bump: 0.55, sheen: 0.35 }),
      accent: fabric(L.accent, { sheen: 0.4, roughness: 0.5 }),
      pants: fabric(L.pants, { roughness: 0.82, weave: 'pants', repeat: [1, 1], bump: 0.45 }),
      boots: rimPatch(new THREE.MeshPhysicalMaterial({ color: L.boots, roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.4 }), 0.1),
      gloves: fabric(L.gloves, { roughness: 0.6, weave: 'nylon', repeat: [1, 1], bump: 0.5 }),
      gaiter: fabric(L.gaiter, { roughness: 0.9, weave: 'knit', repeat: [3, 1], bump: 0.5 }),
      knit: fabric(L.jacket2, { roughness: 0.95, weave: 'knit', repeat: [4, 1], bump: 0.9 }),
      skin: rimPatch(new THREE.MeshPhysicalMaterial({ color: L.skin, roughness: 0.48, sheen: 0.5, sheenRoughness: 0.35, sheenColor: new THREE.Color(0xff9a80) }), 0.06, 0xffc0a0),
      lip: new THREE.MeshPhysicalMaterial({ color: new THREE.Color(L.skin).lerp(new THREE.Color(0xb04a4a), 0.45), roughness: 0.35, sheen: 0.4, sheenColor: new THREE.Color(0xffa0a0) }),
      helmet: rimPatch(new THREE.MeshPhysicalMaterial({ color: L.helmet, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06 }), 0.1),
      frame: new THREE.MeshStandardMaterial({ color: L.goggleFrame, roughness: 0.45 }),
      foam: new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.95 }),
      lens: new THREE.MeshPhysicalMaterial({
        color: L.lens, metalness: 0.7, roughness: 0.04, iridescence: 1, iridescenceIOR: 1.8,
        iridescenceThicknessRange: [200, 800], envMapIntensity: 2.6, clearcoat: 1,
        emissive: new THREE.Color(L.lens).multiplyScalar(0.18),
      }),
      strap: fabric(L.accent, { sheen: 0.2, roughness: 0.6, weave: 'knit', repeat: [12, 1], bump: 0.3 }),
      hair: rimPatch(new THREE.MeshPhysicalMaterial({ color: L.hairColor, roughness: 0.45, sheen: 1, sheenRoughness: 0.3, sheenColor: new THREE.Color(L.hairColor).lerp(new THREE.Color(0xffffff), 0.3) }), 0.1),
      dark: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.6 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.85 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xb5bcc6, metalness: 1, roughness: 0.25 }),
      binding: new THREE.MeshPhysicalMaterial({ color: 0x1a1b1f, roughness: 0.35, metalness: 0.2, clearcoat: 0.6 }),
      bindingAcc: new THREE.MeshStandardMaterial({ color: L.accent, roughness: 0.35 }),
      scarf: fabric(L.scarfColor ?? 0xe0262f, { roughness: 0.9, weave: 'knit', repeat: [1, 6], bump: 0.6 }),
    });
    M.scarf.side = THREE.DoubleSide;

    this._buildBoard(L);
    this._buildBody(L);

    // pose state (smoothed)
    this.p = {
      hipH: 0.86, hipX: 0.02, hipZ: 0, lean: -0.15, side: 0, twist: 0.4, headYaw: 1.0, headPitch: 0.1,
      lh: V(0.15, 0.95, -0.6), rh: V(0.0, 0.85, 0.5),
      boardPitch: 0, boardRoll: 0, boardLift: 0, armSpread: 0,
    };
    this.target = { ...this.p, lh: this.p.lh.clone(), rh: this.p.rh.clone() };
    this.lhv = V();
    this.rhv = V();
    this.absorb = 0;
    this.absorbV = 0;
    this.time = 0;
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  // ------------------------------------------------------------------ board
  _buildBoard(L) {
    const g = new THREE.Group();
    this.board = g;
    this.root.add(g);
    const len = 1.56, half = len / 2;
    const s = new THREE.Shape();
    const wN = 0.148, wW = 0.124; // half widths at tip and waist
    s.moveTo(-wN, -half + 0.16);
    s.quadraticCurveTo(-wW, 0, -wN, half - 0.16);
    s.bezierCurveTo(-wN, half - 0.02, -0.07, half, 0, half);
    s.bezierCurveTo(0.07, half, wN, half - 0.02, wN, half - 0.16);
    s.quadraticCurveTo(wW, 0, wN, -half + 0.16);
    s.bezierCurveTo(wN, -half + 0.02, 0.07, -half, 0, -half);
    s.bezierCurveTo(-0.07, -half, -wN, -half + 0.02, -wN, -half + 0.16);
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 18 });
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const az = Math.abs(z);
      if (az > 0.58) pos.setY(i, pos.getY(i) + Math.pow(az - 0.58, 2) * 1.5);
      // slight camber
      pos.setY(i, pos.getY(i) + 0.006 * Math.cos((z / half) * Math.PI * 0.5));
      uv.setXY(i, (x + 0.16) / 0.32, 1 - (z + half) / len);
    }
    geo.computeVertexNormals();
    const top = new THREE.MeshPhysicalMaterial({ map: boardTexture(L.board.colors, L.board.label, L.board.pattern), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.3 });
    const board = new THREE.Mesh(geo, [top, edge]);
    board.position.y = 0.002;
    g.add(board);
    // base (colored) slightly below
    const baseGeo = geo.clone();
    const base = new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({ color: L.board.base, roughness: 0.35 }));
    base.position.y = -0.004;
    base.scale.set(0.995, 1, 0.995);
    g.add(base);

    // bindings
    this.feet = [];
    const stance = 0.27;
    for (const [z, ang] of [[-stance, 0.26], [stance, -0.1]]) {
      const b = new THREE.Group();
      b.position.set(0, 0.016, z);
      b.rotation.y = ang;
      g.add(b);
      const M = this.mats;
      // baseplate + heel cup
      const plate = new THREE.Mesh(new RoundedBoxGeometry(0.29, 0.024, 0.135, 2, 0.01), M.binding);
      plate.position.y = 0.012;
      b.add(plate);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.01, 24), M.metal);
      disc.position.y = 0.027;
      b.add(disc);
      for (const zz of [-0.04, 0.04]) for (const xx of [-0.035, 0.035]) {
        const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.006, 8), M.dark);
        screw.position.set(xx, 0.033, zz);
        b.add(screw);
      }
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.07, 16, 1, true, Math.PI * 1.05, Math.PI * 0.9), M.binding);
      cup.material.side = THREE.DoubleSide;
      cup.position.set(-0.065, 0.06, 0);
      b.add(cup);
      // highback: tall curved shell behind the calf, leaning forward
      const hb = new THREE.Mesh(profileGeo([[0, 0.08, 0.075], [0.12, 0.078, 0.07], [0.24, 0.074, 0.066], [0.3, 0.066, 0.06]], 16), M.binding);
      hb.material.side = THREE.DoubleSide;
      // keep only the back half of the tube
      const hbIdx = hb.geometry.index.array, keep = [];
      const hp = hb.geometry.attributes.position;
      for (let i = 0; i < hbIdx.length; i += 3) {
        const cx = (hp.getX(hbIdx[i]) + hp.getX(hbIdx[i + 1]) + hp.getX(hbIdx[i + 2])) / 3;
        if (cx < -0.02) keep.push(hbIdx[i], hbIdx[i + 1], hbIdx[i + 2]);
      }
      hb.geometry.setIndex(keep);
      hb.position.set(-0.03, 0.05, 0);
      hb.rotation.z = -0.22;
      b.add(hb);
      // boot
      const boot = new THREE.Group();
      boot.position.set(0.015, 0.03, 0);
      b.add(boot);
      const sole = new THREE.Mesh(new RoundedBoxGeometry(0.33, 0.035, 0.15, 2, 0.015), M.rubber);
      sole.position.set(0.005, 0.017, 0);
      boot.add(sole);
      const upper = new THREE.Mesh(bootGeo(), M.boots);
      upper.position.y = 0.025;
      boot.add(upper);
      // lace panel and BOA dial
      const lace = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.012, 0.07, 1, 0.005), M.dark);
      lace.position.set(0.075, 0.155, 0);
      lace.rotation.z = -0.55;
      boot.add(lace);
      for (const zz of [-0.08, 0.08]) {
        const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.016, 16).rotateX(Math.PI / 2), M.bindingAcc);
        dial.position.set(-0.04, 0.2, zz);
        boot.add(dial);
      }
      // ankle strap (padded) and toe cap strap with ratchets
      const ankle = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.024, 8, 20, Math.PI * 1.15), M.binding);
      ankle.position.set(0.0, 0.135, 0);
      ankle.rotation.set(0, Math.PI / 2, -0.75);
      ankle.rotation.order = 'YZX';
      ankle.scale.set(1, 1, 1.6);
      boot.add(ankle);
      const toe = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 18, Math.PI * 1.1), M.bindingAcc);
      toe.position.set(0.13, 0.055, 0);
      toe.rotation.set(0, Math.PI / 2, 0.35);
      toe.rotation.order = 'YZX';
      boot.add(toe);
      for (const zz of [-0.085, 0.085]) {
        const ratchet = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.025, 0.018, 1, 0.006), M.metal);
        ratchet.position.set(-0.01, 0.12, zz);
        boot.add(ratchet);
      }
      this.feet.push({ group: b, ankle: V(-0.03, 0.27, 0) });
    }
  }

  // ------------------------------------------------------------------ body
  _buildBody(L) {
    const M = this.mats;
    const add = (parent, geo, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    this.thigh = 0.45;
    this.shin = 0.45;
    this.upperArm = 0.29;
    this.foreArm = 0.27;

    // ---------------------------------------------------------------- pelvis / torso
    this.pelvis = new THREE.Group();
    this.root.add(this.pelvis);
    add(this.pelvis, new THREE.SphereGeometry(0.19, 24, 16).scale(0.86, 0.78, 1.12), M.pants, 0, -0.01, 0);
    this.spine = new THREE.Group();
    this.spine.position.y = 0.08;
    this.pelvis.add(this.spine);
    this.chest = new THREE.Group();
    this.chest.position.y = 0.15;
    this.spine.add(this.chest);

    // long, loose snowboard shell jacket; elliptical cross-section
    const D = 0.8;
    const lower = [
      [0.0, -0.4], [0.25, -0.4], [0.262, -0.375], [0.255, -0.28], [0.238, -0.16], [0.222, -0.04], [0.23, 0.06], [0.244, 0.14], [0.246, 0.17],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const upper = [
      [0.246, 0.13], [0.248, 0.2], [0.24, 0.255], [0.215, 0.305], [0.16, 0.35], [0.1, 0.378], [0.0, 0.385],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    add(this.chest, new THREE.LatheGeometry(lower, 36), M.jacket).scale.set(D, 1, 1);
    add(this.chest, new THREE.LatheGeometry(upper, 36), M.jacket2).scale.set(D * 1.01, 1, 1);
    // hem with drawcord and toggles
    const hem = add(this.chest, new THREE.TorusGeometry(0.256, 0.016, 8, 36), M.jacket2, 0, -0.388, 0);
    hem.rotation.x = Math.PI / 2;
    hem.scale.set(D, 1, 1);
    for (const z of [-0.16, 0.16]) {
      add(this.chest, new THREE.CylinderGeometry(0.004, 0.004, 0.07, 4), M.accent, 0.19, -0.43, z);
      add(this.chest, new THREE.CapsuleGeometry(0.008, 0.012, 3, 6), M.dark, 0.19, -0.47, z);
    }
    // yoke seam and accent piping
    const pipe = add(this.chest, new THREE.TorusGeometry(0.247, 0.006, 6, 36), M.accent, 0, 0.135, 0);
    pipe.rotation.x = Math.PI / 2;
    pipe.scale.set(D * 1.01, 1, 1);
    // storm flap + zipper with pull tab, running into a tall collar
    add(this.chest, new RoundedBoxGeometry(0.012, 0.78, 0.045, 1, 0.005), M.jacket2, 0.197, -0.01, 0.0).rotation.z = 0.035;
    add(this.chest, new THREE.BoxGeometry(0.006, 0.76, 0.008), M.dark, 0.205, -0.01, 0.02).rotation.z = 0.035;
    add(this.chest, new RoundedBoxGeometry(0.008, 0.035, 0.014, 1, 0.003), M.metal, 0.212, 0.3, 0.025);
    const collar = add(this.chest, profileGeo([[0, 0.108, 0.102], [0.05, 0.1, 0.096], [0.1, 0.1, 0.096]], 22), M.jacket2, 0, 0.35, 0);
    collar.material.side = THREE.DoubleSide;
    // chest and hand-warmer pockets, sleeve logo, powder-skirt hint
    for (const z of [-0.13, 0.13]) {
      // slanted zipped hand-warmer pockets
      const zp = add(this.chest, new THREE.BoxGeometry(0.004, 0.16, 0.005), M.dark, 0.188, -0.2, z);
      zp.rotation.x = z > 0 ? 0.45 : -0.45;
    }
    add(this.chest, new RoundedBoxGeometry(0.02, 0.07, 0.08, 2, 0.01), M.jacket2, 0.19, 0.2, -0.11);
    add(this.chest, new RoundedBoxGeometry(0.008, 0.02, 0.05, 1, 0.003), M.accent, 0.2, 0.22, -0.11);
    // hood: a soft shell slumped on the back (unless worn on the head)
    if (L.headwear !== 'hood') {
      const hood = add(this.chest, new THREE.SphereGeometry(0.14, 20, 12, -Math.PI * 0.5, Math.PI, Math.PI * 0.12, Math.PI * 0.62), M.jacket2, -0.1, 0.34, 0);
      hood.scale.set(0.95, 0.75, 1.12);
      hood.rotation.z = 0.35;
      hood.material.side = THREE.DoubleSide;
    }
    if (L.backpack) {
      const bp = add(this.chest, new RoundedBoxGeometry(0.14, 0.42, 0.3, 4, 0.06), M.jacket2, -0.255, 0.04, 0);
      add(bp, new RoundedBoxGeometry(0.05, 0.18, 0.22, 3, 0.02), M.accent, -0.07, -0.08, 0);
      add(bp, new RoundedBoxGeometry(0.02, 0.05, 0.12, 1, 0.008), M.dark, -0.09, 0.12, 0);
      for (const z of [-0.1, 0.1]) {
        const strap = add(this.chest, new THREE.TorusGeometry(0.2, 0.012, 6, 20, Math.PI * 0.9), M.dark, -0.03, 0.12, z);
        strap.scale.set(0.95, 1.1, 0.4);
        strap.rotation.z = Math.PI * 0.55;
        // sternum strap clip
      }
      add(this.chest, new THREE.BoxGeometry(0.01, 0.015, 0.18), M.dark, 0.205, 0.15, 0);
    }

    // ---------------------------------------------------------------- neck & head (face is +X)
    this.neck = new THREE.Group();
    this.neck.position.y = 0.37;
    this.chest.add(this.neck);
    // neck gaiter with bunched folds
    add(this.neck, profileGeo([[-0.05, 0.088, 0.084], [0.02, 0.074, 0.072], [0.07, 0.07, 0.068], [0.1, 0.066, 0.064]], 20), M.gaiter, 0, 0, 0);
    for (const y of [-0.01, 0.035]) {
      const f = add(this.neck, new THREE.TorusGeometry(0.08, 0.01, 6, 20), M.gaiter, 0, y, 0);
      f.rotation.x = Math.PI / 2;
    }
    this.head = new THREE.Group();
    this.head.position.y = 0.16;
    this.head.scale.setScalar(0.93);
    this.neck.add(this.head);
    const H = this.head;
    // skull, jaw and nose
    add(H, new THREE.SphereGeometry(0.1, 28, 20).scale(1.02, 1.1, 0.88), M.skin, 0, 0.012, 0);
    add(H, new THREE.SphereGeometry(0.07, 18, 12).scale(1.0, 0.85, 1.05), M.skin, 0.035, -0.06, 0);
    const nose = add(H, new THREE.CapsuleGeometry(0.013, 0.028, 4, 8), M.skin, 0.1, -0.012, 0);
    nose.rotation.z = 0.35;
    for (const z of [-1, 1]) {
      // cheekbones peeking between goggles and gaiter
      add(H, new THREE.SphereGeometry(0.03, 10, 8).scale(0.7, 0.7, 1), M.skin, 0.078, -0.02, z * 0.045);
      add(H, new THREE.SphereGeometry(0.026, 8, 6).scale(0.5, 1, 0.45), M.skin, -0.005, -0.005, z * 0.095);
    }
    if (L.mask) {
      // gaiter pulled up over mouth and chin, just under the nose
      const gm = add(H, new THREE.SphereGeometry(0.113, 26, 14, 0, Math.PI * 2, Math.PI * 0.56, Math.PI * 0.44), M.gaiter, 0.008, 0.0, 0);
      gm.scale.set(1.04, 1.12, 0.98);
    } else {
      // lower face: lips, mouth corners, chin and jawline
      const lipMat = M.lip;
      const ul = add(H, new THREE.CapsuleGeometry(0.009, 0.03, 4, 8), lipMat, 0.098, -0.052, 0);
      ul.rotation.x = Math.PI / 2;
      ul.scale.set(0.8, 1, 0.75);
      const ll = add(H, new THREE.CapsuleGeometry(0.0095, 0.026, 4, 8), lipMat, 0.094, -0.066, 0);
      ll.rotation.x = Math.PI / 2;
      ll.scale.set(0.85, 1, 0.8);
      add(H, new THREE.SphereGeometry(0.028, 12, 10).scale(0.8, 0.75, 1.05), M.skin, 0.088, -0.092, 0);
      for (const z of [-1, 1]) {
        add(H, new THREE.SphereGeometry(0.04, 12, 10).scale(0.9, 1.0, 0.8), M.skin, 0.06, -0.06, z * 0.04);
        // nostrils / nose wings
        add(H, new THREE.SphereGeometry(0.009, 8, 6), M.skin, 0.104, -0.026, z * 0.011);
      }
      // the gaiter sits pulled down around the neck
      // neck below the jaw
      add(H, profileGeo([[-0.17, 0.058, 0.056], [-0.1, 0.055, 0.054]], 16), M.skin, 0.0, 0, 0);
    }

    // hair
    if (L.hair === 'short') {
      add(H, new THREE.SphereGeometry(0.108, 18, 10, -Math.PI * 0.45, Math.PI * 0.9, Math.PI * 0.35, Math.PI * 0.32), M.hair, -0.006, 0.0, 0);
    }
    if (L.hair === 'ponytail') {
      add(H, new THREE.SphereGeometry(0.112, 18, 12, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.3, Math.PI * 0.42), M.hair, -0.01, 0, 0);
      // fringe peeking out under the beanie at the temples
      for (const z of [-1, 1]) {
        const lock = add(H, new THREE.SphereGeometry(0.035, 12, 10).scale(0.7, 1.2, 0.45), M.hair, 0.055, -0.0, z * 0.092);
        lock.rotation.x = z * 0.2;
      }
      this.pony = new Strand(7, 0.062, 0.05);
      this.ponyMeshes = [];
      for (let i = 0; i < 7; i++) {
        const r = 0.04 - i * 0.0045;
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, 0.05, 4, 10).scale(1, 1, 0.8), M.hair);
        m.castShadow = true;
        this.extras.add(m);
        this.ponyMeshes.push(m);
      }
      add(H, new THREE.TorusGeometry(0.028, 0.01, 6, 12), M.accent, -0.122, 0.055, 0).rotation.y = Math.PI / 2;
    }

    // headwear
    if (L.headwear === 'helmet') {
      // shell from a lathed profile, with a small visor, vents, ear pads and chin strap
      const prof = [[0.0, 0.158], [0.06, 0.152], [0.1, 0.133], [0.128, 0.098], [0.142, 0.052], [0.146, 0.01], [0.144, -0.022], [0.138, -0.03]]
        .map(([r, y]) => new THREE.Vector2(r, y));
      const hel = add(H, new THREE.LatheGeometry(prof, 36), M.helmet, -0.01, 0.006, 0);
      hel.scale.set(1.06, 1.0, 0.97);
      hel.material.side = THREE.DoubleSide;
      const brim = add(H, new THREE.CylinderGeometry(0.152, 0.158, 0.012, 24, 1, true, Math.PI * 0.18, Math.PI * 0.64), M.helmet, -0.006, 0.085, 0);
      brim.scale.set(1.05, 1, 0.98);
      brim.rotation.z = -0.12;
      for (let i = -2; i <= 2; i++) {
        const v = add(H, new RoundedBoxGeometry(0.075, 0.014, 0.014, 1, 0.005), M.dark, -0.01 - Math.abs(i) * 0.006, 0.155 - Math.abs(i) * 0.006, i * 0.034);
        v.rotation.x = i * 0.22;
      }
      const rimT = add(H, new THREE.TorusGeometry(0.14, 0.008, 6, 36), M.dark, -0.012, -0.026, 0);
      rimT.rotation.x = Math.PI / 2;
      rimT.scale.set(1.06, 0.97, 1);
    } else if (L.headwear === 'beanie') {
      const bn = add(H, new THREE.SphereGeometry(0.121, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), M.knit, -0.006, 0.022, 0);
      bn.scale.set(1.02, 1.14, 0.98);
      // rolled rib cuff
      const cuff = add(H, profileGeo([[0, 0.128, 0.122], [0.03, 0.13, 0.124], [0.055, 0.127, 0.121]], 30), M.strap, -0.006, 0.0, 0);
      cuff.scale.set(1.03, 1, 1);
      const pom = new THREE.SphereGeometry(0.05, 32, 24);
      const pp = pom.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
        const k = 1 + 0.06 * Math.sin(x * 160) * Math.sin(y * 170) * Math.sin(z * 150) + 0.03 * Math.sin((x + y + z) * 300);
        pp.setXYZ(i, x * k, y * k, z * k);
      }
      pom.computeVertexNormals();
      add(H, pom, M.accent, -0.025, 0.17, 0);
    } else if (L.headwear === 'hood') {
      // beanie under a cinched hood
      add(H, new THREE.SphereGeometry(0.118, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5), M.knit, -0.006, 0.025, 0).scale.set(1.02, 1.1, 0.98);
      const hood = add(H, new THREE.SphereGeometry(0.158, 28, 18, Math.PI * 1.25, Math.PI * 1.5, 0, Math.PI * 0.72), M.jacket.clone(), -0.035, 0.012, 0);
      hood.material.side = THREE.DoubleSide;
      hood.material.onBeforeCompile = M.jacket.onBeforeCompile;
      hood.scale.set(1.0, 1.1, 1.0);
      for (const z of [-0.05, 0.05]) add(H, new THREE.CylinderGeometry(0.004, 0.004, 0.08, 4), M.accent, 0.12, -0.08, z);
    }

    // goggles: foam + frame band, spherical iridescent lens, patterned strap
    const gy = 0.04;
    const band = (r, h, a, mat) => {
      const m = add(H, new THREE.CylinderGeometry(r, r, h, 32, 1, true, Math.PI * (0.5 - a), Math.PI * 2 * a), mat, -0.004, gy, 0);
      m.material.side = THREE.DoubleSide;
      m.scale.set(1.0, 1, 1.06);
      return m;
    };
    band(0.122, 0.068, 0.3, M.foam);
    band(0.131, 0.08, 0.31, M.frame);
    const lens = add(H, new THREE.SphereGeometry(0.15, 32, 12, Math.PI * 0.7, Math.PI * 0.6, Math.PI * 0.385, Math.PI * 0.23), M.lens, -0.008, gy, 0);
    lens.scale.set(1.0, 1.02, 1.0);
    const strapR = L.headwear === 'hood' ? 0.16 : L.headwear === 'beanie' ? 0.13 : 0.148;
    const strap = add(H, new THREE.CylinderGeometry(strapR, strapR, 0.036, 32, 1, true, Math.PI * 0.82, Math.PI * 1.36), M.strap, -0.01, gy + 0.004, 0);
    strap.material.side = THREE.DoubleSide;
    strap.scale.set(1.03, 1, 1.0);

    // ---------------------------------------------------------------- limbs (placed in root space every frame)
    const limb = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      this.root.add(m);
      return m;
    };
    // baggy pants: wide thighs, articulated knees, flared cuffs over the boots
    const thighGeo = profileGeo([[-0.04, 0.135, 0.14], [0.06, 0.13, 0.138, 0.005], [0.18, 0.122, 0.128, 0.008], [0.3, 0.114, 0.118, 0.006], [0.4, 0.106, 0.11, 0.004], [0.47, 0.102, 0.106]], 22);
    const shinGeo = profileGeo([[-0.02, 0.104, 0.112, 0.008], [0.08, 0.1, 0.106, 0.004], [0.2, 0.1, 0.102, -0.004], [0.31, 0.104, 0.106, -0.006], [0.39, 0.11, 0.112, -0.004], [0.45, 0.118, 0.122], [0.48, 0.12, 0.124]], 22);
    this.legs = [0, 1].map((i) => {
      const side = i === 0 ? -1 : 1;
      const leg = {
        thigh: limb(thighGeo, M.pants),
        shin: limb(shinGeo, M.pants),
        knee: limb(new THREE.SphereGeometry(0.108, 18, 12).scale(1, 0.9, 1.05), M.pants),
      };
      // cargo pocket on the outside of the thigh and a knee dart
      const pocket = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.14, 0.1, 2, 0.012), M.pants);
      pocket.position.set(side * 0.118, 0.26, 0);
      leg.thigh.add(pocket);
      const flap = new THREE.Mesh(new RoundedBoxGeometry(0.034, 0.03, 0.104, 1, 0.008), M.pants);
      flap.position.set(side * 0.12, 0.33, 0);
      leg.thigh.add(flap);
      const dart = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.006, 5, 16, Math.PI * 0.8), M.pants);
      dart.rotation.set(Math.PI / 2, 0, Math.PI * 0.1);
      dart.position.set(0, 0.05, 0.0);
      leg.shin.add(dart);
      return leg;
    });
    const upperGeo = profileGeo([[-0.03, 0.084, 0.082], [0.08, 0.081, 0.08], [0.18, 0.076, 0.074], [0.29, 0.07, 0.07]], 18);
    const foreGeo = profileGeo([[-0.01, 0.071, 0.071], [0.1, 0.068, 0.066], [0.19, 0.064, 0.062], [0.25, 0.07, 0.068], [0.28, 0.074, 0.072]], 18);
    this.arms = [0, 1].map(() => {
      const a = {
        upper: limb(upperGeo, M.sleeve),
        fore: limb(foreGeo, M.sleeve),
        elbow: limb(new THREE.SphereGeometry(0.072, 14, 10), M.sleeve),
        shoulder: limb(new THREE.SphereGeometry(0.085, 18, 14), M.sleeve),
        hand: new THREE.Group(),
      };
      this.root.add(a.hand);
      this._glove(a.hand);
      return a;
    });

    // scarf
    if (L.scarf) {
      this.scarf = new Strand(10, 0.08, 0.03);
      const segs = this.scarf.n;
      const geo = new THREE.BufferGeometry();
      this.scarfPos = new Float32Array(segs * 2 * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(this.scarfPos, 3));
      const uvs = new Float32Array(segs * 2 * 2);
      for (let i = 0; i < segs; i++) uvs.set([0, i / (segs - 1), 1, i / (segs - 1)], i * 4);
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      const idx = [];
      for (let i = 0; i < segs - 1; i++) { const q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
      geo.setIndex(idx);
      this.scarfGeo = geo;
      const sm = new THREE.Mesh(geo, M.scarf);
      sm.frustumCulled = false;
      sm.castShadow = true;
      this.extras.add(sm);
      add(this.neck, new THREE.TorusGeometry(0.09, 0.034, 10, 24), M.scarf, 0, 0.02, 0).rotation.x = Math.PI / 2;
    }

    // soft contact shadow on the snow under the board
    const sm = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: glowTexture(), transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), sm);
    this.blob.renderOrder = 1;
    this.blob.scale.set(0.9, 1, 1.9);
    this.extras.add(this.blob);
  }

  // Five-finger glove with a gauntlet cuff. Group +Y points along the forearm.
  _glove(hand) {
    const M = this.mats;
    const cuff = new THREE.Mesh(profileGeo([[-0.07, 0.082, 0.08], [-0.01, 0.08, 0.078], [0.04, 0.068, 0.064], [0.06, 0.058, 0.048]], 18), M.gloves);
    hand.add(cuff);
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.081, 0.008, 6, 20), M.dark);
    strap.rotation.x = Math.PI / 2;
    strap.position.y = -0.035;
    hand.add(strap);
    const palm = new THREE.Mesh(new RoundedBoxGeometry(0.105, 0.105, 0.062, 4, 0.028), M.gloves);
    palm.position.set(0, 0.1, 0.004);
    hand.add(palm);
    // insulated fingers, curled toward the palm (+Z)
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      g.position.set(-0.036 + i * 0.024, 0.145, 0.01);
      g.rotation.x = 0.35;
      hand.add(g);
      const r = 0.0155 - Math.abs(i - 1.5) * 0.0012;
      const l1 = 0.032 - Math.abs(i - 1.3) * 0.004;
      const p1 = new THREE.Mesh(new THREE.CapsuleGeometry(r, l1, 4, 8), M.gloves);
      p1.position.y = l1 / 2 + r * 0.5;
      g.add(p1);
      const g2 = new THREE.Group();
      g2.position.y = l1 + r * 0.6;
      g2.rotation.x = 0.7;
      g.add(g2);
      const p2 = new THREE.Mesh(new THREE.CapsuleGeometry(r * 0.95, l1 * 0.75, 4, 8), M.gloves);
      p2.position.y = l1 * 0.38;
      g2.add(p2);
    }
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.04, 4, 8), M.gloves);
    thumb.position.set(0.054, 0.095, 0.03);
    thumb.rotation.set(0.6, 0, -0.65);
    hand.add(thumb);
  }

  // ------------------------------------------------------------------ posing
  setPose(name, opts = {}) {
    const t = this.target;
    const st = opts.stance ?? 1; // could mirror for goofy in the future
    void st;
    // defaults: riding
    Object.assign(t, {
      hipH: 0.8, hipX: 0.04, hipZ: 0, lean: -0.22, side: 0, twist: 0.45, headYaw: 1.05, headPitch: 0.12,
      boardPitch: 0, boardRoll: 0, boardLift: 0, armSpread: 0,
    });
    t.lh.set(0.22, 0.98, -0.58);
    t.rh.set(0.02, 0.86, 0.52);
    const carve = opts.carve || 0; // -1 heel ... +1 toe
    const tuck = opts.tuck || 0;
    switch (name) {
      case 'idle':
        Object.assign(t, { hipH: 0.84, lean: -0.1, twist: 0.3, headYaw: 0.55, headPitch: 0.0 });
        t.lh.set(0.24, 0.8, -0.32);
        t.rh.set(0.14, 0.78, 0.33);
        break;
      case 'ride':
        t.hipX += carve * 0.11;
        t.hipH -= Math.abs(carve) * 0.08 + tuck * 0.18;
        t.lean += carve * -0.2 - tuck * 0.35 + (carve < 0 ? -carve * 0.12 : 0);
        t.side = carve * 0.1;
        t.headYaw += carve * 0.22; // look into the turn
        t.lh.set(0.3 + carve * 0.12, 0.9 - tuck * 0.25 + (carve < 0 ? -0.1 : 0), -0.62);
        t.rh.set(0.06 + carve * 0.18, 0.78 - tuck * 0.2, 0.48);
        if (opts.brake) {
          Object.assign(t, { hipH: 0.72, hipX: -0.12, lean: 0.12, twist: 0.15, headYaw: 0.8 });
          t.lh.set(0.35, 0.9, -0.5);
          t.rh.set(0.3, 0.85, 0.4);
        }
        break;
      case 'crouch':
        Object.assign(t, { hipH: 0.6, hipX: 0.1, lean: -0.55, twist: 0.35 });
        t.lh.set(0.35, 0.55, -0.45);
        t.rh.set(0.15, 0.5, 0.35);
        break;
      case 'pop':
        Object.assign(t, { hipH: 0.92, lean: -0.1, twist: 0.4 });
        t.lh.set(0.25, 1.25, -0.6);
        t.rh.set(-0.05, 1.15, 0.6);
        break;
      case 'air':
        Object.assign(t, { hipH: 0.76, hipX: 0.04, lean: -0.25, twist: 0.4, headPitch: 0.25 });
        t.lh.set(0.18, 1.0, -0.72);
        t.rh.set(-0.02, 0.95, 0.72);
        break;
      case 'spin': {
        const d = opts.dir || 1;
        Object.assign(t, { hipH: 0.72, lean: -0.3, twist: 0.4 + d * 0.5, headYaw: 1.0 + d * 0.5, headPitch: 0.3 });
        t.lh.set(0.35, 0.85, -0.35 + d * 0.2);
        t.rh.set(0.3, 0.8, 0.35 + d * 0.2);
        break;
      }
      case 'flip':
        Object.assign(t, { hipH: 0.6, lean: -0.6, twist: 0.2, headPitch: 0.6 });
        t.lh.set(0.35, 0.6, -0.25);
        t.rh.set(0.35, 0.6, 0.25);
        break;
      case 'indy':
        Object.assign(t, { hipH: 0.5, hipX: 0.08, lean: -0.72, twist: 0.25, headPitch: 0.35, boardLift: 0.12 });
        t.rh.set(0.15, 0.08, 0.04);
        t.lh.set(0.3, 1.15, -0.7);
        break;
      case 'method':
        Object.assign(t, { hipH: 0.55, hipX: -0.04, lean: 0.25, twist: -0.1, headYaw: 1.3, headPitch: 0.1, boardRoll: 0.65, boardLift: 0.25 });
        t.lh.set(-0.15, 0.06, -0.08);
        t.rh.set(0.05, 1.35, 0.55);
        break;
      case 'nose':
        Object.assign(t, { hipH: 0.55, hipX: 0.06, hipZ: -0.08, lean: -0.55, twist: 0.65, side: -0.25, boardPitch: 0.35, boardLift: 0.1 });
        t.lh.set(0.02, 0.1, -0.7);
        t.rh.set(-0.05, 1.2, 0.6);
        break;
      case 'tail':
        Object.assign(t, { hipH: 0.55, hipX: 0.06, hipZ: 0.08, lean: -0.5, twist: 0.1, side: 0.25, boardPitch: -0.35, boardLift: 0.1 });
        t.rh.set(0.02, 0.1, 0.7);
        t.lh.set(0.25, 1.2, -0.7);
        break;
      case 'grind':
        Object.assign(t, { hipH: 0.78, lean: -0.2, twist: 0.35, headPitch: 0.2 });
        t.lh.set(0.2, 1.05, -0.75);
        t.rh.set(0.0, 1.0, 0.75);
        break;
      case 'crash':
        Object.assign(t, { hipH: 0.68, lean: -0.4, twist: 0.8, headPitch: 0.5 });
        t.lh.set(0.4, 1.4, -0.6);
        t.rh.set(-0.3, 1.3, 0.7);
        break;
      case 'celebrate':
        Object.assign(t, { hipH: 0.88, lean: 0.05, twist: 0.6, headYaw: 0.9, headPitch: -0.1 });
        t.lh.set(0.15, 1.65, -0.35);
        t.rh.set(0.15, 1.65, 0.35);
        break;
      default:
        break;
    }
  }

  // Snap the current pose to the target (on respawn / menu).
  snap() {
    this.lhv?.set(0, 0, 0);
    this.rhv?.set(0, 0, 0);
    this.absorb = 0;
    this.absorbV = 0;
    for (const k in this.p) {
      if (this.p[k].isVector3) this.p[k].copy(this.target[k]);
      else this.p[k] = this.target[k];
    }
  }

  update(dt, ctx = {}) {
    this.time += dt;
    const p = this.p, t = this.target;
    const k = ctx.fast ? 16 : 10;
    for (const key of ['hipH', 'hipX', 'hipZ', 'lean', 'side', 'twist', 'headYaw', 'headPitch', 'boardPitch', 'boardRoll', 'boardLift']) {
      p[key] = damp(p[key], t[key], k, dt);
    }
    // hands follow their targets on a slightly under-damped spring (natural follow-through)
    const K = ctx.fast ? 260 : 150, C = 2 * Math.sqrt(K) * 0.72;
    const h = Math.min(dt, 1 / 30);
    for (const [pos, vel, tgt] of [[p.lh, this.lhv, t.lh], [p.rh, this.rhv, t.rh]]) {
      vel.addScaledVector(_t.subVectors(tgt, pos), K * h).multiplyScalar(Math.max(0, 1 - C * h));
      pos.addScaledVector(vel, h);
    }
    // landing absorption: knees soak up the impact and spring back
    this.absorbV += (-110 * this.absorb - 13 * this.absorbV) * h;
    this.absorb = Math.max(-0.2, Math.min(1.3, this.absorb + this.absorbV * h));
    const ab = this.absorb;

    // breathing / micro motion
    const breathe = Math.sin(this.time * 2.2) * 0.008;
    const vib = ctx.vibration || 0;
    const jitter = vib ? (Math.sin(this.time * 61) * 0.5 + Math.sin(this.time * 37) * 0.5) * vib * 0.012 : 0;

    // board tweak
    this.board.position.y = p.boardLift;
    this.board.rotation.set(p.boardPitch, 0, p.boardRoll, 'XYZ');
    this.board.updateMatrix();

    // pelvis
    this.pelvis.position.set(p.hipX + ab * 0.05, p.hipH + breathe + jitter - ab * 0.24, p.hipZ);
    this.pelvis.rotation.set(p.side, p.twist * 0.35, (p.lean - ab * 0.35) * 0.45, 'YXZ');
    this.spine.rotation.set(0, p.twist * 0.35, p.lean * 0.35, 'YXZ');
    this.chest.rotation.set(p.side * 0.5, p.twist * 0.3, p.lean * 0.3, 'YXZ');
    this.head.rotation.set(0, p.headYaw - p.twist, -p.headPitch * 0.6 - p.lean * 0.3, 'YXZ');
    this.pelvis.updateMatrix();
    this.spine.updateMatrix();
    this.chest.updateMatrix();

    const mPel = this.pelvis.matrix;
    const mChest = new THREE.Matrix4().multiplyMatrices(mPel, this.spine.matrix).multiply(this.chest.matrix);

    // legs
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i];
      const side = i === 0 ? -1 : 1; // left (-Z) is front foot
      const hip = V(0, -0.03, side * 0.11).applyMatrix4(mPel);
      const foot = this.feet[i];
      foot.group.updateMatrix();
      const ankle = foot.ankle.clone().applyMatrix4(foot.group.matrix).applyMatrix4(this.board.matrix);
      const pole = V(1, 0.1, i === 0 ? -0.35 : -0.12).normalize();
      const knee = V();
      const reach = solveIK(hip, ankle, this.thigh, this.shin, pole, knee);
      placeSegment(leg.thigh, hip, knee, pole);
      placeSegment(leg.shin, knee, reach, pole);
      leg.knee.position.copy(knee);
      leg.knee.quaternion.copy(leg.shin.quaternion);
    }

    // arms
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      const side = i === 0 ? -1 : 1;
      const sh = V(-0.005, 0.268, side * 0.2).applyMatrix4(mChest);
      const target = (i === 0 ? p.lh : p.rh).clone();
      // swing a bit, and drop the arms with the landing compression
      target.y += Math.sin(this.time * 1.7 + i) * 0.015 - ab * 0.18;
      target.x += ab * 0.06;
      const toT = V().subVectors(target, sh);
      const pole = V(-0.35, -0.6, side * 0.7).add(toT.clone().multiplyScalar(-0.2)).normalize();
      const elbow = V();
      const hand = solveIK(sh, target, this.upperArm, this.foreArm, pole, elbow);
      placeSegment(arm.upper, sh, elbow, pole);
      placeSegment(arm.fore, elbow, hand, pole);
      arm.elbow.position.copy(elbow);
      arm.shoulder.position.copy(sh);
      placeSegment(arm.hand, hand, hand.clone().add(V().subVectors(hand, elbow).normalize()), pole);
      arm.hand.position.copy(hand);
    }

    // contact shadow
    if (ctx.shadow) {
      const sh = ctx.shadow;
      const hgt = Math.max(0, sh.h);
      this.blob.visible = hgt < 8;
      this.blob.position.copy(sh.p).addScaledVector(sh.n, 0.03);
      this.blob.quaternion.setFromUnitVectors(Y, sh.n).multiply(_q.setFromAxisAngle(Y, sh.yaw));
      const k = 1 + hgt * 0.18;
      this.blob.scale.set(0.95 * k, 1, 1.9 * k);
      this.blob.material.opacity = 0.5 * Math.max(0, 1 - hgt / 8);
    } else {
      this.blob.visible = false;
    }

    // world-space strands
    if (this.pony || this.scarf) {
      this.root.updateMatrixWorld(true);
      const wind = ctx.wind || V();
      if (this.pony) {
        const anchor = V(-0.13, 0.05, 0).applyMatrix4(this.head.matrixWorld);
        const rest = V(-0.6, -1, 0).transformDirection(this.head.matrixWorld);
        this.pony.update(dt, anchor, rest, 9.8, wind);
        for (let i = 0; i < this.ponyMeshes.length; i++) {
          const m = this.ponyMeshes[i];
          const a = this.pony.p[i], b = this.pony.p[Math.min(i + 1, this.pony.n - 1)];
          m.position.copy(a).lerp(b, 0.5);
          const d = V().subVectors(b, a);
          if (d.lengthSq() > 1e-8) m.quaternion.setFromUnitVectors(Y, d.normalize());
        }
      }
      if (this.scarf) {
        const anchor = V(-0.07, 0.0, 0.02).applyMatrix4(this.neck.matrixWorld);
        const rest = V(-1, -1.2, 0.3).normalize().transformDirection(this.neck.matrixWorld);
        this.scarf.update(dt, anchor, rest, 6, wind);
        const side = V(0, 0, 1).transformDirection(this.neck.matrixWorld);
        for (let i = 0; i < this.scarf.n; i++) {
          const pnt = this.scarf.p[i];
          const w = 0.07 * (1 - i / (this.scarf.n * 1.6));
          const flutter = Math.sin(this.time * 18 + i * 0.9) * 0.02 * (i / this.scarf.n);
          this.scarfPos.set([pnt.x + side.x * w, pnt.y + side.y * w + flutter, pnt.z + side.z * w], i * 6);
          this.scarfPos.set([pnt.x - side.x * w, pnt.y - side.y * w + flutter, pnt.z - side.z * w], i * 6 + 3);
        }
        this.scarfGeo.attributes.position.needsUpdate = true;
        this.scarfGeo.computeVertexNormals();
      }
    }
  }

  // Landing impact (0..1+) compresses the legs.
  impulse(a) {
    this.absorbV += Math.min(1.4, a) * 5.5;
  }

  resetStrands() {
    if (this.pony) this.pony.init = false;
    if (this.scarf) this.scarf.init = false;
  }

  dispose() {
    const done = new Set();
    const disp = (o) => {
      if (o.geometry && !done.has(o.geometry)) { o.geometry.dispose(); done.add(o.geometry); }
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m && !done.has(m)) { m.map?.dispose(); m.normalMap?.dispose(); m.dispose(); done.add(m); }
    };
    this.root.traverse(disp);
    this.extras.traverse(disp);
  }
}
