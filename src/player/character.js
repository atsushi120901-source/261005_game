import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { damp, clamp } from '../core/utils.js';
import { boardTexture } from '../gfx/textures.js';

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
    sheen: opts.sheen ?? 0.8,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.45),
    clearcoat: opts.clearcoat ?? 0,
    clearcoatRoughness: 0.4,
  });
  return rimPatch(m, opts.rim ?? 0.28);
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

export class Character {
  constructor(def) {
    this.def = def;
    const L = def.look;
    this.root = new THREE.Group();
    this.root.name = 'rider';
    this.extras = new THREE.Group(); // world-space attachments (scarf, ponytail)
    this.meshes = [];

    const M = (this.mats = {
      jacket: fabric(L.jacket),
      jacket2: fabric(L.jacket2),
      accent: fabric(L.accent, { sheen: 0.4, roughness: 0.5 }),
      pants: fabric(L.pants, { roughness: 0.8 }),
      boots: rimPatch(new THREE.MeshStandardMaterial({ color: L.boots, roughness: 0.55 }), 0.2),
      gloves: fabric(L.gloves, { roughness: 0.6 }),
      gaiter: fabric(L.gaiter, { roughness: 0.85 }),
      skin: rimPatch(new THREE.MeshPhysicalMaterial({ color: L.skin, roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color(0xffd0c0) }), 0.15),
      helmet: rimPatch(new THREE.MeshPhysicalMaterial({ color: L.helmet, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }), 0.25),
      frame: new THREE.MeshStandardMaterial({ color: L.goggleFrame, roughness: 0.4 }),
      lens: new THREE.MeshPhysicalMaterial({
        color: L.lens, metalness: 1, roughness: 0.04, iridescence: 1, iridescenceIOR: 1.8,
        iridescenceThicknessRange: [200, 800], envMapIntensity: 2.2, clearcoat: 1,
      }),
      strap: fabric(L.accent, { sheen: 0.2, roughness: 0.6 }),
      hair: rimPatch(new THREE.MeshStandardMaterial({ color: L.hairColor, roughness: 0.55 }), 0.2),
      dark: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.6 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xb5bcc6, metalness: 1, roughness: 0.25 }),
      binding: new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.35, metalness: 0.3 }),
      bindingAcc: new THREE.MeshStandardMaterial({ color: L.accent, roughness: 0.35 }),
      scarf: fabric(L.scarfColor ?? 0xe0262f, { roughness: 0.9 }),
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
      const plate = new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.025, 0.12, 2, 0.01), this.mats.binding);
      plate.position.y = 0.012;
      b.add(plate);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.012, 20), this.mats.metal);
      disc.position.y = 0.026;
      b.add(disc);
      // highback (curved shell behind the heel, -X)
      const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.068, 0.24, 14, 1, true, Math.PI * 1.1, Math.PI * 0.8), this.mats.binding);
      hb.material.side = THREE.DoubleSide;
      hb.position.set(-0.03, 0.15, 0);
      hb.rotation.z = -0.25;
      b.add(hb);
      // boot
      const boot = new THREE.Group();
      boot.position.set(0.015, 0.03, 0);
      b.add(boot);
      const sole = new THREE.Mesh(new RoundedBoxGeometry(0.31, 0.05, 0.125, 2, 0.02), this.mats.dark);
      sole.position.y = 0.025;
      boot.add(sole);
      const upper = new THREE.Mesh(new RoundedBoxGeometry(0.29, 0.12, 0.12, 3, 0.045), this.mats.boots);
      upper.position.set(0.0, 0.1, 0);
      boot.add(upper);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.072, 0.16, 14), this.mats.boots);
      shaft.position.set(-0.035, 0.2, 0);
      boot.add(shaft);
      // straps
      for (const [x, y, r] of [[0.07, 0.13, 0.068], [-0.03, 0.22, 0.075]]) {
        const st = new THREE.Mesh(new THREE.TorusGeometry(r, 0.016, 6, 16, Math.PI * 1.15), this.mats.bindingAcc);
        st.position.set(x, y, 0);
        st.rotation.set(0, Math.PI / 2, -Math.PI * 0.07);
        st.rotation.order = 'YZX';
        boot.add(st);
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
    // lengths
    this.thigh = 0.45;
    this.shin = 0.45;
    this.upperArm = 0.29;
    this.foreArm = 0.27;

    // pelvis / torso chain
    this.pelvis = new THREE.Group();
    this.root.add(this.pelvis);
    add(this.pelvis, new THREE.SphereGeometry(0.19, 20, 14).scale(0.85, 0.75, 1.12), M.pants, 0, -0.01, 0);
    this.spine = new THREE.Group();
    this.spine.position.y = 0.1;
    this.pelvis.add(this.spine);
    this.chest = new THREE.Group();
    this.chest.position.y = 0.2;
    this.spine.add(this.chest);

    // jacket: two lathes (body + yoke), elliptical cross-section
    // baggy, slightly puffy jacket silhouette
    const lower = [
      [0.0, -0.32], [0.215, -0.32], [0.235, -0.29], [0.228, -0.2], [0.215, -0.08], [0.222, 0.04], [0.235, 0.12], [0.238, 0.16],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const upper = [
      [0.238, 0.12], [0.24, 0.2], [0.228, 0.27], [0.19, 0.33], [0.11, 0.375], [0.0, 0.385],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const DEPTH = 0.78;
    const jl = add(this.chest, new THREE.LatheGeometry(lower, 32), M.jacket);
    jl.scale.set(DEPTH, 1, 1);
    const ju = add(this.chest, new THREE.LatheGeometry(upper, 32), M.jacket2);
    ju.scale.set(DEPTH * 1.01, 1, 1);
    // hem band
    const hem = add(this.chest, new THREE.TorusGeometry(0.232, 0.022, 8, 32), M.jacket2, 0, -0.3, 0);
    hem.rotation.x = Math.PI / 2;
    hem.scale.set(DEPTH, 1, 1);
    // quilted puffer lines
    for (const y of [-0.17, -0.03]) {
      const q = add(this.chest, new THREE.TorusGeometry(0.226, 0.008, 6, 32), M.jacket, 0, y, 0);
      q.rotation.x = Math.PI / 2;
      q.scale.set(DEPTH * 1.005, 1, 1);
    }
    // zipper and chest stripe
    add(this.chest, new THREE.BoxGeometry(0.014, 0.66, 0.02), M.dark, 0.183, 0.03, 0.0).rotation.z = 0.03;
    const stripe = add(this.chest, new THREE.TorusGeometry(0.239, 0.016, 6, 32), M.accent, 0, 0.13, 0);
    stripe.rotation.x = Math.PI / 2;
    stripe.scale.set(DEPTH * 1.01, 1, 1);
    // pocket flaps
    for (const z of [-0.12, 0.12]) add(this.chest, new RoundedBoxGeometry(0.035, 0.05, 0.12, 2, 0.012), M.jacket2, 0.168, -0.15, z);
    // chest logo patch
    add(this.chest, new RoundedBoxGeometry(0.02, 0.05, 0.06, 2, 0.01), M.accent, 0.178, 0.2, -0.1);
    // collar
    add(this.chest, new THREE.CylinderGeometry(0.085, 0.1, 0.1, 18, 1, true), M.jacket2, 0, 0.39, 0).material.side = THREE.DoubleSide;
    // hood resting on the back (unless worn)
    if (L.headwear !== 'hood') {
      // hood folded down on the back
      const hood = add(this.chest, new THREE.SphereGeometry(0.12, 16, 12), M.jacket2, -0.14, 0.33, 0);
      hood.scale.set(0.55, 0.6, 1.15);
    }
    if (L.backpack) {
      const bp = add(this.chest, new RoundedBoxGeometry(0.13, 0.4, 0.3, 3, 0.05), M.jacket2, -0.235, 0.05, 0);
      add(bp, new RoundedBoxGeometry(0.04, 0.18, 0.22, 2, 0.02), M.accent, -0.06, -0.06, 0);
      // board-carry straps
      for (const z of [-0.1, 0.1]) add(this.chest, new THREE.BoxGeometry(0.36, 0.022, 0.035), M.dark, -0.04, 0.27, z).rotation.z = -0.25;
    }

    // neck & head
    this.neck = new THREE.Group();
    this.neck.position.y = 0.37;
    this.chest.add(this.neck);
    add(this.neck, new THREE.CylinderGeometry(0.068, 0.078, 0.12, 16), M.gaiter, 0, 0.04, 0);
    this.head = new THREE.Group();
    this.head.position.y = 0.17;
    this.neck.add(this.head);
    const H = this.head;
    // face is +X
    add(H, new THREE.SphereGeometry(0.105, 24, 18).scale(0.98, 1.08, 0.92), M.skin);
    add(H, new THREE.ConeGeometry(0.018, 0.045, 8).rotateZ(-Math.PI / 2), M.skin, 0.112, -0.01, 0);
    // ears
    for (const z of [-1, 1]) add(H, new THREE.SphereGeometry(0.025, 8, 6).scale(0.6, 1, 0.5), M.skin, 0, -0.005, z * 0.095);
    // gaiter covering mouth and chin
    const gm = add(H, new THREE.SphereGeometry(0.112, 20, 12, 0, Math.PI * 2, Math.PI * 0.58, Math.PI * 0.42), M.gaiter, 0.0, 0.0, 0);
    gm.scale.set(1.02, 1.1, 0.97);

    // hair
    if (L.hair === 'short') {
      add(H, new THREE.SphereGeometry(0.112, 16, 10, -Math.PI * 0.45, Math.PI * 0.9, Math.PI * 0.35, Math.PI * 0.32), M.hair, -0.004, 0.0, 0);
    }
    if (L.hair === 'ponytail') {
      add(H, new THREE.SphereGeometry(0.114, 16, 12, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.3, Math.PI * 0.42), M.hair, -0.01, 0, 0);
      this.pony = new Strand(6, 0.07, 0.05);
      this.ponyMeshes = [];
      for (let i = 0; i < 6; i++) {
        const r = 0.042 - i * 0.004;
        const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8).scale(1, 1.5, 1), M.hair);
        m.castShadow = true;
        this.extras.add(m);
        this.ponyMeshes.push(m);
      }
      // hair tie
      add(H, new THREE.TorusGeometry(0.03, 0.01, 6, 12), M.accent, -0.12, 0.06, 0).rotation.y = Math.PI / 2;
    }

    // headwear
    if (L.headwear === 'helmet') {
      const hel = add(H, new THREE.SphereGeometry(0.135, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.56), M.helmet, -0.008, 0.012, 0);
      hel.scale.set(1.05, 1.0, 0.98);
      // vents
      for (let i = -1; i <= 1; i++) add(H, new RoundedBoxGeometry(0.1, 0.02, 0.02, 1, 0.008), M.dark, -0.01, 0.142, i * 0.045).rotation.z = 0.0;
      // ear pads
      for (const z of [-1, 1]) add(H, new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16).rotateX(Math.PI / 2), M.dark, -0.01, -0.025, z * 0.118);
      // rim
      const rim = add(H, new THREE.TorusGeometry(0.135, 0.008, 6, 32), M.dark, -0.008, 0.0, 0);
      rim.rotation.x = Math.PI / 2;
      rim.scale.set(1.05, 0.98, 1);
    } else if (L.headwear === 'beanie') {
      const bn = add(H, new THREE.SphereGeometry(0.122, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), M.jacket2, -0.005, 0.02, 0);
      bn.scale.set(1.02, 1.12, 0.98);
      // rib knit cuff
      const cuff = add(H, new THREE.CylinderGeometry(0.124, 0.126, 0.05, 28, 1, true), M.accent, -0.005, 0.03, 0);
      cuff.scale.set(1.02, 1, 0.98);
      // pom pom
      const pom = new THREE.IcosahedronGeometry(0.05, 2);
      const pp = pom.attributes.position;
      for (let i = 0; i < pp.count; i++) {
        const k = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.18;
        pp.setXYZ(i, pp.getX(i) * k, pp.getY(i) * k, pp.getZ(i) * k);
      }
      pom.computeVertexNormals();
      add(H, pom, M.accent, -0.02, 0.165, 0);
    } else if (L.headwear === 'hood') {
      const hood = add(H, new THREE.SphereGeometry(0.15, 24, 18, Math.PI * 1.22, Math.PI * 1.56, 0, Math.PI * 0.7), M.jacket, -0.03, 0.01, 0);
      hood.material = M.jacket.clone();
      hood.material.side = THREE.DoubleSide;
      hood.material.onBeforeCompile = M.jacket.onBeforeCompile;
      hood.scale.set(1.0, 1.08, 1.0);
      // drawcords
      for (const z of [-0.05, 0.05]) add(H, new THREE.CylinderGeometry(0.005, 0.005, 0.14, 4), M.accent, 0.1, -0.13, z);
    }

    // goggles (frame + iridescent lens + strap)
    const gy = 0.04;
    const frame = add(H, new THREE.CylinderGeometry(0.128, 0.128, 0.075, 28, 1, true, Math.PI * 0.18, Math.PI * 0.64), M.frame, 0.0, gy, 0);
    frame.material.side = THREE.DoubleSide;
    frame.scale.set(1.0, 1, 1.05);
    const lens = add(H, new THREE.CylinderGeometry(0.133, 0.133, 0.058, 28, 1, true, Math.PI * 0.2, Math.PI * 0.6), M.lens, 0.0, gy, 0);
    lens.scale.set(1.0, 1, 1.05);
    const strapR = L.headwear === 'hood' ? 0.155 : L.headwear === 'beanie' ? 0.128 : 0.14;
    const strap = add(H, new THREE.CylinderGeometry(strapR, strapR, 0.035, 28, 1, true), M.strap, -0.006, gy + 0.005, 0);
    strap.material.side = THREE.DoubleSide;
    strap.scale.set(1.02, 1, 1.0);
    // cylinder seams start at +Z; rotate so the open lens faces +X
    frame.rotation.y = Math.PI / 2 - Math.PI * 0.5;
    lens.rotation.y = frame.rotation.y;

    // limbs (placed in root space every frame)
    const limb = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      this.root.add(m);
      return m;
    };
    this.legs = [0, 1].map(() => ({
      thigh: limb(limbGeo(0.12, 0.103, this.thigh), M.pants),
      shin: limb(limbGeo(0.103, 0.098, this.shin), M.pants),
      knee: limb(new THREE.SphereGeometry(0.102, 14, 10), M.pants),
    }));
    for (const leg of this.legs) {
      // baggy pant cuff falling over the boot
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.104, 0.122, 0.14, 16, 1, true), M.pants);
      cuff.material.side = THREE.DoubleSide;
      cuff.position.y = 0.02;
      leg.shin.add(cuff);
      // side seam / cargo pocket
      const pocket = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.13, 0.03, 2, 0.01), M.pants);
      pocket.position.set(0, this.thigh * 0.45, 0.112);
      leg.thigh.add(pocket);
    }
    this.arms = [0, 1].map(() => {
      const a = {
        upper: limb(limbGeo(0.086, 0.074, this.upperArm), M.jacket),
        fore: limb(limbGeo(0.074, 0.066, this.foreArm), M.jacket),
        elbow: limb(new THREE.SphereGeometry(0.075, 12, 10), M.jacket),
        shoulder: limb(new THREE.SphereGeometry(0.084, 14, 10), M.jacket),
        hand: new THREE.Group(),
      };
      this.root.add(a.hand);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.066, 0.08, 14), M.gloves);
      cuff.position.y = -0.0;
      a.hand.add(cuff);
      const mitt = new THREE.Mesh(new RoundedBoxGeometry(0.085, 0.13, 0.11, 3, 0.038), M.gloves);
      mitt.position.y = 0.08;
      a.hand.add(mitt);
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.04, 4, 8), M.gloves);
      thumb.position.set(0.03, 0.06, 0.045);
      thumb.rotation.x = -0.6;
      a.hand.add(thumb);
      return a;
    });

    // scarf
    if (L.scarf) {
      this.scarf = new Strand(9, 0.085, 0.03);
      const segs = this.scarf.n;
      const geo = new THREE.BufferGeometry();
      this.scarfPos = new Float32Array(segs * 2 * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(this.scarfPos, 3));
      const idx = [];
      for (let i = 0; i < segs - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(idx);
      this.scarfGeo = geo;
      const sm = new THREE.Mesh(geo, M.scarf);
      sm.frustumCulled = false;
      sm.castShadow = true;
      this.extras.add(sm);
      // wrap around neck
      add(this.neck, new THREE.TorusGeometry(0.085, 0.03, 8, 20), M.scarf, 0, 0.0, 0).rotation.x = Math.PI / 2;
    }
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
        t.lh.set(0.16, 0.74, -0.36);
        t.rh.set(0.06, 0.72, 0.36);
        break;
      case 'ride':
        t.hipX += carve * 0.11;
        t.hipH -= Math.abs(carve) * 0.08 + tuck * 0.18;
        t.lean += carve * -0.2 - tuck * 0.35 + (carve < 0 ? -carve * 0.12 : 0);
        t.side = carve * 0.1;
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
    p.lh.lerp(t.lh, 1 - Math.exp(-k * dt));
    p.rh.lerp(t.rh, 1 - Math.exp(-k * dt));

    // breathing / micro motion
    const breathe = Math.sin(this.time * 2.2) * 0.008;
    const vib = ctx.vibration || 0;
    const jitter = vib ? (Math.sin(this.time * 61) * 0.5 + Math.sin(this.time * 37) * 0.5) * vib * 0.012 : 0;

    // board tweak
    this.board.position.y = p.boardLift;
    this.board.rotation.set(p.boardPitch, 0, p.boardRoll, 'XYZ');
    this.board.updateMatrix();

    // pelvis
    this.pelvis.position.set(p.hipX, p.hipH + breathe + jitter, p.hipZ);
    this.pelvis.rotation.set(p.side, p.twist * 0.35, p.lean * 0.45, 'YXZ');
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
      const sh = V(0, 0.3, side * 0.215).applyMatrix4(mChest);
      const target = (i === 0 ? p.lh : p.rh).clone();
      // swing a bit
      target.y += Math.sin(this.time * 1.7 + i) * 0.015;
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

  resetStrands() {
    if (this.pony) this.pony.init = false;
    if (this.scarf) this.scarf.init = false;
  }

  dispose() {
    const done = new Set();
    const disp = (o) => {
      if (o.geometry && !done.has(o.geometry)) { o.geometry.dispose(); done.add(o.geometry); }
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m && !done.has(m)) { m.map?.dispose(); m.dispose(); done.add(m); }
    };
    this.root.traverse(disp);
    this.extras.traverse(disp);
  }
}
