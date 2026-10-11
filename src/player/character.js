import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { damp, clamp } from '../core/utils.js';
import { boardTexture, glowTexture } from '../gfx/textures.js';
import { fabricNormal, grimeTexture } from '../gfx/fabric.js';
import { BONES, ANKLE } from './riderModel.js';
import { bakeRider } from './riderBake.js';

// Procedural snowboarder.
// Local space: board long axis = Z (nose at -Z), rider faces +X (toe edge),
// y = 0 is the board base. The body is one continuous sculpted mesh skinned to
// a skeleton; legs and arms are solved with two-bone IK every frame so feet stay
// locked in the bindings and hands can really grab the board.

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
  if (opts.grime) {
    // weathering: stains, scuffs and faded patches over the base colour
    const g = grimeTexture(opts.grimeSeed ?? 1, opts.grime).clone();
    g.needsUpdate = true;
    g.repeat.set(...(opts.grimeRepeat || [1, 1]));
    m.map = g;
    m.sheen *= 0.5;
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

const _x = V(), _y = V(), _z = V();

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
const _s = V();
const _m4 = new THREE.Matrix4();
const _m5 = new THREE.Matrix4();

// Body material: vertex-coloured fabric with procedural weathering and a
// fine woven micro-normal, driven by the bind-pose position so it never swims.
function bodyMaterial(grime) {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.8, metalness: 0, sheen: 0.25, sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0.5, 0.5, 0.5),
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGrime = { value: grime };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aMat;\nvarying vec2 vMat;\nvarying vec3 vRest;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;\nvRest = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vMat;
        varying vec3 vRest;
        uniform float uGrime;
        float bh(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float bn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(bh(i), bh(i + vec3(1,0,0)), f.x), mix(bh(i + vec3(0,1,0)), bh(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(bh(i + vec3(0,0,1)), bh(i + vec3(1,0,1)), f.x), mix(bh(i + vec3(0,1,1)), bh(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float fab = min(vMat.y, 1.0);
          float n1 = bn(vRest * 6.0), n2 = bn(vRest * 21.0 + 3.1);
          float dirt = smoothstep(0.5, 0.95, n1 * 0.7 + n2 * 0.3) * uGrime * fab;
          diffuseColor.rgb *= mix(1.0, 0.8 + 0.08 * n2, dirt);
          float faded = smoothstep(0.75, 0.95, bn(vRest * 4.0 + 7.7)) * uGrime * fab;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.08 + 0.03, faded * 0.5);
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vMat.x;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // fine woven texture (kept subtle so the fabric does not look fuzzy)
          vec3 q = vRest * 160.0;
          vec3 jit = vec3(bn(q), bn(q + 11.3), bn(q + 23.1)) - 0.5;
          normal = normalize(normal + jit * 0.05 * vMat.y);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          totalEmissiveRadiance += vec3(0.62, 0.78, 1.0) * pow(1.0 - nv, 3.0) * 0.08; }`);
  };
  m.customProgramCacheKey = () => 'riderBody2';
  return m;
}

export class Character {
  constructor(def, opts = {}) {
    this.def = def;
    const L = def.look;
    this.root = new THREE.Group();
    this.root.name = 'rider';
    this.extras = new THREE.Group(); // world-space attachments (scarf, ponytail, contact shadow)

    const gr = L.grime ?? 0;
    const M = (this.mats = {
      knit: fabric(L.beanie ?? L.jacket2, { roughness: 0.95, weave: 'knit', repeat: [5, 1], bump: 0.9, grime: gr * 0.6, grimeSeed: 21 }),
      accent: fabric(L.accent, { sheen: 0.4, roughness: 0.5 }),
      jacket: fabric(L.jacket, { weave: 'nylon', repeat: [1, 1], bump: 0.4, sheen: 0.35, grime: gr, grimeSeed: 3 }),
      jacket2: fabric(L.jacket2, { weave: 'nylon', repeat: [1, 1], bump: 0.4, sheen: 0.35, grime: gr, grimeSeed: 5 }),
      pack: fabric(L.pack ?? 0x4a4d50, { roughness: 0.75, weave: 'nylon', repeat: [2, 2], bump: 0.5, grime: gr * 1.2, grimeSeed: 25 }),
      webbing: fabric(L.webbing ?? 0x2e3033, { roughness: 0.8, weave: 'knit', repeat: [1, 8], bump: 0.4, grime: gr, grimeSeed: 23 }),
      helmet: rimPatch(new THREE.MeshPhysicalMaterial({ color: L.helmet, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06 }), 0.1),
      frame: new THREE.MeshStandardMaterial({ color: L.goggleFrame, roughness: 0.45 }),
      foam: new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.95 }),
      lens: new THREE.MeshPhysicalMaterial({
        color: L.lens, metalness: 0.75, roughness: 0.04, iridescence: 1, iridescenceIOR: 1.8,
        iridescenceThicknessRange: [200, 800], envMapIntensity: 2.6, clearcoat: 1,
        emissive: new THREE.Color(L.lens).multiplyScalar(0.14),
      }),
      strap: fabric(L.strapColor ?? (L.grime ? 0x1c1d1f : L.accent), { sheen: 0.2, roughness: 0.6, weave: 'knit', repeat: [12, 1], bump: 0.3 }),
      hair: rimPatch(new THREE.MeshPhysicalMaterial({ color: L.hairColor, roughness: 0.5, sheen: 1, sheenRoughness: 0.35, sheenColor: new THREE.Color(L.hairColor).lerp(new THREE.Color(0xffffff), 0.25) }), 0.08),
      dark: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.6 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xb5bcc6, metalness: 1, roughness: 0.25 }),
      binding: new THREE.MeshPhysicalMaterial({ color: 0x1a1b1f, roughness: 0.35, metalness: 0.2, clearcoat: 0.6 }),
      bindingAcc: new THREE.MeshStandardMaterial({ color: L.accent, roughness: 0.35 }),
      scarf: fabric(L.scarfColor ?? 0xe0262f, { roughness: 0.9, weave: 'knit', repeat: [1, 6], bump: 0.6 }),
      body: bodyMaterial(gr),
    });
    M.scarf.side = THREE.DoubleSide;

    // limb lengths (adult ~1.78 m)
    this.thigh = 0.44;
    this.shin = 0.42;
    this.upperArm = 0.3;
    this.foreArm = 0.26;

    this._buildBoard(L);

    // pose state (smoothed)
    this.p = {
      hipH: 0.92, hipX: 0.02, hipZ: 0, lean: -0.15, side: 0, twist: 0.4, headYaw: 1.0, headPitch: 0.1,
      lh: V(0.15, 1.0, -0.6), rh: V(0.0, 0.9, 0.5),
      boardPitch: 0, boardRoll: 0, boardLift: 0,
    };
    this.target = { ...this.p, lh: this.p.lh.clone(), rh: this.p.rh.clone(), lhB: false, rhB: false };
    this.lhv = V();
    this.rhv = V();
    this.absorb = 0;
    this.absorbV = 0;
    this.time = 0;

    // skeleton: bind pose -> skinned body
    this.boneMats = BONES.map(() => new THREE.Matrix4());
    this.bones = BONES.map((n) => {
      const b = new THREE.Bone();
      b.name = n;
      this.root.add(b);
      return b;
    });
    this.setPose('bind');
    this.snap();
    this._solve(0, 0, 0);
    const bind = this.boneMats.map((m) => m.clone());
    Character.bind = bind;
    // the body is sculpted asynchronously; it appears as soon as it is ready
    this.body = new THREE.SkinnedMesh(new THREE.BufferGeometry(), M.body);
    this.body.frustumCulled = false;
    this.body.visible = false;
    this.body.castShadow = true;
    this.root.add(this.body);
    this.body.bind(new THREE.Skeleton(this.bones, bind.map((m) => m.clone().invert())), new THREE.Matrix4());
    this._applyBones();
    this.ready = bakeRider(def, bind, opts.cell ?? def.cell).then((geo) => {
      if (this.disposed) return;
      this.body.geometry.dispose();
      this.body.geometry = geo;
      this.body.visible = true;
    });

    this._buildGear(L);

    this.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.setPose('ride');
    this.snap();
  }

  // ------------------------------------------------------------------ board
  _buildBoard(L) {
    const M = this.mats;
    const g = new THREE.Group();
    this.board = g;
    this.root.add(g);
    const len = 1.56, half = len / 2;
    const s = new THREE.Shape();
    const wN = 0.148, wW = 0.124;
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
      pos.setY(i, pos.getY(i) + 0.006 * Math.cos((z / half) * Math.PI * 0.5));
      uv.setXY(i, (x + 0.16) / 0.32, 1 - (z + half) / len);
    }
    geo.computeVertexNormals();
    const top = new THREE.MeshPhysicalMaterial({ map: boardTexture(L.board.colors, L.board.label, L.board.pattern), roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.12 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 1, roughness: 0.3 });
    const board = new THREE.Mesh(geo, [top, edge]);
    board.position.y = 0.002;
    g.add(board);
    const base = new THREE.Mesh(geo.clone(), new THREE.MeshStandardMaterial({ color: L.board.base, roughness: 0.35 }));
    base.position.y = -0.004;
    base.scale.set(0.995, 1, 0.995);
    g.add(base);

    // bindings (boots are part of the skinned body and follow the foot bones)
    this.feet = [];
    const stance = 0.27;
    for (const [z, ang] of [[-stance, 0.26], [stance, -0.1]]) {
      const b = new THREE.Group();
      b.position.set(0, 0.016, z);
      b.rotation.y = ang;
      g.add(b);
      const plate = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.024, 0.14, 2, 0.01), M.binding);
      plate.position.y = 0.012;
      b.add(plate);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.01, 24), M.metal);
      disc.position.y = 0.027;
      b.add(disc);
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.086, 0.086, 0.07, 16, 1, true, Math.PI * 1.05, Math.PI * 0.9), M.binding);
      cup.material.side = THREE.DoubleSide;
      cup.position.set(-0.07, 0.06, 0);
      b.add(cup);
      const hb = new THREE.Mesh(profileGeo([[0, 0.084, 0.078], [0.08, 0.082, 0.075], [0.15, 0.079, 0.072]], 16), M.binding);
      hb.material.side = THREE.DoubleSide;
      const hbIdx = hb.geometry.index.array, keep = [];
      const hp = hb.geometry.attributes.position;
      for (let i = 0; i < hbIdx.length; i += 3) {
        const cx = (hp.getX(hbIdx[i]) + hp.getX(hbIdx[i + 1]) + hp.getX(hbIdx[i + 2])) / 3;
        if (cx < -0.02) keep.push(hbIdx[i], hbIdx[i + 1], hbIdx[i + 2]);
      }
      hb.geometry.setIndex(keep);
      hb.position.set(-0.035, 0.05, 0);
      hb.rotation.z = -0.2;
      b.add(hb);
      // padded ankle strap and toe cap strap with ratchets
      const ankle = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.022, 8, 20, Math.PI * 1.15), M.binding);
      ankle.position.set(-0.005, 0.15, 0);
      ankle.rotation.set(0, Math.PI / 2, -0.8);
      ankle.rotation.order = 'YZX';
      ankle.scale.set(1, 1, 1.6);
      b.add(ankle);
      const toe = new THREE.Mesh(new THREE.TorusGeometry(0.066, 0.012, 6, 18, Math.PI * 1.1), M.bindingAcc);
      toe.position.set(0.122, 0.07, 0);
      toe.rotation.set(0, Math.PI / 2, 0.3);
      toe.rotation.order = 'YZX';
      b.add(toe);
      for (const zz of [-0.08, 0.08]) {
        const ratchet = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.025, 0.018, 1, 0.006), M.metal);
        ratchet.position.set(-0.02, 0.14, zz);
        b.add(ratchet);
      }
      this.feet.push({ group: b });
    }
  }

  // ------------------------------------------------------------------ rigid gear on bones
  _buildGear(L) {
    const M = this.mats;
    const add = (parent, geo, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const H = new THREE.Group();
    H.scale.setScalar(1.1);
    this.bones[4].add(H);
    const chest = this.bones[2];

    // hair under the hat
    if (L.hair === 'short' || L.hair === 'ponytail') {
      add(H, new THREE.SphereGeometry(0.106, 20, 10, -Math.PI * 0.5, Math.PI, Math.PI * 0.42, Math.PI * 0.22), M.hair, -0.006, 0.0, 0).scale.set(1.0, 1.05, 0.98);
    }
    if (L.hair === 'ponytail') {
      this.pony = new Strand(7, 0.062, 0.05);
      this.ponyMeshes = [];
      for (let i = 0; i < 7; i++) {
        const r = 0.036 - i * 0.004;
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, 0.05, 4, 10).scale(1, 1, 0.8), M.hair);
        m.castShadow = true;
        this.extras.add(m);
        this.ponyMeshes.push(m);
      }
    }

    // headwear
    if (L.headwear === 'helmet') {
      const prof = [[0.0, 0.158], [0.06, 0.152], [0.1, 0.133], [0.128, 0.098], [0.142, 0.052], [0.146, 0.01], [0.144, -0.022], [0.138, -0.03]]
        .map(([r, y]) => new THREE.Vector2(r, y));
      const hel = add(H, new THREE.LatheGeometry(prof, 36), M.helmet, -0.01, 0.006, 0);
      hel.scale.set(1.06, 1.0, 0.97);
    } else {
      // knit beanie with a rolled cuff
      const bn = add(H, new THREE.SphereGeometry(0.118, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.56), M.knit, -0.008, 0.024, 0);
      bn.scale.set(1.04, 1.12, 1.0);
      const cuff = add(H, profileGeo([[0, 0.126, 0.118], [0.028, 0.129, 0.121], [0.055, 0.125, 0.117]], 32), M.knit, -0.008, 0.002, 0);
      cuff.scale.set(1.03, 1, 1.0);
      if (L.pom) {
        const pom = new THREE.SphereGeometry(0.048, 32, 24);
        const pp = pom.attributes.position;
        for (let i = 0; i < pp.count; i++) {
          const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
          const k = 1 + 0.06 * Math.sin(x * 160) * Math.sin(y * 170) * Math.sin(z * 150);
          pp.setXYZ(i, x * k, y * k, z * k);
        }
        pom.computeVertexNormals();
        add(H, pom, M.accent, -0.02, 0.165, 0);
      }
      if (L.headwear === 'hood') {
        const hood = add(H, new THREE.SphereGeometry(0.152, 28, 18, Math.PI * 1.25, Math.PI * 1.5, 0, Math.PI * 0.7), M.jacket.clone(), -0.03, 0.012, 0);
        hood.material.side = THREE.DoubleSide;
        hood.material.onBeforeCompile = M.jacket.onBeforeCompile;
        hood.scale.set(1.0, 1.1, 1.0);
      }
    }

    // goggles: foam + frame band, mirror lens, strap around the back
    const gy = 0.045;
    const band = (r, h, a, mat) => {
      const m = add(H, new THREE.CylinderGeometry(r, r, h, 32, 1, true, Math.PI * (0.5 - a), Math.PI * 2 * a), mat, -0.004, gy, 0);
      m.material.side = THREE.DoubleSide;
      m.scale.set(1.0, 1, 1.06);
      return m;
    };
    band(0.118, 0.066, 0.3, M.foam);
    band(0.127, 0.078, 0.31, M.frame);
    add(H, new THREE.SphereGeometry(0.146, 32, 12, Math.PI * 0.7, Math.PI * 0.6, Math.PI * 0.385, Math.PI * 0.23), M.lens, -0.006, gy, 0);
    const strapR = L.headwear === 'hood' ? 0.158 : 0.131;
    const strap = add(H, new THREE.CylinderGeometry(strapR, strapR, 0.036, 32, 1, true, Math.PI * 0.82, Math.PI * 1.36), M.strap, -0.01, gy + 0.004, 0);
    strap.material.side = THREE.DoubleSide;
    strap.scale.set(1.04, 1, 1.0);

    // technical backpack on the chest bone
    if (L.backpack) {
      const bp = add(chest, new RoundedBoxGeometry(0.15, 0.42, 0.29, 5, 0.07), M.pack, -0.27, 0.07, 0);
      add(bp, new RoundedBoxGeometry(0.06, 0.12, 0.26, 3, 0.04), M.pack, -0.005, 0.22, 0);
      add(bp, new RoundedBoxGeometry(0.06, 0.19, 0.21, 4, 0.05), M.pack, -0.08, -0.06, 0);
      for (const y of [-0.04, 0.1]) add(bp, new THREE.BoxGeometry(0.162, 0.02, 0.3), M.webbing, 0, y, 0);
      const bottle = add(bp, new THREE.CylinderGeometry(0.031, 0.031, 0.16, 14), M.metal, -0.01, -0.05, 0.165);
      add(bottle, new THREE.CylinderGeometry(0.02, 0.025, 0.035, 12), M.dark, 0, 0.095, 0);
      add(bottle, new THREE.CylinderGeometry(0.0325, 0.0325, 0.055, 14), M.accent, 0, -0.02, 0);
    }

    // scarf (simulated ribbon)
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
      add(this.bones[3], new THREE.TorusGeometry(0.09, 0.034, 10, 24), M.scarf, 0, 0.0, 0).rotation.x = Math.PI / 2;
    }

    // soft contact shadow on the snow under the board
    const shm = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: glowTexture(), transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shm);
    this.blob.renderOrder = 1;
    this.blob.scale.set(0.9, 1, 1.9);
    this.extras.add(this.blob);
  }

  // ------------------------------------------------------------------ posing
  setPose(name, opts = {}) {
    const t = this.target;
    Object.assign(t, {
      hipH: 0.9, hipX: 0.04, hipZ: 0, lean: -0.22, side: 0, twist: 0.45, headYaw: 1.05, headPitch: 0.12,
      boardPitch: 0, boardRoll: 0, boardLift: 0, lhB: false, rhB: false,
    });
    t.lh.set(0.24, 1.08, -0.58);
    t.rh.set(0.04, 0.96, 0.52);
    const carve = opts.carve || 0; // -1 heel ... +1 toe
    const tuck = opts.tuck || 0;
    switch (name) {
      case 'bind':
        Object.assign(t, { hipH: 0.99, hipX: 0, lean: 0, twist: 0, headYaw: 0, headPitch: 0 });
        t.lh.set(0.05, 0.98, -0.5);
        t.rh.set(0.05, 0.98, 0.5);
        break;
      case 'idle':
        Object.assign(t, { hipH: 0.95, lean: -0.06, twist: 0.3, headYaw: 0.55, headPitch: 0.0 });
        t.lh.set(0.2, 0.92, -0.34);
        t.rh.set(0.12, 0.9, 0.36);
        break;
      case 'ride':
        t.hipX += carve * 0.1;
        t.hipH -= Math.abs(carve) * 0.06 + tuck * 0.16;
        t.lean += carve * -0.2 - tuck * 0.35 + (carve < 0 ? -carve * 0.1 : 0);
        t.side = carve * 0.1;
        t.headYaw += carve * 0.22;
        t.lh.set(0.32 + carve * 0.12, 1.0 - tuck * 0.25 + (carve < 0 ? -0.1 : 0), -0.62);
        t.rh.set(0.08 + carve * 0.18, 0.88 - tuck * 0.2, 0.5);
        if (opts.brake) {
          Object.assign(t, { hipH: 0.82, hipX: -0.1, lean: 0.12, twist: 0.15, headYaw: 0.8 });
          t.lh.set(0.36, 1.0, -0.5);
          t.rh.set(0.3, 0.95, 0.42);
        }
        break;
      case 'crouch':
        Object.assign(t, { hipH: 0.72, hipX: 0.1, lean: -0.55, twist: 0.35 });
        t.lh.set(0.4, 0.68, -0.45);
        t.rh.set(0.2, 0.62, 0.35);
        break;
      case 'pop':
        Object.assign(t, { hipH: 0.98, lean: -0.08, twist: 0.4 });
        t.lh.set(0.25, 1.35, -0.6);
        t.rh.set(-0.05, 1.25, 0.6);
        break;
      case 'air':
        Object.assign(t, { hipH: 0.84, hipX: 0.04, lean: -0.28, twist: 0.4, headPitch: 0.25, boardLift: 0.08 });
        t.lh.set(0.2, 1.1, -0.72);
        t.rh.set(0.0, 1.05, 0.72);
        break;
      case 'spin': {
        const d = opts.dir || 1;
        Object.assign(t, { hipH: 0.8, lean: -0.32, twist: 0.4 + d * 0.5, headYaw: 1.0 + d * 0.5, headPitch: 0.3, boardLift: 0.1 });
        t.lh.set(0.38, 0.95, -0.35 + d * 0.2);
        t.rh.set(0.32, 0.9, 0.35 + d * 0.2);
        break;
      }
      case 'flip':
        Object.assign(t, { hipH: 0.7, lean: -0.62, twist: 0.2, headPitch: 0.6, boardLift: 0.16 });
        t.lh.set(0.38, 0.72, -0.25);
        t.rh.set(0.38, 0.72, 0.25);
        break;
      case 'indy':
        Object.assign(t, { hipH: 0.62, hipX: 0.1, lean: -0.85, twist: 0.25, headPitch: 0.35, boardLift: 0.28, rhB: true });
        t.rh.set(0.13, 0.025, 0.04);
        t.lh.set(0.35, 1.25, -0.7);
        break;
      case 'method':
        Object.assign(t, { hipH: 0.64, hipX: -0.02, lean: 0.15, twist: -0.1, headYaw: 1.3, headPitch: 0.1, boardRoll: 0.6, boardLift: 0.32, lhB: true });
        t.lh.set(-0.13, 0.025, -0.05);
        t.rh.set(0.05, 1.45, 0.6);
        break;
      case 'nose':
        Object.assign(t, { hipH: 0.64, hipX: 0.08, hipZ: -0.08, lean: -0.7, twist: 0.7, side: -0.25, boardPitch: 0.35, boardLift: 0.26, lhB: true });
        t.lh.set(0.0, 0.03, -0.66);
        t.rh.set(-0.05, 1.3, 0.6);
        break;
      case 'tail':
        Object.assign(t, { hipH: 0.64, hipX: 0.08, hipZ: 0.08, lean: -0.62, twist: 0.1, side: 0.25, boardPitch: -0.35, boardLift: 0.26, rhB: true });
        t.rh.set(0.0, 0.03, 0.66);
        t.lh.set(0.3, 1.3, -0.7);
        break;
      case 'grind':
        Object.assign(t, { hipH: 0.88, lean: -0.2, twist: 0.35, headPitch: 0.2 });
        t.lh.set(0.22, 1.15, -0.75);
        t.rh.set(0.0, 1.1, 0.75);
        break;
      case 'crash':
        Object.assign(t, { hipH: 0.8, lean: -0.4, twist: 0.8, headPitch: 0.5 });
        t.lh.set(0.42, 1.5, -0.6);
        t.rh.set(-0.3, 1.4, 0.7);
        break;
      case 'celebrate':
        Object.assign(t, { hipH: 0.97, lean: 0.05, twist: 0.6, headYaw: 0.9, headPitch: -0.1 });
        t.lh.set(0.15, 1.78, -0.35);
        t.rh.set(0.15, 1.78, 0.35);
        break;
      default:
        break;
    }
  }

  // Snap the current pose to the target (on respawn / menu).
  snap() {
    this.lhv.set(0, 0, 0);
    this.rhv.set(0, 0, 0);
    this.absorb = 0;
    this.absorbV = 0;
    for (const k of ['hipH', 'hipX', 'hipZ', 'lean', 'side', 'twist', 'headYaw', 'headPitch', 'boardPitch', 'boardRoll', 'boardLift']) this.p[k] = this.target[k];
    this._boardMatrix();
    this.p.lh.copy(this._handTarget(0));
    this.p.rh.copy(this._handTarget(1));
  }

  _boardMatrix() {
    const p = this.p;
    this.board.position.set(0, p.boardLift, 0);
    this.board.rotation.set(p.boardPitch, 0, p.boardRoll, 'XYZ');
    this.board.updateMatrix();
  }

  _handTarget(i) {
    const t = this.target;
    const onBoard = i === 0 ? t.lhB : t.rhB;
    const v = (i === 0 ? t.lh : t.rh).clone();
    return onBoard ? v.applyMatrix4(this.board.matrix) : v;
  }

  // Solve the skeleton for the current pose into this.boneMats (root space).
  _solve(ab, breathe, jitter) {
    const p = this.p;
    const BM = this.boneMats;
    const e = new THREE.Euler();
    const T = (x, y, z) => _m5.makeTranslation(x, y, z);
    // torso chain
    BM[0].compose(V(p.hipX + ab * 0.05, p.hipH + breathe + jitter - ab * 0.22, p.hipZ),
      _q.setFromEuler(e.set(p.side, p.twist * 0.35, (p.lean - ab * 0.35) * 0.45, 'YXZ')), V(1, 1, 1));
    BM[1].copy(BM[0]).multiply(T(0, 0.08, 0)).multiply(_m4.makeRotationFromEuler(e.set(0, p.twist * 0.35, p.lean * 0.35, 'YXZ')));
    BM[2].copy(BM[1]).multiply(T(0, 0.15, 0)).multiply(_m4.makeRotationFromEuler(e.set(p.side * 0.5, p.twist * 0.3, p.lean * 0.3, 'YXZ')));
    BM[3].copy(BM[2]).multiply(T(0, 0.33, 0));
    BM[4].copy(BM[3]).multiply(T(0, 0.13, 0)).multiply(_m4.makeRotationFromEuler(e.set(0, p.headYaw - p.twist, -p.headPitch * 0.6 - p.lean * 0.3, 'YXZ')));
    // legs
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const hip = V(0, -0.03, side * 0.11).applyMatrix4(BM[0]);
      const foot = this.feet[i].group;
      foot.updateMatrix();
      const footM = BM[i === 0 ? 7 : 10].multiplyMatrices(this.board.matrix, foot.matrix);
      const ankle = ANKLE.clone().applyMatrix4(footM);
      const pole = V(1, 0.1, i === 0 ? -0.35 : -0.12).normalize();
      const knee = V();
      const reach = solveIK(hip, ankle, this.thigh, this.shin, pole, knee);
      segMatrix(BM[i === 0 ? 5 : 8], hip, knee, pole);
      segMatrix(BM[i === 0 ? 6 : 9], knee, reach, pole);
    }
    // arms
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const sh = V(-0.005, 0.268, side * 0.2).applyMatrix4(BM[2]);
      const target = (i === 0 ? p.lh : p.rh).clone();
      target.y += breathe ? Math.sin(this.time * 1.7 + i) * 0.015 - ab * 0.18 : 0;
      target.x += ab * 0.06;
      const toT = V().subVectors(target, sh);
      const pole = V(-0.35, -0.6, side * 0.7).add(toT.multiplyScalar(-0.2)).normalize();
      const elbow = V();
      const hand = solveIK(sh, target, this.upperArm, this.foreArm, pole, elbow);
      const o = i === 0 ? 11 : 14;
      segMatrix(BM[o], sh, elbow, pole);
      segMatrix(BM[o + 1], elbow, hand, pole);
      segMatrix(BM[o + 2], hand, V().subVectors(hand, elbow).normalize().add(hand), pole);
    }
  }

  _applyBones() {
    for (let i = 0; i < this.bones.length; i++) this.boneMats[i].decompose(this.bones[i].position, this.bones[i].quaternion, _s);
  }

  update(dt, ctx = {}) {
    this.time += dt;
    const p = this.p, t = this.target;
    const k = ctx.fast ? 16 : 10;
    for (const key of ['hipH', 'hipX', 'hipZ', 'lean', 'side', 'twist', 'headYaw', 'headPitch', 'boardPitch', 'boardRoll', 'boardLift']) {
      p[key] = damp(p[key], t[key], k, dt);
    }
    this._boardMatrix();
    // hands follow their targets on a slightly under-damped spring (natural follow-through)
    const K = ctx.fast ? 260 : 150, C = 2 * Math.sqrt(K) * 0.72;
    const h = Math.min(dt, 1 / 30);
    for (let i = 0; i < 2; i++) {
      const pos = i === 0 ? p.lh : p.rh, vel = i === 0 ? this.lhv : this.rhv;
      vel.addScaledVector(_t.subVectors(this._handTarget(i), pos), K * h).multiplyScalar(Math.max(0, 1 - C * h));
      pos.addScaledVector(vel, h);
    }
    // landing absorption: knees soak up the impact and spring back
    this.absorbV += (-110 * this.absorb - 13 * this.absorbV) * h;
    this.absorb = Math.max(-0.2, Math.min(1.3, this.absorb + this.absorbV * h));
    const breathe = Math.sin(this.time * 2.2) * 0.008 + 1e-6;
    const vib = ctx.vibration || 0;
    const jitter = vib ? (Math.sin(this.time * 61) * 0.5 + Math.sin(this.time * 37) * 0.5) * vib * 0.012 : 0;
    this._solve(this.absorb, breathe, jitter);
    this._applyBones();

    // contact shadow
    if (ctx.shadow) {
      const sh = ctx.shadow;
      const hgt = Math.max(0, sh.h);
      this.blob.visible = hgt < 8;
      this.blob.position.copy(sh.p).addScaledVector(sh.n, 0.03);
      this.blob.quaternion.setFromUnitVectors(Y, sh.n).multiply(_q.setFromAxisAngle(Y, sh.yaw));
      const kk = 1 + hgt * 0.18;
      this.blob.scale.set(0.95 * kk, 1, 1.9 * kk);
      this.blob.material.opacity = 0.3 * Math.max(0, 1 - hgt / 8);
    } else {
      this.blob.visible = false;
    }

    // world-space strands
    if (this.pony || this.scarf) {
      this.root.updateMatrixWorld(true);
      const wind = ctx.wind || V();
      const head = this.bones[4], neck = this.bones[3];
      if (this.pony) {
        const anchor = V(-0.12, 0.04, 0).applyMatrix4(head.matrixWorld);
        const rest = V(-0.6, -1, 0).transformDirection(head.matrixWorld);
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
        const anchor = V(-0.07, 0.0, 0.02).applyMatrix4(neck.matrixWorld);
        const rest = V(-1, -1.2, 0.3).normalize().transformDirection(neck.matrixWorld);
        this.scarf.update(dt, anchor, rest, 6, wind);
        const side = V(0, 0, 1).transformDirection(neck.matrixWorld);
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
    this.disposed = true;
    const done = new Set();
    const disp = (o) => {
      if (o.geometry && !done.has(o.geometry) && !o.geometry.userData.cached) { o.geometry.dispose(); done.add(o.geometry); }
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m && !done.has(m)) { m.map?.dispose(); m.normalMap?.dispose(); m.dispose(); done.add(m); }
    };
    this.root.traverse(disp);
    this.extras.traverse(disp);
  }
}

// Bone matrix for a limb segment: origin at a, +Y towards b, +Z towards the bend side.
function segMatrix(out, a, b, bend) {
  _y.subVectors(b, a).normalize();
  _z.copy(bend).addScaledVector(_y, -bend.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
  _z.normalize();
  _x.crossVectors(_y, _z).normalize();
  out.makeBasis(_x, _y, _z);
  out.setPosition(a);
  return out;
}
