import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, clamp } from '../core/utils.js';
import { HALF_W, BANK_END, BANK_TOP, EDGE_U, BUILD_U } from './track.js';
import { GeoBuilder, bake } from './geom.js';
import {
  createSnowMaterial, createFacadeMaterial, createScreenMaterial, createSkyMaterial, sharedUniforms,
} from '../gfx/materials.js';
import { neonSignTexture, glowTexture, bannerTexture, vendingTexture } from '../gfx/textures.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

export class World {
  constructor(renderer, scene, stage, track, quality) {
    this.renderer = renderer;
    this.scene = scene;
    this.stage = stage;
    this.track = track;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'world';
    scene.add(this.group);
    this.rng = mulberry32(stage.seed * 7 + 3);
    this.lightSpots = []; // candidate positions for dynamic point lights
    this.glowPts = { pos: [], col: [], size: [] };
    this.groundGlows = []; // {s,u,y,size,color}
    this.wires = [];
    this.disposables = [];
    this.sideLamps = [];
    this.signals = [];

    this.mats = this._materials();
    this.sunDir = new THREE.Vector3(...stage.sky.sunDir).normalize();
    if (stage.sky.sunAlongTrack) {
      // "Manhattanhenge": the sun sets at the far end of the street
      const n = track.n - 1;
      const dx = track.px[n] - track.px[0], dz = track.pz[n] - track.pz[0];
      const l = Math.hypot(dx, dz);
      const off = stage.sky.sunAlongTrack;
      this.sunDir.set(dx / l - (dz / l) * off, stage.sky.sunDir[1], dz / l + (dx / l) * off).normalize();
    }
    this._buildSky();
    this._buildLights();
    this._buildTrack();
    this._buildEdges();
    this._buildBuildings();
    this._buildProps();
    this._buildFeatures();
    this._buildTokens();
    this._buildGates();
    this._finishGlows();
    this._buildEnv();
  }

  // ------------------------------------------------------------------ materials
  _materials() {
    const st = this.stage;
    const m = {
      snow: createSnowMaterial(st),
      facade: createFacadeMaterial(st),
      metal: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.95, roughness: 0.28 }),
      darkMetal: new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.7, roughness: 0.45 }),
      paint: new THREE.MeshStandardMaterial({ color: 0xffc21a, metalness: 0.3, roughness: 0.5 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0x8d8b88, roughness: 0.92 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 0.85 }),
      stone: new THREE.MeshStandardMaterial({ color: 0x77736e, roughness: 0.95 }),
      carBody: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.55, roughness: 0.32 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x0b1220, metalness: 0.9, roughness: 0.06 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9 }),
      vegetation: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9 }),
      plainSnow: new THREE.MeshStandardMaterial({ color: 0xf0f4ff, roughness: 0.8 }),
      wire: new THREE.LineBasicMaterial({ color: 0x0a0a0e, transparent: true, opacity: 0.85 }),
    };
    for (const k in m) this.disposables.push(m[k]);
    return m;
  }

  emissive(color, intensity = 2) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) });
    this.disposables.push(mat);
    return mat;
  }

  add(obj, { cast = false, receive = false } = {}) {
    obj.castShadow = cast;
    obj.receiveShadow = receive;
    this.group.add(obj);
    return obj;
  }

  // ------------------------------------------------------------------ sky & light
  _buildSky() {
    const geo = new THREE.SphereGeometry(1800, 48, 24);
    this.skyMat = createSkyMaterial(this.stage, this.sunDir);
    this.sky = new THREE.Mesh(geo, this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.group.add(this.sky);
    const f = this.stage.fog;
    this.scene.fog = new THREE.FogExp2(f.color, f.density);
    this.scene.background = new THREE.Color(f.color);
  }

  _buildLights() {
    const L = this.stage.light;
    this.hemi = new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemi);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(L.sun, L.sunIntensity);
    // keep the light from grazing too low for usable shadows
    const sd = this.sunDir.clone();
    sd.y = Math.max(sd.y, L.shadowElev ?? 0.32);
    this.shadowDir = sd.normalize();
    const q = this.quality;
    if (q.shadows) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      const c = this.sun.shadow.camera;
      c.left = -45; c.right = 45; c.top = 45; c.bottom = -45;
      c.near = 1; c.far = 400;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.04;
      this.sun.shadow.radius = 3;
    }
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    // pooled dynamic point lights near the rider
    this.pointLights = [];
    const n = q.pointLights;
    for (let i = 0; i < n; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 26, 2);
      this.group.add(pl);
      this.pointLights.push(pl);
    }
  }

  _buildEnv() {
    // Prefiltered environment from the sky + a ring of city lights.
    const envScene = new THREE.Scene();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.skyMat);
    envScene.add(sky);
    const rng = mulberry32(5);
    const cols = this.stage.city.neonColors;
    for (let i = 0; i < 40; i++) {
      const a = rng() * Math.PI * 2;
      const r = 60;
      const h = rng.range(2, 18);
      const b = new THREE.Mesh(
        new THREE.BoxGeometry(rng.range(3, 9), h, 2),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(rng.pick(cols)).multiplyScalar(this.stage.city.neon * 1.5 + 0.2) })
      );
      b.position.set(Math.cos(a) * r, h / 2 - 6, Math.sin(a) * r);
      b.lookAt(0, b.position.y, 0);
      envScene.add(b);
    }
    // snowy ground for reflections
    const ground = new THREE.Mesh(new THREE.CircleGeometry(90, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(this.stage.fog.color).multiplyScalar(1.4) }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -8;
    envScene.add(ground);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(envScene, 0.035);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = this.stage.id === 'golden' ? 0.9 : 0.75;
    pmrem.dispose();
    envScene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== this.skyMat) o.material.dispose(); });
  }

  // ------------------------------------------------------------------ track surface
  _lateralSamples() {
    const us = [];
    // outer sidewalk to coping
    for (let u = BUILD_U + 1; u > EDGE_U + 0.5; u -= 1.25) us.push(u);
    us.push(EDGE_U + 0.08);
    us.push(EDGE_U);
    // bank arc
    const nb = 12;
    for (let i = nb; i > 0; i--) {
      const a = (i / nb) * Math.asin(BANK_END / 6);
      us.push(HALF_W + 6 * Math.sin(a));
    }
    const step = this.quality.trackDetail > 1 ? 0.5 : 1.0;
    for (let u = HALF_W; u > 0.001; u -= step) us.push(u);
    const right = us.slice().reverse();
    return [...us.map((u) => -u), 0, ...right];
  }

  _buildTrack() {
    const tr = this.track;
    const us = this._lateralSamples();
    const nu = us.length;
    const ds = this.quality.trackDetail > 1 ? 0.5 : 1.0;
    const CH = 40;
    const sStart = -30;
    const sEnd = tr.length + 30;
    const f = {};
    for (let s0 = sStart; s0 < sEnd; s0 += CH) {
      const rows = Math.round(CH / ds);
      const H = new Float32Array((rows + 3) * nu);
      for (let r = -1; r <= rows + 1; r++) {
        const s = s0 + r * ds;
        for (let j = 0; j < nu; j++) H[(r + 1) * nu + j] = tr.height(s, us[j], false);
      }
      const nv = (rows + 1) * nu;
      const pos = new Float32Array(nv * 3);
      const nor = new Float32Array(nv * 3);
      const uv = new Float32Array(nv * 2);
      const col = new Float32Array(nv * 3);
      for (let r = 0; r <= rows; r++) {
        const s = s0 + r * ds;
        tr.frame(s, f);
        for (let j = 0; j < nu; j++) {
          const u = us[j];
          const i = r * nu + j;
          const h = H[(r + 1) * nu + j];
          pos[i * 3] = f.x + f.rx * u;
          pos[i * 3 + 1] = h;
          pos[i * 3 + 2] = f.z + f.rz * u;
          const gs = (H[(r + 2) * nu + j] - H[r * nu + j]) / (2 * ds);
          const j0 = Math.max(0, j - 1), j1 = Math.min(nu - 1, j + 1);
          const gu = (H[(r + 1) * nu + j1] - H[(r + 1) * nu + j0]) / (us[j1] - us[j0]);
          let nx = -gs * f.tx - gu * f.rx, ny = 1, nz = -gs * f.tz - gu * f.rz;
          const l = Math.hypot(nx, ny, nz);
          nor[i * 3] = nx / l; nor[i * 3 + 1] = ny / l; nor[i * 3 + 2] = nz / l;
          uv[i * 2] = u / 3;
          uv[i * 2 + 1] = s / 3;
          // baked ambient occlusion & subtle tint
          const au = Math.abs(u);
          let ao = 1;
          ao -= 0.12 * Math.exp(-Math.pow((au - HALF_W) / 0.9, 2));
          ao -= 0.28 * clamp((au - (BUILD_U - 1.6)) / 1.6, 0, 1);
          ao -= 0.05 * Math.exp(-Math.pow((au - EDGE_U - 0.4) / 0.4, 2));
          const blue = 0.02 * Math.sin(s * 0.05 + u * 0.3);
          col[i * 3] = ao * (0.98 - blue);
          col[i * 3 + 1] = ao * 0.99;
          col[i * 3 + 2] = ao * (1.0 + blue);
        }
      }
      const idx = [];
      for (let r = 0; r < rows; r++) {
        for (let j = 0; j < nu - 1; j++) {
          const a = r * nu + j, b = a + 1, c = a + nu, d = c + 1;
          idx.push(a, b, c, b, d, c);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.mats.snow);
      this.add(mesh, { receive: true });
    }
  }

  _pathTube(points, radius, material, radial = 6, opts = {}) {
    const curve = new THREE.CatmullRomCurve3(points);
    const geo = new THREE.TubeGeometry(curve, Math.max(4, points.length * 2), radius, radial, false);
    const mesh = new THREE.Mesh(geo, material);
    this.add(mesh, opts);
    return mesh;
  }

  _buildEdges() {
    const tr = this.track;
    const st = this.stage;
    // coping pipes and LED strips along the banks
    const ledColors = st.id === 'neon' ? [0x22e6ff, 0xff2d8a] : st.id === 'aurora' ? [0xff9a40, 0xff9a40] : null;
    for (const side of [-1, 1]) {
      const chunk = 160;
      for (let s0 = -30; s0 < tr.length + 30; s0 += chunk) {
        const pts = [], led = [];
        for (let s = s0; s <= s0 + chunk + 0.1; s += 4) {
          const y = tr.baseY(s) + BANK_TOP + 0.02;
          pts.push(tr.toWorld(s, side * (EDGE_U + 0.04), y));
          const ul = side * (EDGE_U - 0.35);
          led.push(tr.toWorld(s, ul, tr.baseY(s) + tr.lateral(ul) + 0.06));
        }
        this._pathTube(pts, 0.075, this.mats.metal, 6, { cast: false });
        if (ledColors) {
          this._pathTube(led, 0.035, this.emissive(ledColors[side > 0 ? 1 : 0], 3.2), 4);
        }
      }
      // Glow ribbon on the bank under the LED strip
      if (ledColors) this._bankGlow(side, ledColors[side > 0 ? 1 : 0]);
    }
  }

  _bankGlow(side, color) {
    const tr = this.track;
    const c = new THREE.Color(color);
    const pos = [], cols = [], idx = [];
    const lat = [];
    for (let i = 0; i <= 6; i++) lat.push(EDGE_U - 0.35 - (i / 6) * (BANK_END + 1.5));
    let row = 0;
    const n = V();
    for (let s = -30; s <= tr.length + 30; s += 3) {
      for (let j = 0; j < lat.length; j++) {
        const u = side * lat[j];
        const y = tr.baseY(s) + tr.lateral(u);
        tr.normal(s, u, n, false);
        const p = tr.toWorld(s, u, y).addScaledVector(n, 0.05);
        pos.push(p.x, p.y, p.z);
        const k = Math.pow(1 - j / (lat.length - 1), 1.6) * 0.55;
        cols.push(c.r * k, c.g * k, c.b * k);
      }
      if (row > 0) {
        const nl = lat.length;
        for (let j = 0; j < nl - 1; j++) {
          const a = (row - 1) * nl + j, b = a + 1, cc = a + nl, d = cc + 1;
          idx.push(a, cc, b, b, cc, d);
        }
      }
      row++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    this.disposables.push(m);
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 2;
    this.add(mesh);
  }

  // ------------------------------------------------------------------ buildings
  _box(gb, s, u0, w, d, y0, y1, groundY, fac, color, roof = true, opt = null) {
    // Box aligned with track at s, centered laterally at u0. Width w along track.
    // opt.fs: use the frame at fs (straight side streets), offset by opt.ds along it.
    const tr = this.track;
    const f = tr.frame(opt ? opt.fs : s, {});
    const T = V(f.tx, 0, f.tz), R = V(f.rx, 0, f.rz);
    const c = opt ? tr.toWorld(opt.fs, u0, 0).addScaledVector(T, opt.ds) : tr.toWorld(s, u0, 0);
    const corner = (a, b, y) => V(c.x + T.x * a + R.x * b, y, c.z + T.z * a + R.z * b);
    const hw = w / 2, hd = d / 2;
    const col = [color.r, color.g, color.b];
    const A = { color: col, aFacade: fac };
    const v0 = y0 - groundY, v1 = y1 - groundY;
    // four walls
    const faces = [
      [-hw, -hd, hw, -hd, R.clone().negate(), w], // -R side
      [hw, hd, -hw, hd, R.clone(), w], // +R side
      [-hw, hd, -hw, -hd, T.clone().negate(), d],
      [hw, -hd, hw, hd, T.clone(), d],
    ];
    for (const [a0, b0, a1, b1, out, len] of faces) {
      const p0 = corner(a0, b0, y0), p1 = corner(a1, b1, y0), p2 = corner(a1, b1, y1), p3 = corner(a0, b0, y1);
      gb.quad(p0, p1, p2, p3, [[0, v0], [len, v0], [len, v1], [0, v1]], A, out);
    }
    if (roof) {
      const R2 = { color: col, aFacade: [fac[0], fac[1], 0, 1] };
      gb.quad(corner(-hw, -hd, y1), corner(hw, -hd, y1), corner(hw, hd, y1), corner(-hw, hd, y1), [[0, 0], [1, 0], [1, 1], [0, 1]], R2, UP);
    }
    return { T, R, c, corner };
  }

  _gable(gb, s, u0, w, d, y1, rise, color, seed, opt = null) {
    const tr = this.track;
    const f = tr.frame(opt ? opt.fs : s, {});
    const T = V(f.tx, 0, f.tz), R = V(f.rx, 0, f.rz);
    const c = opt ? tr.toWorld(opt.fs, u0, 0).addScaledVector(T, opt.ds) : tr.toWorld(s, u0, 0);
    const P = (a, b, y) => V(c.x + T.x * a + R.x * b, y, c.z + T.z * a + R.z * b);
    const ov = 0.7;
    const hw = w / 2 + ov, hd = d / 2 + ov;
    const snowA = { color: [1, 1, 1], aFacade: [2, seed, 0, 1] };
    const wallA = { color: [color.r, color.g, color.b], aFacade: [2, seed, 0, 0] };
    const yr = y1 + rise, ye = y1 - 0.25;
    // two roof planes (ridge along T)
    gb.quad(P(-hw, -hd, ye), P(hw, -hd, ye), P(hw, 0, yr), P(-hw, 0, yr), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(R.x * -1, 1, R.z * -1));
    gb.quad(P(-hw, hd, ye), P(-hw, 0, yr), P(hw, 0, yr), P(hw, hd, ye), [[0, 0], [1, 0], [1, 1], [0, 1]], snowA, V(R.x, 1, R.z));
    // underside of eaves (dark wood)
    const woodA = { color: [0.12, 0.08, 0.06], aFacade: [1, seed, 0, 0] };
    gb.quad(P(-hw, -hd, ye - 0.15), P(hw, -hd, ye - 0.15), P(hw, hd, ye - 0.15), P(-hw, hd, ye - 0.15), [[0, -9], [1, -9], [1, -9], [0, -9]], woodA, V(0, -1, 0));
    // eave thickness edges
    gb.quad(P(-hw, -hd, ye - 0.15), P(hw, -hd, ye - 0.15), P(hw, -hd, ye), P(-hw, -hd, ye), [[0, -9], [1, -9], [1, -9], [0, -9]], woodA, R.clone().negate());
    gb.quad(P(-hw, hd, ye - 0.15), P(hw, hd, ye - 0.15), P(hw, hd, ye), P(-hw, hd, ye), [[0, -9], [1, -9], [1, -9], [0, -9]], woodA, R.clone());
    // gables
    const g0 = w / 2;
    gb.tri(P(-g0, -d / 2, y1), P(-g0, d / 2, y1), P(-g0, 0, yr - 0.2), [[0, 50], [d, 50], [d / 2, 50]], wallA, T.clone().negate());
    gb.tri(P(g0, -d / 2, y1), P(g0, d / 2, y1), P(g0, 0, yr - 0.2), [[0, 50], [d, 50], [d / 2, 50]], wallA, T.clone());
  }

  _buildBuildings() {
    const tr = this.track;
    const st = this.stage;
    const rng = this.rng;
    const city = st.city;
    const CH = 120;
    const chunks = new Map();
    const getGB = (s) => {
      const k = Math.floor(s / CH);
      if (!chunks.has(k)) chunks.set(k, new GeoBuilder({ color: 3, aFacade: 4 }));
      return chunks.get(k);
    };
    this.getGB = getGB;
    const styleId = { glass: 0, concrete: 1, old: 2, tower: 3, shop: 4 };
    this.frontBuildings = [];
    const wallColor = () => {
      const c = new THREE.Color(rng.pick(city.wall));
      c.multiplyScalar(rng.range(0.8, 1.25));
      return c;
    };

    // cross streets: open corridors that let you look down side streets
    this.crossings = [];
    for (let c = 90 + rng.range(0, 60); c < tr.length - 40; c += rng.range(130, 210)) {
      this.crossings.push({ s: c, w: st.id === 'aurora' ? 11 : 16 });
    }
    const inCorridor = (a, b0, pad = 0) => this.crossings.some((c) => b0 > c.s - c.w / 2 - pad && a < c.s + c.w / 2 + pad);
    const corridorEnd = (s0) => {
      const c = this.crossings.find((c) => s0 < c.s + c.w / 2 && s0 + 1 > c.s - c.w / 2 - 40);
      return c ? c.s + c.w / 2 + 0.2 : s0;
    };

    for (const side of [-1, 1]) {
      let s = -40;
      while (s < tr.length + 40) {
        const style = rng.pick(city.styles);
        const old = style === 'old';
        let w = old ? rng.range(7, 12) : rng.range(14, 30);
        // stop at the edge of a cross street
        const cNext = this.crossings.find((c) => c.s - c.w / 2 > s - 0.01 && c.s - c.w / 2 < s + w + 6);
        if (cNext) {
          const room = cNext.s - cNext.w / 2 - s;
          if (room < 5) { s = cNext.s + cNext.w / 2; continue; }
          w = Math.min(w, room);
        }
        const d = old ? rng.range(9, 13) : rng.range(14, 26);
        let H = rng.range(city.height[0], city.height[1]);
        if (!old && rng() < 0.15) H *= 1.5;
        if (old) H = Math.max(city.height[0], Math.round(H / 3) * 3);
        const sm = s + w / 2;
        const groundY = tr.baseY(sm) + BANK_TOP + 0.15;
        const y0 = Math.min(tr.baseY(s), tr.baseY(s + w)) + BANK_TOP - 3;
        const y1 = groundY + H;
        const seed = rng();
        const lit = clamp(city.lit * rng.range(0.6, 1.4), 0, 0.95);
        const fac = [styleId[style], seed, lit, 0];
        const col = style === 'glass' || style === 'tower' ? new THREE.Color(rng.pick(city.wall)).multiplyScalar(0.7) : wallColor();
        const gb = getGB(sm);
        const u0 = side * (BUILD_U + d / 2);
        this._box(gb, sm, u0, w, d, y0, y1, groundY, fac, col, !old);
        const b = { s, w, d, H, side, style, groundY, sm, u0, y1, seed, col };
        if (old) {
          this._gable(gb, sm, u0, w, d, y1, rng.range(2.2, 3.4), col, seed);
        }
        this._details(gb, b, rng);
        this.frontBuildings.push(b);
        s += w + (rng() < 0.18 ? rng.range(2.5, 6) : 0.15);
      }

      // second and far rows (skyline depth)
      if (st.id !== 'aurora') {
        let s2 = -60;
        while (s2 < tr.length + 60) {
          const w = rng.range(18, 34), d = rng.range(18, 30);
          if (inCorridor(s2, s2 + w, 1)) { s2 = corridorEnd(s2) + 1; continue; }
          const H = rng.range(city.height[0], city.height[1]) * rng.range(1.0, 1.8);
          const sm = s2 + w / 2;
          const groundY = tr.baseY(sm) + BANK_TOP;
          const u0 = side * (BUILD_U + 30 + d / 2 + rng.range(0, 10));
          const style = rng.pick(city.styles);
          const gb = getGB(sm);
          const seed = rng();
          this._box(gb, sm, u0, w, d, groundY - 20, groundY + H, groundY, [styleId[style] ?? 1, seed, city.lit, 0], new THREE.Color(rng.pick(city.wall)).multiplyScalar(0.8), true);
          this._roofClutter(gb, { sm, u0, w, d, y1: groundY + H, seed, H, side }, rng);
          s2 += w + rng.range(4, 14);
        }
      }
      let s3 = -100;
      while (s3 < tr.length + 100) {
        const w = rng.range(25, 50), d = rng.range(25, 45);
        const far = st.id === 'aurora' ? rng.range(45, 90) : rng.range(80, 240);
        if (inCorridor(s3, s3 + w, 2)) { s3 = corridorEnd(s3) + 2; continue; }
        const Hs = st.id === 'aurora' ? rng.range(6, 14) : rng.range(city.height[0], city.height[1]) * rng.range(1.2, 2.6);
        const sm = s3 + w / 2;
        const groundY = tr.baseY(sm) - 5;
        const u0 = side * (BUILD_U + far);
        const style = rng.pick(city.styles);
        const gb = getGB(sm);
        this._box(gb, sm, u0, w, d, groundY - 40, groundY + Hs, groundY, [styleId[style] ?? 1, rng(), city.lit * 1.1, 0], new THREE.Color(rng.pick(city.wall)).multiplyScalar(0.7), true);
        if (style === 'old') this._gable(gb, sm, u0, w, d, groundY + Hs, 4, new THREE.Color(rng.pick(city.wall)), rng());
        s3 += w + rng.range(5, 30);
      }
    }

    for (const c of this.crossings) this._crossStreet(c, rng, styleId, wallColor);
    this._buildStructures(rng);
    if (st.id !== 'aurora') this._buildTraffic(rng);

    for (const gb of chunks.values()) {
      const mesh = new THREE.Mesh(gb.build(), this.mats.facade);
      this.add(mesh, { cast: this.quality.shadows, receive: true });
    }

    if (st.id === 'aurora') this._buildMountains();
    this._buildSigns();
  }

  // Facade and roof detail for a front-row building.
  _details(gb, b, rng) {
    const { sm, w, d, side, groundY, y1, style, H, seed } = b;
    const plain = [5, seed, 0, 0];
    const front = side * BUILD_U; // street-facing wall
    const inset = (x) => side * (BUILD_U - x);
    const pal = [0x8a8f96, 0xb9b4aa, 0x6f7680, 0xd2d4d6, 0x9a8c7c];
    const slabCol = new THREE.Color(rng.pick(pal));
    if (style === 'old') {
      // eaves over the ground floor (snow on top) and a hanging lantern rail
      this._box(gb, sm, inset(0.65), w - 0.2, 1.3, groundY + 3.0, groundY + 3.22, groundY, plain, new THREE.Color(0x2a1d16), true);
      if (rng() < 0.5) this._box(gb, sm, inset(0.1), w * 0.7, 0.2, groundY + 3.6, groundY + 4.4, groundY, plain, new THREE.Color(0x1a1412), false);
      return;
    }
    // cornice + thick snow cap
    this._box(gb, sm, b.u0, w + 0.7, d + 0.7, y1 - 0.5, y1, groundY, plain, b.col.clone().multiplyScalar(0.8), false);
    this._box(gb, sm, b.u0, w + 0.8, d + 0.8, y1, y1 + 0.32, y1, [1, seed, 0, 1], b.col, true);
    // shop canopy over the ground floor
    if (style === 'shop' || style === 'concrete') {
      const awn = new THREE.Color(rng.pick([0x7a1c18, 0x1f3b6b, 0x245a3a, 0x3a3a3f, 0x8a6a20]));
      this._box(gb, sm, inset(0.75), w - 0.5, 1.5, groundY + 3.95, groundY + 4.2, groundY, plain, awn, true);
    }
    // balconies with AC units (apartment blocks)
    if (style === 'concrete' && rng() < 0.6) {
      const floors = Math.floor((H - 5) / 3.2);
      const panel = new THREE.Color(rng.pick([0xc8ccd0, 0x9aa4ae, 0x707a84, 0xd8d0c0]));
      for (let k = 1; k <= floors; k++) {
        const yb = groundY + 4.4 + k * 3.2 - 0.05;
        this._box(gb, sm, inset(0.55), w - 0.6, 1.1, yb - 0.16, yb, groundY, plain, slabCol, true);
        this._box(gb, sm, inset(1.07), w - 0.6, 0.07, yb, yb + 1.0, groundY, plain, panel, true);
        const units = Math.max(1, Math.floor((w - 1) / 3.2));
        for (let i = 0; i < units; i++) {
          if (rng() < 0.45) {
            const so = sm - (w - 0.6) / 2 + (i + 0.5) * ((w - 0.6) / units) + rng.range(-0.6, 0.6);
            this._box(gb, so, inset(0.35), 0.8, 0.32, yb, yb + 0.58, groundY, plain, new THREE.Color(0xd8dadc), true);
          }
          // dividers between flats
          if (i > 0) {
            const so = sm - (w - 0.6) / 2 + i * ((w - 0.6) / units);
            this._box(gb, so, inset(0.55), 0.06, 1.0, yb, yb + 1.9, groundY, plain, panel, false);
          }
        }
      }
    } else if (style !== 'glass' && style !== 'tower') {
      // window AC units hung on the facade
      const rows = Math.min(8, Math.floor((H - 6) / 3.2));
      for (let k = 1; k <= rows; k++) {
        const n = Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const so = sm + rng.range(-w / 2 + 1, w / 2 - 1);
          const yb = groundY + 4.4 + k * 3.2 + 0.15;
          this._box(gb, so, inset(0.2), 0.8, 0.36, yb, yb + 0.58, groundY, plain, new THREE.Color(0xc9cbcd), true);
        }
      }
    } else if (rng() < 0.6) {
      // vertical fins on glass towers
      const n = Math.floor(w / 4.4);
      for (let i = 0; i <= n; i++) {
        const so = sm - w / 2 + (i / Math.max(1, n)) * w;
        this._box(gb, so, inset(0.25), 0.18, 0.5, groundY + 4.0, y1 - 0.5, groundY, plain, b.col.clone().multiplyScalar(0.6), true);
      }
    }
    void front;
    this._roofClutter(gb, b, rng);
  }

  // Parapets, water tanks, plant rooms, antennas.
  _roofClutter(gb, b, rng) {
    const { sm, u0, w, d, y1, seed } = b;
    const plain = [5, seed, 0, 0];
    const yr = y1 + 0.3;
    const pcol = new THREE.Color(0x6c6f74);
    // parapet ring
    this._box(gb, sm, u0 - (d / 2 - 0.15), w, 0.3, yr, yr + 1.0, yr, plain, pcol, true);
    this._box(gb, sm, u0 + (d / 2 - 0.15), w, 0.3, yr, yr + 1.0, yr, plain, pcol, true);
    this._box(gb, sm - (w / 2 - 0.15), u0, 0.3, d - 0.6, yr, yr + 1.0, yr, plain, pcol, true);
    this._box(gb, sm + (w / 2 - 0.15), u0, 0.3, d - 0.6, yr, yr + 1.0, yr, plain, pcol, true);
    // water tank on legs
    if (rng() < 0.6) {
      const ts = sm + rng.range(-w / 4, w / 4), tu = u0 + rng.range(-d / 4, d / 4);
      this._box(gb, ts, tu, 2.2, 2.2, yr, yr + 1.0, yr, plain, new THREE.Color(0x3a3d42), false);
      this._box(gb, ts, tu, 2.6, 2.6, yr + 1.0, yr + 3.2, yr, plain, new THREE.Color(rng.pick([0xa7b0b8, 0x5d7f9a, 0xd0c8b0])), true);
    }
    // plant room / stair house
    if (rng() < 0.7) {
      const pw = rng.range(3, 6);
      this._box(gb, sm + rng.range(-w / 4, w / 4), u0 + rng.range(-d / 4, d / 4), pw, pw * 0.8, yr, yr + rng.range(2.4, 3.4), yr, plain, new THREE.Color(0x8b8d90), true);
    }
    // AC condensers
    const n = Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) this._box(gb, sm + rng.range(-w / 3, w / 3), u0 + rng.range(-d / 3, d / 3), 1.2, 0.8, yr, yr + 1.0, yr, plain, new THREE.Color(0xc2c4c6), true);
    // antenna mast on tall buildings
    if (b.H > 55 && rng() < 0.5) {
      this._box(gb, sm, u0, 0.35, 0.35, yr, yr + rng.range(8, 16), yr, plain, new THREE.Color(0xb0b0b0), false);
    }
  }

  // Elevated railway with a moving train, and pedestrian footbridges.
  _buildStructures(rng) {
    const tr = this.track;
    const st = this.stage;
    const plain = [5, 0.5, 0, 0];
    const gAt = (ss) => tr.baseY(ss) + BANK_TOP + 0.15;
    const steel = new THREE.Color(st.id === 'golden' ? 0x6d7480 : 0x56606a);
    if (st.id !== 'aurora' && this.crossings.length > 2) {
      const c = this.crossings[Math.floor(this.crossings.length / 2)];
      const gb = this.getGB(c.s);
      const yD = gAt(c.s) + 9.5;
      const L = 640;
      const conc = new THREE.Color(0x8c8a86);
      this._box(gb, c.s, 0, 9, L, yD - 1.5, yD, yD, plain, conc, true);
      // rails and catenary masts
      const vo = (ds) => ({ fs: c.s, ds });
      this._box(gb, c.s - 4.35, 0, 0.3, L, yD, yD + 1.2, yD, plain, conc, true, vo(-4.35));
      this._box(gb, c.s + 4.35, 0, 0.3, L, yD, yD + 1.2, yD, plain, conc, true, vo(4.35));
      for (const off of [-2.6, -1.4, 1.4, 2.6]) this._box(gb, c.s + off, 0, 0.12, L, yD, yD + 0.2, yD, plain, new THREE.Color(0x2a2a2a), false, vo(off));
      for (let u = -L / 2 + 10; u < L / 2; u += 26) {
        this._box(gb, c.s - 4.0, u, 0.25, 0.25, yD, yD + 6.2, yD, plain, steel, false, vo(-4.0));
        this._box(gb, c.s, u, 8.4, 0.2, yD + 6.0, yD + 6.25, yD, plain, steel, false, vo(0));
        // piers outside the main street
        if (Math.abs(u) > BUILD_U + 6) this._box(gb, c.s, u, 2.4, 2.4, gAt(c.s) - 3, yD - 1.5, gAt(c.s), plain, conc, false, vo(0));
        const p = tr.toWorld(c.s, u, yD - 1.7);
        this.glowPts.pos.push(p.x, p.y, p.z);
        this.glowPts.col.push(0.35, 0.33, 0.3);
        this.glowPts.size.push(2.2);
      }
      this.lightSpots.push({ p: tr.toWorld(c.s, 0, yD - 2), color: new THREE.Color(0xffe0b0), power: 40 });
      // the train
      const group = new THREE.Group();
      const body = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.75, roughness: 0.3 });
      const winMat = this.emissive(st.id === 'golden' ? 0xffe2b8 : 0xfff0d0, st.id === 'golden' ? 0.7 : 1.15);
      const doorMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, metalness: 0.6, roughness: 0.4, emissive: new THREE.Color(0xfff0d0), emissiveIntensity: 0.25 });
      this.disposables.push(doorMat);
      const stripe = new THREE.MeshStandardMaterial({ color: st.id === 'golden' ? 0xf08a1c : 0x3cb84a, roughness: 0.4 });
      this.disposables.push(body, stripe);
      const cars = 7;
      for (let i = 0; i < cars; i++) {
        const x = (i - (cars - 1) / 2) * 20.2;
        const car = new THREE.Mesh(new RoundedBoxGeometry(19.8, 3.4, 2.9, 2, 0.25), body);
        car.position.set(x, 2.25, 0);
        // separate windows with doors between them
        for (let k = 0; k < 8; k++) {
          const wx = x - 8.4 + k * 2.4;
          const door = k === 2 || k === 5;
          const win = new THREE.Mesh(new THREE.BoxGeometry(door ? 1.3 : 1.9, door ? 2.2 : 0.95, 2.96), door ? doorMat : winMat);
          win.position.set(wx, door ? 2.25 : 2.75, 0);
          group.add(win);
        }
        const str = new THREE.Mesh(new THREE.BoxGeometry(19.82, 0.28, 2.92), stripe);
        str.position.set(x, 1.65, 0);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(19.2, 0.16, 2.6), this.mats.plainSnow);
        roof.position.set(x, 4.0, 0);
        group.add(car, str, roof);
      }
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), this.emissive(0xffffff, 4));
      head.position.set(((cars - 1) / 2) * 20.2 + 10, 2.0, 0);
      group.add(head);
      group.traverse((o) => { if (o.isMesh) o.castShadow = this.quality.shadows; });
      group.quaternion.setFromAxisAngle(UP, tr.yawAt(c.s));
      this.add(group);
      const f = tr.frame(c.s, {});
      this.train = { group, origin: this._side(c.s, -2, 0, yD), dir: new THREE.Vector3(f.rx, 0, f.rz), speed: 22, loop: 900 };
    }

    // pedestrian footbridges over the main street (Tokyo style)
    if (st.id === 'neon' || st.id === 'golden') {
      const spots = [];
      for (const target of [0.3, 0.68]) {
        let s0 = tr.length * target;
        for (let k = 0; k < 40; k++) {
          const clear = !tr.kickers.some((f) => s0 > f.s0 - 25 && s0 < f.s1 + 25) && !this.crossings.some((c) => Math.abs(c.s - s0) < 25) && !tr.drops.some((d) => Math.abs(d.s - s0) < 30);
          if (clear) break;
          s0 += 7;
        }
        spots.push(s0);
      }
      const blue = new THREE.Color(0x2f6fb0);
      for (const b of spots) {
        const gb = this.getGB(b);
        const yb = gAt(b) + 5.0;
        const span = (BUILD_U - 0.6) * 2;
        this._box(gb, b, 0, 3.2, span, yb - 0.65, yb, yb, plain, steel, true);
        this._box(gb, b - 1.55, 0, 0.12, span, yb, yb + 1.2, yb, plain, blue, true);
        this._box(gb, b + 1.55, 0, 0.12, span, yb, yb + 1.2, yb, plain, blue, true);
        for (const side of [-1, 1]) {
          for (const ds of [-1.2, 1.2]) this._box(gb, b + ds, side * (EDGE_U + 1.2), 0.45, 0.45, gAt(b + ds) - 1, yb - 0.65, gAt(b), plain, steel, false);
          // stairs down onto the pavement
          const n = 14;
          const uS = side * (BUILD_U - 1.3);
          for (let i = 0; i < n; i++) {
            const ss = b + 1.6 + i * 0.62;
            const top = yb - ((i + 1) / n) * (yb - gAt(b + 1.6 + n * 0.62));
            this._box(gb, ss + 0.31, uS, 0.62, 1.8, gAt(ss) - 0.5, top, gAt(ss), plain, steel, true);
          }
          this._box(gb, b + 1.6 + n * 0.31, uS + side * 0.95, n * 0.62, 0.08, gAt(b + 6) , yb + 0.9, gAt(b), plain, blue, false);
        }
        // direction sign on the railing
        const tex = bannerTexture(st.id === 'golden' ? 'CENTRAL STA.  中央駅 →' : '新宿駅  SHINJUKU STA. →', [0x1d4fa0, 0x245cb8], 0xffffff);
        const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(0.9, 0.9, 0.9), side: THREE.DoubleSide });
        this.disposables.push(mat, tex);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 9 * 0.1875), mat);
        sign.position.copy(tr.toWorld(b - 1.63, 0, yb + 0.25));
        sign.rotation.y = tr.yawAt(b);
        this.add(sign);
        for (const u of [-6, 0, 6]) {
          const p = tr.toWorld(b, u, yb - 0.75);
          this.glowPts.pos.push(p.x, p.y, p.z);
          this.glowPts.col.push(0.45, 0.45, 0.42);
          this.glowPts.size.push(1.6);
          this.lightSpots.push({ p, color: new THREE.Color(0xfff2d8), power: 12 });
        }
      }
    }
  }

  // Point on a straight side street: frame of the main track at s, offset ds along it.
  _side(s, ds, u, y, out = new THREE.Vector3()) {
    const f = this.track.frame(s, {});
    return this.track.toWorld(s, u, y, out).add(V(f.tx * ds, 0, f.tz * ds));
  }

  // Cars driving up and down the side streets, with head and tail lights.
  _buildTraffic(rng) {
    const tr = this.track;
    const cars = [];
    for (const c of this.crossings) {
      for (const side of [-1, 1]) {
        for (const lane of [-1, 1]) {
          if (rng() < 0.25) continue;
          const f = tr.frame(c.s, {});
          cars.push({
            s: c.s + lane * 2.2, cs: c.s, side, lane,
            gY: tr.baseY(c.s + lane * 2.2) + BANK_TOP + 0.15,
            speed: rng.range(7, 13), phase: rng() * 200, len: 190,
            R: new THREE.Vector3(f.rx, 0, f.rz), yaw: tr.yawAt(c.s),
            color: new THREE.Color(rng.pick([0xb8261e, 0x1d3f8a, 0xe8e8e8, 0x1a1a1f, 0xf2c20f, 0x8a8f99])),
          });
        }
      }
    }
    if (!cars.length) return;
    const body = new RoundedBoxGeometry(4.3, 1.0, 1.85, 2, 0.18).translate(0, 0.75, 0);
    const cab = new RoundedBoxGeometry(2.2, 0.6, 1.6, 2, 0.15).translate(-0.2, 1.5, 0);
    const bodyMat = new THREE.MeshStandardMaterial({ metalness: 0.6, roughness: 0.3 });
    this.disposables.push(bodyMat);
    this.trafficBody = new THREE.InstancedMesh(body, bodyMat, cars.length);
    this.trafficCab = new THREE.InstancedMesh(cab, this.mats.glass, cars.length);
    cars.forEach((c, i) => this.trafficBody.setColorAt(i, c.color));
    for (const m of [this.trafficBody, this.trafficCab]) { m.frustumCulled = false; this.group.add(m); }
    const n = cars.length * 2;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    cars.forEach((c, i) => {
      // driving away from the main street shows tail lights, towards it head lights
      const away = c.side * c.lane > 0;
      const lc = away ? [0.9, 0.08, 0.04] : [0.95, 0.9, 0.75];
      for (let k = 0; k < 2; k++) { col.set(lc, (i * 2 + k) * 3); size[i * 2 + k] = away ? 1.0 : 1.6; }
      c.away = away;
    });
    this.trafficLights = new THREE.Points(g, null);
    this.trafficLights.frustumCulled = false;
    this.traffic = cars;
    this._trafficM = new THREE.Matrix4();
  }

  _updateTraffic(t) {
    const cars = this.traffic;
    if (!cars) return;
    if (!this.trafficLights.material) {
      this.trafficLights.material = this.glowMat;
      this.group.add(this.trafficLights);
    }
    const m = this._trafficM;
    const q = new THREE.Quaternion();
    const pos = this.trafficLights.geometry.attributes.position;
    const tr = this.track;
    cars.forEach((c, i) => {
      const d = (t * c.speed + c.phase) % c.len;
      const u = c.away ? BUILD_U + 4 + d : BUILD_U + 4 + c.len - d;
      const p = this._side(c.cs, c.lane * 2.2, c.side * u, c.gY);
      // car faces along +/-R
      const dirSign = c.away ? c.side : -c.side;
      q.setFromAxisAngle(UP, c.yaw + (dirSign > 0 ? 0 : Math.PI));
      m.compose(p, q, V(1, 1, 1));
      this.trafficBody.setMatrixAt(i, m);
      this.trafficCab.setMatrixAt(i, m);
      // lights at the end facing the main street
      const toMain = -c.side;
      for (let k = 0; k < 2; k++) {
        const lp = this._side(c.cs, c.lane * 2.2 + (k ? 0.7 : -0.7), c.side * (u + toMain * 2.2), c.gY + 0.8);
        pos.setXYZ(i * 2 + k, lp.x, lp.y, lp.z);
      }
    });
    this.trafficBody.instanceMatrix.needsUpdate = true;
    this.trafficCab.instanceMatrix.needsUpdate = true;
    pos.needsUpdate = true;
  }

  // Side street: buildings, ground, lamps and traffic signals.
  _crossStreet(c, rng, styleId, wallColor) {
    const tr = this.track;
    const st = this.stage;
    const city = st.city;
    const gAt = (ss) => tr.baseY(ss) + BANK_TOP + 0.15;
    const half = c.w / 2;
    const reach = st.id === 'aurora' ? 90 : 220;
    const f = tr.frame(c.s, {});
    for (const side of [-1, 1]) {
      // buildings lining both sides of the side street
      for (const sd of [-1, 1]) {
        let u = BUILD_U + 0.5;
        while (u < reach) {
          const front = rng.range(14, 28), depth = rng.range(14, 22);
          const style = rng.pick(city.styles);
          const old = style === 'old';
          const H = old ? rng.range(7, 13) : rng.range(city.height[0], city.height[1]) * rng.range(0.7, 1.3);
          const sm = c.s + sd * (half + depth / 2);
          const u0 = side * (u + front / 2);
          const gb = this.getGB(sm);
          const seed = rng();
          const col = wallColor();
          const gY = gAt(sm);
          const opt = { fs: c.s, ds: sd * (half + depth / 2) };
          this._box(gb, sm, u0, depth, front, gY - 8, gY + H, gY, [styleId[style], seed, clamp(city.lit * rng.range(0.7, 1.3), 0, 0.95), 0], col, !old, opt);
          if (old) this._gable(gb, sm, u0, depth, front, gY + H, 2.6, col, seed, opt);
          else this._box(gb, sm, u0, depth + 0.6, front + 0.6, gY + H, gY + H + 0.3, gY + H, [1, seed, 0, 1], col, true, opt);
          u += front + rng.range(0.2, 3);
        }
      }
      // snowy ground of the side street
      const pos = [], idx = [], col = [], uv = [];
      const steps = Math.ceil((reach - BUILD_U) / 6);
      for (let i = 0; i <= steps; i++) {
        const u = side * (BUILD_U - 1 + i * 6);
        for (const sd of [-1, 1]) {
          const ss = c.s + sd * (half + 0.6);
          const p = this._side(c.s, sd * (half + 0.6), u, gAt(ss) - 0.06);
          pos.push(p.x, p.y, p.z);
          const k = 0.92 - 0.1 * Math.abs(sd);
          col.push(k, k, k * 1.02);
          uv.push(u / 3, (c.s + sd * half) / 3);
        }
        if (i > 0) {
          const a = (i - 1) * 2;
          if (side > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      // make sure it faces up
      if (g.attributes.normal.getY(0) < 0) {
        const ia = g.index.array;
        for (let i = 0; i < ia.length; i += 3) { const t = ia[i + 1]; ia[i + 1] = ia[i + 2]; ia[i + 2] = t; }
        g.computeVertexNormals();
      }
      this.add(new THREE.Mesh(g, this.mats.snow), { receive: true });
      // receding street lights
      for (let u = BUILD_U + 12; u < reach; u += 22) {
        for (const sd of [-1, 1]) {
          const p = this._side(c.s, sd * (half - 1.2), side * u, gAt(c.s + sd * (half - 1.2)) + 5.6);
          this.glowPts.pos.push(p.x, p.y, p.z);
          const lc = new THREE.Color(city.lamp).multiplyScalar(0.5);
          this.glowPts.col.push(lc.r, lc.g, lc.b);
          this.glowPts.size.push(3.0);
          this.sideLamps.push(p);
        }
      }
      // traffic signal on the corner facing the rider
      if (st.id !== 'aurora') {
        const sp = c.s - half - 1.2;
        const base = tr.toWorld(sp, side * (EDGE_U + 1.4), gAt(sp));
        this.signals.push({ base, yaw: tr.yawAt(sp), side, s: sp });
      }
    }
    void f;
  }

  _aviation(s, u, y) {
    const p = this.track.toWorld(s, u, y + 1.5);
    (this.aviation ||= []).push(p);
  }

  _buildMountains() {
    const tr = this.track;
    const rng = mulberry32(77);
    const cx = (tr.px[0] + tr.px[tr.n - 1]) / 2, cz = (tr.pz[0] + tr.pz[tr.n - 1]) / 2;
    const yb = tr.baseY(tr.length) - 60;
    const geos = [];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + rng() * 0.2;
      const r = rng.range(1100, 1400);
      const h = rng.range(220, 520);
      const g = new THREE.ConeGeometry(rng.range(260, 420), h, 7, 6);
      const pos = g.attributes.position;
      const col = [];
      for (let k = 0; k < pos.count; k++) {
        const y = pos.getY(k);
        const t = (y + h / 2) / h;
        pos.setX(k, pos.getX(k) * (1 + (rng() - 0.5) * 0.25 * (1 - t)));
        pos.setZ(k, pos.getZ(k) * (1 + (rng() - 0.5) * 0.25 * (1 - t)));
        const snow = t > 0.45 ? 1 : 0.35;
        col.push(0.75 * snow + 0.1, 0.8 * snow + 0.12, 0.9 * snow + 0.18);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      const m = new THREE.Matrix4().makeTranslation(cx + Math.cos(a) * r, yb + h / 2 - 30, cz + Math.sin(a) * r);
      geos.push(bake(g, m));
      g.dispose();
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    this.disposables.push(mat);
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    // Mountains sit beyond the fog range; fade them with a lighter fog via onBeforeCompile
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `
        #ifdef USE_FOG
          float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * 0.04);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fogF, 0.0, 0.85));
        #endif`);
    };
    this.add(mesh);
  }

  // ------------------------------------------------------------------ signs & screens
  _buildSigns() {
    const tr = this.track;
    const st = this.stage;
    const city = st.city;
    const rng = mulberry32(st.seed + 99);
    const texCache = new Map();
    const groups = new Map(); // material -> geometries
    const getTex = (text, color, vertical) => {
      const key = text + color + vertical;
      if (!texCache.has(key)) texCache.set(key, neonSignTexture(text, color, vertical, rng.int(1, 9999)));
      return texCache.get(key);
    };
    const addPlane = (tex, color, w, h, mtx, intensity) => {
      const key = tex.map.uuid;
      if (!groups.has(key)) {
        const mat = new THREE.MeshBasicMaterial({ map: tex.map, color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide });
        this.disposables.push(mat, tex.map);
        groups.set(key, { mat, geos: [] });
      }
      const g = new THREE.PlaneGeometry(w, h);
      g.applyMatrix4(mtx);
      groups.get(key).geos.push(g);
    };
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = V(1, 1, 1);
    const neonAmt = city.neon;

    for (const b of this.frontBuildings) {
      if (b.s < 0 || b.s > tr.length) continue;
      if (b.style === 'glass' || b.style === 'tower') {
        if (rng() > neonAmt * 0.35) continue;
      }
      const n = Math.round(rng() * 3 * neonAmt + (neonAmt > 0.5 ? 0.6 : 0));
      for (let i = 0; i < n; i++) {
        const text = rng.pick(city.signs);
        const color = rng.pick(city.neonColors);
        const vertical = rng() < 0.62;
        const tex = getTex(text, color, vertical);
        const s = b.s + rng.range(1, Math.max(1.5, b.w - 1));
        if (vertical) {
          const w = rng.range(1.1, 1.6);
          const h = w / tex.aspect;
          const maxY = Math.max(5, b.H - h - 1);
          const y = b.groundY + 4.5 + rng() * Math.min(maxY - 4.5, 14) + h / 2;
          const u = b.side * (BUILD_U - w / 2 - 0.2);
          const p = tr.toWorld(s, u, y);
          // plane normal faces uphill toward the approaching rider (-T)
          q.setFromAxisAngle(UP, tr.yawAt(s));
          m4.compose(p, q, sc);
          addPlane(tex, color, w, h, m4, 1.7);
          this.lightSpots.push({ p, color: new THREE.Color(color), power: 14 });
          this.groundGlows.push({ s, u: b.side * (EDGE_U + 2.5), size: 7, color, k: 0.35 });
          this.glowPts.pos.push(p.x, p.y, p.z);
          const gc = new THREE.Color(color).multiplyScalar(0.35);
          this.glowPts.col.push(gc.r, gc.g, gc.b);
          this.glowPts.size.push(h * 2.2);
        } else {
          const h = rng.range(1.1, 1.6);
          const w = Math.min(h * tex.aspect, b.w - 1);
          const hh = w / tex.aspect;
          const y = b.groundY + (b.style === 'old' ? 3.4 : 4.9) + hh / 2;
          const u = b.side * (BUILD_U - 0.06);
          const p = tr.toWorld(s, u, y);
          q.setFromAxisAngle(UP, tr.yawAt(s) + (b.side > 0 ? -Math.PI / 2 : Math.PI / 2));
          m4.compose(p, q, sc);
          addPlane(tex, color, w, hh, m4, 1.5);
          this.groundGlows.push({ s, u: b.side * (EDGE_U + 3), size: 6, color, k: 0.3 });
        }
      }
      // giant video screens
      if (city.screens && b.H > 28 && rng() < 0.16 && b.style !== 'old') {
        const w = Math.min(b.w - 2, rng.range(8, 13));
        const h = w * 0.5625;
        const y = b.groundY + rng.range(10, Math.max(11, b.H - h - 4)) + h / 2;
        const s = b.s + b.w / 2;
        const u = b.side * (BUILD_U - 0.08);
        const g = new THREE.PlaneGeometry(w, h);
        const mesh = new THREE.Mesh(g, createScreenMaterial(rng()));
        this.disposables.push(mesh.material);
        mesh.position.copy(tr.toWorld(s, u, y));
        mesh.rotation.y = tr.yawAt(s) + (b.side > 0 ? -Math.PI / 2 : Math.PI / 2);
        this.add(mesh);
        const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, h + 0.5, 0.3), this.mats.darkMetal);
        frame.position.copy(tr.toWorld(s, b.side * (BUILD_U + 0.08), y));
        frame.rotation.y = mesh.rotation.y;
        this.add(frame);
        this.lightSpots.push({ p: mesh.position.clone(), color: new THREE.Color(0x88aaff), power: 30 });
      }
    }
    for (const { mat, geos } of groups.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
      geos.forEach((g) => g.dispose());
      this.add(mesh);
    }
  }

  // ------------------------------------------------------------------ props
  _instanced(geo, mat, matrices, opts = {}) {
    if (!matrices.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, matrices.length);
    matrices.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    this.add(im, opts);
    return im;
  }

  _buildProps() {
    const tr = this.track;
    const st = this.stage;
    const P = st.city.props;
    const rng = mulberry32(st.seed + 5);
    const lampColor = new THREE.Color(st.city.lamp);
    const sideY = (s) => tr.baseY(s) + BANK_TOP + 0.15;

    // --- street lamps
    const poles = [], arms = [], heads = [], bulbs = [];
    const m = new THREE.Matrix4();
    for (const side of [-1, 1]) {
      for (let s = side > 0 ? 6 : 19; s < tr.length + 10; s += 26) {
        const u = side * (EDGE_U + 0.9);
        const y = sideY(s);
        const yaw = tr.yawAt(s);
        const base = tr.toWorld(s, u, y);
        poles.push(new THREE.Matrix4().compose(base, new THREE.Quaternion().setFromAxisAngle(UP, yaw), V(1, 1, 1)));
        const armP = tr.toWorld(s, u - side * 0.65, y + 6.3);
        arms.push(new THREE.Matrix4().compose(armP, new THREE.Quaternion().setFromAxisAngle(UP, yaw), V(1, 1, 1)));
        const headP = tr.toWorld(s, u - side * 1.35, y + 6.2);
        heads.push(new THREE.Matrix4().compose(headP, new THREE.Quaternion().setFromAxisAngle(UP, yaw), V(1, 1, 1)));
        const bulbP = headP.clone(); bulbP.y -= 0.12;
        bulbs.push(new THREE.Matrix4().compose(bulbP, new THREE.Quaternion().setFromAxisAngle(UP, yaw), V(1, 1, 1)));
        this.lightSpots.push({ p: bulbP.clone().setY(bulbP.y - 0.4), color: lampColor, power: 38 });
        this.glowPts.pos.push(bulbP.x, bulbP.y - 0.1, bulbP.z);
        const gc = lampColor.clone().multiplyScalar(0.55);
        this.glowPts.col.push(gc.r, gc.g, gc.b);
        this.glowPts.size.push(3.2);
        this.groundGlows.push({ s, u: u - side * 1.35, size: 9, color: st.city.lamp, k: 0.4 });
        this.groundGlows.push({ s, u: side * (HALF_W + 1.5), size: 8, color: st.city.lamp, k: 0.22 });
      }
    }
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.11, 6.4, 8).translate(0, 3.2, 0);
    // local X is lateral (toward the street), local -Z follows the track
    const armGeo = new THREE.BoxGeometry(1.4, 0.07, 0.07);
    const headGeo = new THREE.BoxGeometry(0.75, 0.16, 0.35);
    const bulbGeo = new THREE.BoxGeometry(0.6, 0.04, 0.26);
    this._instanced(poleGeo, this.mats.darkMetal, poles, { cast: this.quality.shadows });
    this._instanced(armGeo, this.mats.darkMetal, arms);
    this._instanced(headGeo, this.mats.darkMetal, heads);
    this._instanced(bulbGeo, this.emissive(st.city.lamp, 6), bulbs);
    if (st.id !== 'golden') {
      this._lightCones(bulbs, lampColor);
      this._lightCones(this.sideLamps.map((p) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)), lampColor);
    }
    this._buildSignals();

    // --- vending machines
    if (P.vending > 0) {
      const texs = [0, 1, 2].map((i) => vendingTexture(st.seed + i));
      const lists = [[], [], []];
      for (const b of this.frontBuildings) {
        if (b.s < 10 || b.s > tr.length - 20 || rng() > 0.28 * P.vending) continue;
        const n = rng.int(1, 3);
        const s0 = b.s + rng.range(1, Math.max(1.2, b.w - n * 1.1 - 1));
        for (let i = 0; i < n; i++) {
          const s = s0 + i * 1.05;
          const u = b.side * (BUILD_U - 0.5);
          const p = tr.toWorld(s, u, sideY(s) + 0.92);
          const yaw = tr.yawAt(s) + (b.side > 0 ? -Math.PI / 2 : Math.PI / 2);
          lists[rng.int(0, 2)].push(new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(UP, yaw), V(1, 1, 1)));
          if (i === 0) {
            this.groundGlows.push({ s: s + 0.5, u: b.side * (BUILD_U - 2), size: 4.5, color: 0xd8f0ff, k: 0.45 });
            this.lightSpots.push({ p: tr.toWorld(s, b.side * (BUILD_U - 1.4), sideY(s) + 1.2), color: new THREE.Color(0xd0f0ff), power: 6 });
          }
        }
      }
      const vg = new THREE.BoxGeometry(1.0, 1.84, 0.8);
      texs.forEach((t, i) => {
        const side = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.4, metalness: 0.2 });
        const front = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: new THREE.Color(1.6, 1.6, 1.6), roughness: 0.25 });
        this.disposables.push(side, front, t);
        this._instanced(vg, [side, side, this.mats.plainSnow, side, front, side], lists[i], { cast: this.quality.shadows });
      });
    }

    // --- snowy trees
    if (P.trees > 0) {
      const tg = this._treeGeometry();
      const list = [];
      for (const side of [-1, 1]) {
        for (let s = rng.range(5, 20); s < tr.length; s += rng.range(10, 22)) {
          if (rng() > P.trees) continue;
          const u = side * (EDGE_U + rng.range(2.2, 3.8));
          const sc = rng.range(0.75, 1.25);
          const p = tr.toWorld(s, u, sideY(s) - 0.1);
          list.push(new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(UP, rng() * 6.28), V(sc, sc * rng.range(0.9, 1.2), sc)));
          if (st.id === 'golden' || (st.id === 'aurora' && rng() < 0.3)) {
            // fairy lights
            for (let k = 0; k < 14; k++) {
              const t = rng();
              const a = rng() * Math.PI * 2;
              const rr = (1 - t) * 1.6 * sc;
              this.glowPts.pos.push(p.x + Math.cos(a) * rr, p.y + 1.2 * sc + t * 4.5 * sc, p.z + Math.sin(a) * rr);
              const c = new THREE.Color(st.id === 'golden' ? 0xffd890 : 0xffb060).multiplyScalar(0.9);
              this.glowPts.col.push(c.r, c.g, c.b);
              this.glowPts.size.push(0.5);
            }
          }
        }
      }
      this._instanced(tg, this.mats.vegetation, list, { cast: this.quality.shadows });
    }

    // --- stone lanterns & chochin strings
    if (P.lanterns > 0) {
      const base = [], lights = [];
      for (const side of [-1, 1]) {
        for (let s = side > 0 ? 10 : 22; s < tr.length; s += 24) {
          if (rng() > P.lanterns) continue;
          const u = side * (BUILD_U - 1.3);
          const y = sideY(s);
          const p = tr.toWorld(s, u, y);
          const q = new THREE.Quaternion().setFromAxisAngle(UP, tr.yawAt(s));
          base.push(new THREE.Matrix4().compose(p, q, V(1, 1, 1)));
          const lp = p.clone(); lp.y += 1.25;
          lights.push(new THREE.Matrix4().compose(lp, q, V(1, 1, 1)));
          this.glowPts.pos.push(lp.x, lp.y, lp.z);
          this.glowPts.col.push(0.6, 0.35, 0.12);
          this.glowPts.size.push(1.8);
          this.groundGlows.push({ s, u, size: 4, color: 0xff9a40, k: 0.5 });
        }
      }
      const lg = this._lanternGeometry();
      this._instanced(lg, this.mats.stone, base, { cast: this.quality.shadows });
      this._instanced(new THREE.BoxGeometry(0.34, 0.3, 0.34), this.emissive(0xffa040, 3), lights);
      this._chochin(rng, P.lanterns);
    }

    // --- power poles and wires
    if (P.powerlines > 0) {
      const poleList = [], armList = [], boxList = [];
      for (const side of [-1, 1]) {
        let prev = null;
        for (let s = side > 0 ? 0 : 16; s < tr.length + 20; s += 32) {
          const u = side * (BUILD_U - 0.7);
          const y = sideY(s);
          const p = tr.toWorld(s, u, y);
          const q = new THREE.Quaternion().setFromAxisAngle(UP, tr.yawAt(s));
          poleList.push(new THREE.Matrix4().compose(p, q, V(1, 1, 1)));
          armList.push(new THREE.Matrix4().compose(p.clone().setY(y + 8.6), q, V(1, 1, 1)));
          armList.push(new THREE.Matrix4().compose(p.clone().setY(y + 7.9), q, V(0.8, 1, 1)));
          if (rng() < 0.4) boxList.push(new THREE.Matrix4().compose(tr.toWorld(s, u + side * 0.35, y + 6.6), q, V(1, 1, 1)));
          // wire attach points spread across the crossarm (perpendicular to street)
          const f = tr.frame(s, {});
          const pts = [-1.0, -0.2, 0.9].map((o) => V(p.x + f.rx * o, y + 8.65, p.z + f.rz * o));
          if (prev) for (let k = 0; k < 3; k++) this._wire(prev[k], pts[k], 0.9 + k * 0.1);
          // occasional cable across the street
          if (side > 0 && rng() < 0.35) {
            const other = tr.toWorld(s, -u, sideY(s) + 8.3);
            this._wire(pts[1], other, 1.8);
          }
          prev = pts;
        }
      }
      this._instanced(new THREE.CylinderGeometry(0.14, 0.18, 9.4, 8).translate(0, 4.7, 0), this.mats.concrete, poleList, { cast: this.quality.shadows });
      this._instanced(new THREE.BoxGeometry(0.12, 0.12, 2.6).rotateY(Math.PI / 2), this.mats.darkMetal, armList);
      this._instanced(new THREE.CylinderGeometry(0.28, 0.28, 0.8, 10), this.mats.darkMetal, boxList);
    }
    this._buildWires();
  }

  // Traffic lights at side-street corners (cycle green / amber / red).
  _buildSignals() {
    if (!this.signals.length) return;
    const poleM = [], armM = [], headM = [];
    const lampM = [[], [], []];
    const q = new THREE.Quaternion();
    for (const sg of this.signals) {
      q.setFromAxisAngle(UP, sg.yaw);
      const m = (x, y, z) => new THREE.Matrix4().compose(sg.base.clone().add(new THREE.Vector3(x, y, z).applyQuaternion(q)), q, V(1, 1, 1));
      poleM.push(m(0, 0, 0));
      armM.push(m(-sg.side * 2.4, 5.4, 0));
      for (const off of [-sg.side * 4.4]) {
        headM.push(m(off, 5.4, 0));
        // three lamps facing the rider (+Z of the head faces uphill)
        for (let i = 0; i < 3; i++) lampM[i].push(m(off + (i - 1) * 0.42, 5.4, 0.2));
      }
    }
    this._instanced(new THREE.CylinderGeometry(0.09, 0.12, 5.6, 8).translate(0, 2.8, 0), this.mats.darkMetal, poleM, { cast: this.quality.shadows });
    this._instanced(new THREE.BoxGeometry(4.8, 0.12, 0.12), this.mats.darkMetal, armM);
    this._instanced(new RoundedBoxGeometry(1.45, 0.48, 0.32, 2, 0.06), this.mats.darkMetal, headM);
    this.signalMats = [0x2bff88, 0xffb020, 0xff3030].map((c) => this.emissive(c, 0.15));
    const lg = new THREE.CircleGeometry(0.15, 16);
    lampM.forEach((list, i) => this._instanced(lg, this.signalMats[i], list));
    this.signalBase = [0x2bff88, 0xffb020, 0xff3030].map((c) => new THREE.Color(c));
  }

  // Soft additive light cones under lamps (lit falling snow / haze).
  _lightCones(mats, color) {
    if (!mats.length) return;
    const h = 6.0;
    const cone = new THREE.ConeGeometry(2.4, h, 20, 1, true);
    cone.translate(0, -h / 2, 0);
    const pos = cone.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = 1 + pos.getY(i) / h; // 1 at apex, 0 at the ground
      const k = Math.pow(t, 1.6) * 0.3;
      col.set([color.r * k, color.g * k, color.b * k], i * 3);
    }
    cone.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const geos = mats.map((m) => {
      const g = cone.clone();
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      g.translate(p.x, p.y, p.z);
      return g;
    });
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 color; varying vec3 vC; varying vec3 vN; varying vec3 vV; varying float vD;
        void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vD = -mv.z;
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC; varying vec3 vN; varying vec3 vV; varying float vD;
        void main(){ float f = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
          float fade = exp(-vD * 0.012) * smoothstep(1.0, 6.0, vD);
          gl_FragColor = vec4(vC * f * fade, 1.0); }`,
    });
    this.disposables.push(mat);
    const mesh = new THREE.Mesh(mergeGeometries(geos), mat);
    geos.forEach((g) => g.dispose());
    cone.dispose();
    mesh.renderOrder = 3;
    this.add(mesh);
  }

  _wire(a, b, sag) {
    const n = 12;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const p0 = V().lerpVectors(a, b, t0); p0.y -= Math.sin(t0 * Math.PI) * sag;
      const p1 = V().lerpVectors(a, b, t1); p1.y -= Math.sin(t1 * Math.PI) * sag;
      this.wires.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
  }

  _buildWires() {
    if (!this.wires.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.wires, 3));
    const l = new THREE.LineSegments(g, this.mats.wire);
    this.add(l);
  }

  _chochin(rng, amount) {
    const tr = this.track;
    const list = [];
    const ropes = [];
    for (let s = 60; s < tr.length - 60; s += rng.range(40, 80)) {
      if (rng() > amount) continue;
      const y = tr.baseY(s) + BANK_TOP + rng.range(5.5, 7);
      const a = tr.toWorld(s, -BUILD_U + 0.3, y);
      const b = tr.toWorld(s + rng.range(-4, 4), BUILD_U - 0.3, y);
      const n = 9;
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const p = V().lerpVectors(a, b, t);
        p.y -= Math.sin(t * Math.PI) * 1.4 + 0.45;
        list.push(new THREE.Matrix4().compose(p, new THREE.Quaternion(), V(1, 1, 1)));
        this.glowPts.pos.push(p.x, p.y, p.z);
        this.glowPts.col.push(0.7, 0.18, 0.08);
        this.glowPts.size.push(2.4);
      }
      this._wire(a, b, 1.4);
      this.lightSpots.push({ p: V().lerpVectors(a, b, 0.5).setY(y - 1.8), color: new THREE.Color(0xff6030), power: 30 });
      void ropes;
    }
    const g = new THREE.SphereGeometry(0.32, 14, 10).scale(1, 1.35, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc02818, emissive: new THREE.Color(0xff4a1a), emissiveIntensity: 2.2, roughness: 0.6 });
    this.disposables.push(mat);
    this._instanced(g, mat, list);
  }

  _treeGeometry() {
    const parts = [];
    const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1.4, 6).translate(0, 0.7, 0);
    parts.push(bake(trunk, new THREE.Matrix4(), 0x3a2a20));
    const tiers = [[1.9, 2.2, 1.6], [1.5, 1.9, 2.8], [1.05, 1.6, 3.9], [0.6, 1.2, 4.9]];
    for (const [r, h, y] of tiers) {
      const c = new THREE.ConeGeometry(r, h, 9, 3);
      c.translate(0, y, 0);
      const g = bake(c, new THREE.Matrix4());
      const pos = g.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const t = (pos.getY(i) - (y - h / 2)) / h;
        const snow = t > 0.35 ? 1 : 0;
        const k = snow ? 0.95 : 0.12;
        col[i * 3] = snow ? k : 0.07;
        col[i * 3 + 1] = snow ? k : 0.2;
        col[i * 3 + 2] = snow ? 1.0 : 0.13;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(g);
    }
    const g = mergeGeometries(parts);
    g.computeVertexNormals();
    return g;
  }

  _lanternGeometry() {
    const parts = [
      bake(new THREE.CylinderGeometry(0.35, 0.45, 0.25, 6), new THREE.Matrix4().makeTranslation(0, 0.12, 0)),
      bake(new THREE.CylinderGeometry(0.12, 0.15, 0.8, 6), new THREE.Matrix4().makeTranslation(0, 0.65, 0)),
      bake(new THREE.BoxGeometry(0.55, 0.08, 0.55), new THREE.Matrix4().makeTranslation(0, 1.08, 0)),
      bake(new THREE.ConeGeometry(0.55, 0.35, 4), new THREE.Matrix4().compose(V(0, 1.58, 0), new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 4), V(1, 1, 1))),
      bake(new THREE.SphereGeometry(0.08, 6, 4), new THREE.Matrix4().makeTranslation(0, 1.8, 0)),
    ];
    return mergeGeometries(parts);
  }

  // ------------------------------------------------------------------ course features
  _buildFeatures() {
    const tr = this.track;
    const st = this.stage;
    const accent = st.id === 'golden' ? 0xff8a2a : st.id === 'aurora' ? 0x4affc0 : 0x2de2ff;
    const lipMat = this.emissive(accent, 3);
    const accent2 = st.id === 'neon' ? 0xff2d8a : accent;
    const poleMat = this.emissive(accent2, 2.5);
    const m = new THREE.Matrix4();
    const lipList = [], flagList = [];

    for (const k of tr.kickers) {
      const sLip = k.type === 'table' ? k.s0 + k.up : k.s1;
      const yLip = tr.height(sLip - 0.05, k.u0, false);
      const yaw = tr.yawAt(sLip);
      const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
      lipList.push(new THREE.Matrix4().compose(tr.toWorld(sLip - 0.05, k.u0, yLip + 0.02), q, V(k.w, 1, 1)));
      for (const sd of [-1, 1]) {
        const u = k.u0 + sd * (k.w / 2 + 0.6);
        const y = tr.height(sLip - 0.6, u, false);
        flagList.push(new THREE.Matrix4().compose(tr.toWorld(sLip - 0.6, u, y), q, V(1, k.mega ? 2.2 : 1, 1)));
        if (k.mega) {
          const p = tr.toWorld(sLip - 0.6, u, y + 4.6);
          this.glowPts.pos.push(p.x, p.y, p.z);
          const c = new THREE.Color(accent2).multiplyScalar(0.8);
          this.glowPts.col.push(c.r, c.g, c.b);
          this.glowPts.size.push(3);
        }
      }
      if (k.mega) {
        // Banner across the lip
        const tex = bannerTexture('MEGA AIR', [0xff2d6a, 0xffa02d], 0xffffff);
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, color: new THREE.Color(1.3, 1.3, 1.3) });
        this.disposables.push(mat, tex);
        // two single-sided planes so the text reads correctly from both sides
        mat.side = THREE.FrontSide;
        for (const flip of [0, Math.PI]) {
          const ban = new THREE.Mesh(new THREE.PlaneGeometry(k.w + 1.2, (k.w + 1.2) * 0.1875), mat);
          ban.position.copy(tr.toWorld(sLip - 0.6 + (flip ? 0.02 : 0), k.u0, yLip + 4.2));
          ban.rotation.y = yaw + flip;
          this.add(ban);
        }
      }
      this.groundGlows.push({ s: sLip - 1, u: k.u0, size: k.w + 3, color: accent, k: 0.22, follow: true });
    }
    const lipGeo = new THREE.BoxGeometry(1, 0.05, 0.14);
    this._instanced(lipGeo, lipMat, lipList);
    const flagGeo = mergeGeometries([
      bake(new THREE.CylinderGeometry(0.03, 0.03, 2.0, 6), new THREE.Matrix4().makeTranslation(0, 1.0, 0)),
    ]);
    this._instanced(flagGeo, this.mats.darkMetal, flagList);
    const tipGeo = new THREE.SphereGeometry(0.09, 8, 6).translate(0, 2.05, 0);
    this._instanced(tipGeo, poleMat, flagList);

    // Rails and ledges (with an LED under-glow so they read at speed)
    const supports = [];
    const railGlow = this.emissive(accent, 2.2);
    for (const r of tr.rails) {
      const pts = [];
      for (let s = r.s0; s <= r.s1 + 0.01; s += 1) pts.push(tr.toWorld(s, r.u, tr.railY(r, s) - 0.05));
      if (r.type === 'ledge') {
        this._ledge(r);
      } else {
        this._pathTube(pts, 0.045, this.mats.metal, 8, { cast: this.quality.shadows });
        const under = pts.map((p) => p.clone().add(new THREE.Vector3(0, -0.07, 0)));
        this._pathTube(under, 0.014, railGlow, 4);
        for (let s = r.s0 + 0.5; s < r.s1; s += 3.5) {
          const top = tr.railY(r, s) - 0.05;
          const gy = tr.height(s, r.u, false) - 0.3;
          const p = tr.toWorld(s, r.u, gy);
          supports.push(new THREE.Matrix4().compose(p, new THREE.Quaternion(), V(1, top - gy, 1)));
        }
      }
    }
    this._instanced(new THREE.CylinderGeometry(0.035, 0.035, 1, 6).translate(0, 0.5, 0), this.mats.darkMetal, supports);

    // Stair nosings
    const noses = [];
    for (const d of tr.drops) {
      const n = Math.round(d.h / 0.3);
      for (let i = 0; i < n; i++) {
        const s = d.s + ((i + 0.5) / n) * d.len;
        const y = tr.baseY(s) + 0.02;
        noses.push(new THREE.Matrix4().compose(tr.toWorld(s, 0, y), new THREE.Quaternion().setFromAxisAngle(UP, tr.yawAt(s)), V(1, 1, 1)));
      }
      // warning sign
      for (const side of [-1, 1]) {
        const p = tr.toWorld(d.s - 6, side * (HALF_W - 0.6), tr.baseY(d.s - 6));
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6).translate(0, 1.1, 0), this.mats.darkMetal);
        post.position.copy(p);
        this.add(post);
        const sign = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.03), this.emissive(0xffb020, 1.4));
        sign.position.copy(p).add(V(0, 2.2, 0));
        sign.rotation.set(0, tr.yawAt(d.s), Math.PI / 4);
        this.add(sign);
      }
    }
    this._instanced(new THREE.BoxGeometry(HALF_W * 2 + 0.2, 0.07, 0.16), this.mats.concrete, noses);

    this._buildCars();
  }

  _ledge(r) {
    const tr = this.track;
    const geos = [], caps = [];
    for (let s = r.s0; s < r.s1; s += 2) {
      const s1 = Math.min(r.s1, s + 2);
      const sm = (s + s1) / 2;
      const top = tr.railY(r, sm) - 0.05;
      const gy = tr.height(sm, r.u, false) - 0.4;
      const len = s1 - s + 0.02;
      const pitch = Math.atan2(tr.railY(r, s1) - tr.railY(r, s), s1 - s);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, tr.yawAt(sm), 0, 'YXZ'));
      const h = top - gy;
      const p = tr.toWorld(sm, r.u, gy + h / 2);
      geos.push(bake(new THREE.BoxGeometry(0.7, h, len), new THREE.Matrix4().compose(p, q, V(1, 1, 1))));
      const pc = tr.toWorld(sm, r.u, top);
      caps.push(bake(new THREE.BoxGeometry(0.76, 0.05, len), new THREE.Matrix4().compose(pc, q, V(1, 1, 1))));
    }
    this.add(new THREE.Mesh(mergeGeometries(geos), this.mats.concrete), { cast: this.quality.shadows, receive: true });
    this.add(new THREE.Mesh(mergeGeometries(caps), this.mats.paint), { cast: false });
  }

  _buildCars() {
    const tr = this.track;
    const rng = mulberry32(this.stage.seed + 31);
    const body = [], glass = [], wheels = [], lights = [], tails = [], snow = [];
    const colors = [0xb8261e, 0x1d3f8a, 0xe8e8e8, 0x1a1a1f, 0xf2c20f, 0x2e6b4a, 0x8a8f99, 0x5a2a6a];
    const bodyGeo = new RoundedBoxGeometry(1.86, 0.62, 4.4, 3, 0.14);
    const cabGeo = new RoundedBoxGeometry(1.62, 0.52, 2.3, 3, 0.16);
    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 14).rotateZ(Math.PI / 2);
    const lightGeo = new THREE.BoxGeometry(0.36, 0.12, 0.05);
    for (const c of tr.cars) {
      const sm = c.s0 + c.len / 2;
      const gy = tr.height(sm, c.u0, false);
      const q = new THREE.Quaternion().setFromAxisAngle(UP, tr.yawAt(sm));
      const base = new THREE.Matrix4().compose(tr.toWorld(sm, c.u0, gy), q, V(1, 1, 1));
      const local = (x, y, z) => new THREE.Matrix4().multiplyMatrices(base, new THREE.Matrix4().makeTranslation(x, y, z));
      const color = rng.pick(colors);
      body.push(bake(bodyGeo, local(0, 0.6, 0), color));
      glass.push(bake(cabGeo, local(0, 1.18, 0.2)));
      for (const [x, z] of [[-0.86, -1.38], [0.86, -1.38], [-0.86, 1.38], [0.86, 1.38]]) wheels.push(bake(wheelGeo, local(x, 0.34, z)));
      for (const x of [-0.62, 0.62]) {
        lights.push(bake(lightGeo, local(x, 0.72, -2.21)));
        tails.push(bake(lightGeo, local(x, 0.75, 2.21)));
      }
      // snow cap from the physics heightfield
      snow.push(this._carSnow(c));
      this.lightSpots.push({ p: tr.toWorld(sm, c.u0, gy + 0.8), color: new THREE.Color(0xff3020), power: 3 });
    }
    if (!body.length) return;
    const sh = this.quality.shadows;
    this.add(new THREE.Mesh(mergeGeometries(body), this.mats.carBody), { cast: sh, receive: true });
    this.add(new THREE.Mesh(mergeGeometries(glass), this.mats.glass), { cast: sh });
    this.add(new THREE.Mesh(mergeGeometries(wheels), this.mats.rubber));
    this.add(new THREE.Mesh(mergeGeometries(lights), this.emissive(0xfff2d0, 1.2)));
    this.carTail = this.add(new THREE.Mesh(mergeGeometries(tails), this.emissive(0xff2a10, 2.5)));
    this.carHazardMat = this.carTail.material;
    this.add(new THREE.Mesh(mergeGeometries(snow), this.mats.snow), { cast: sh, receive: true });
  }

  _carSnow(c) {
    const tr = this.track;
    const nx = 22, nz = 9;
    const pos = [], col = [], uv = [], idx = [];
    const inset = 0.03;
    const grid = [];
    for (let i = 0; i <= nx; i++) {
      const s = c.s0 + inset + (i / nx) * (c.len - inset * 2);
      for (let j = 0; j <= nz; j++) {
        const u = c.u0 - c.w / 2 + inset + (j / nz) * (c.w - inset * 2);
        const edge = i === 0 || i === nx || j === 0 || j === nz;
        const y = tr.height(s, u, true) + (edge ? -0.08 : 0.02 * Math.sin(i * 1.7 + j));
        const p = tr.toWorld(s, u, y);
        pos.push(p.x, p.y, p.z);
        col.push(1, 1, 1);
        uv.push(u / 3, s / 3);
        grid.push(p);
      }
    }
    const W = nz + 1;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const a = i * W + j, b = a + 1, cc = a + W, d = cc + 1;
        idx.push(a, b, cc, b, d, cc);
      }
    }
    // skirt: drop the border vertices a little to give the cap thickness
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // ensure upward facing
    const n0 = g.attributes.normal.getY(Math.floor(W * nx / 2));
    if (n0 < 0) {
      for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      g.setIndex(idx);
      g.computeVertexNormals();
    }
    g = g.toNonIndexed();
    return g;
  }

  // ------------------------------------------------------------------ tokens
  _buildTokens() {
    const tr = this.track;
    const parts = [];
    const arm = new THREE.BoxGeometry(0.9, 0.07, 0.07);
    const branch = new THREE.BoxGeometry(0.22, 0.05, 0.05);
    for (let i = 0; i < 3; i++) {
      const rot = new THREE.Matrix4().makeRotationZ((i * Math.PI) / 3);
      parts.push(bake(arm, rot));
      for (const sx of [-1, 1]) {
        for (const a of [-0.7, 0.7]) {
          const m = new THREE.Matrix4().makeRotationZ((i * Math.PI) / 3)
            .multiply(new THREE.Matrix4().makeTranslation(sx * 0.3, 0, 0))
            .multiply(new THREE.Matrix4().makeRotationZ(a * sx))
            .multiply(new THREE.Matrix4().makeTranslation(sx * 0.1, 0, 0));
          parts.push(bake(branch, m));
        }
      }
    }
    parts.push(bake(new THREE.OctahedronGeometry(0.16), new THREE.Matrix4()));
    const geo = mergeGeometries(parts);
    const mat = new THREE.MeshStandardMaterial({ color: 0xbfe8ff, emissive: new THREE.Color(0x7fd8ff), emissiveIntensity: 1.5, metalness: 0.4, roughness: 0.2 });
    this.disposables.push(mat);
    const n = tr.tokens.length;
    this.tokenMesh = new THREE.InstancedMesh(geo, mat, n);
    this.tokenMesh.frustumCulled = false;
    this.tokenAlive = new Uint8Array(n).fill(1);
    this.tokenPos = tr.tokens.map((t) => tr.toWorld(t.s, t.u, t.y));
    this.group.add(this.tokenMesh);
    // glow sprites for tokens
    const gp = new Float32Array(n * 3);
    this.tokenPos.forEach((p, i) => gp.set([p.x, p.y, p.z], i * 3));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(gp, 3));
    this.tokenGlow = new THREE.Points(g, new THREE.PointsMaterial({
      size: 1.3, map: glowTexture(), color: new THREE.Color(0x58c8ff).multiplyScalar(0.5),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    this.disposables.push(this.tokenGlow.material);
    this.tokenGlow.frustumCulled = false;
    this.group.add(this.tokenGlow);
    this._updateTokens(0);
  }

  _updateTokens(t) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = V();
    const glow = this.tokenGlow.geometry.attributes.position;
    for (let i = 0; i < this.tokenPos.length; i++) {
      const alive = this.tokenAlive[i];
      const p = this.tokenPos[i];
      q.setFromAxisAngle(UP, t * 2.2 + i * 0.7);
      const s = alive ? 1 : 0;
      sc.set(s, s, s);
      m.compose(V(p.x, p.y + Math.sin(t * 2.5 + i) * 0.12, p.z), q, sc);
      this.tokenMesh.setMatrixAt(i, m);
      if (!alive) glow.setY(i, -99999);
    }
    this.tokenMesh.instanceMatrix.needsUpdate = true;
    glow.needsUpdate = true;
  }

  collectToken(i) {
    this.tokenAlive[i] = 0;
  }

  // ------------------------------------------------------------------ gates
  _buildGates() {
    const tr = this.track;
    const mk = (s, text, bg, fg, lights) => {
      const y0 = tr.baseY(s);
      const q = new THREE.Quaternion().setFromAxisAngle(UP, tr.yawAt(s));
      for (const side of [-1, 1]) {
        const p = tr.toWorld(s, side * (HALF_W + 0.6), y0 - 0.5);
        const pil = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9, 0.7).translate(0, 4.5, 0), this.mats.darkMetal);
        pil.position.copy(p);
        pil.quaternion.copy(q);
        this.add(pil, { cast: this.quality.shadows });
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 8, 0.74).translate(0, 4.6, 0), this.emissive(lights, 3));
        strip.position.copy(p).add(V(0, 0, 0));
        strip.quaternion.copy(q);
        this.add(strip);
      }
      const tex = bannerTexture(text, bg, fg);
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, color: new THREE.Color(1.25, 1.25, 1.25) });
      this.disposables.push(mat, tex);
      const w = HALF_W * 2 + 1.2;
      const ban = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.1875), mat);
      ban.position.copy(tr.toWorld(s, 0, y0 + 8.5 - 0.5));
      ban.quaternion.copy(q);
      this.add(ban);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(w + 1.4, 0.4, 0.5), this.mats.darkMetal);
      beam.position.copy(tr.toWorld(s, 0, y0 + 8.5 + w * 0.094 + 0.2 - 0.5));
      beam.quaternion.copy(q);
      this.add(beam);
      this.lightSpots.push({ p: tr.toWorld(s, 0, y0 + 6), color: new THREE.Color(lights), power: 60 });
    };
    mk(18, 'DROP IN', [0x1a1a2e, 0x3a2a6e], 0xffffff, 0x2de2ff);
    mk(tr.finishS, 'FINISH', [0xff2d6a, 0xffa02d], 0xffffff, 0xffd02d);
  }

  // ------------------------------------------------------------------ glows
  _finishGlows() {
    const tr = this.track;
    // light pools on the snow (additive textured quads)
    const tex = glowTexture();
    const geos = [];
    const q = new THREE.Quaternion();
    for (const g of this.groundGlows) {
      const y = tr.height(g.s, g.u, false) + 0.06;
      const n = tr.normal(g.s, g.u, V(), false);
      q.setFromUnitVectors(V(0, 0, 1), n);
      const pg = new THREE.PlaneGeometry(g.size, g.size);
      pg.applyMatrix4(new THREE.Matrix4().compose(tr.toWorld(g.s, g.u, y), q, V(1, 1, 1)));
      const c = new THREE.Color(g.color).multiplyScalar(g.k);
      const col = new Float32Array(pg.attributes.position.count * 3);
      for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
      pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geos.push(pg);
    }
    if (geos.length) {
      const m = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
      this.disposables.push(m);
      const mesh = new THREE.Mesh(mergeGeometries(geos), m);
      mesh.renderOrder = 1;
      this.add(mesh);
    }
    // glow points (lamps, lanterns, signs)
    if (this.glowPts.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.glowPts.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.glowPts.col, 3));
      g.setAttribute('size', new THREE.Float32BufferAttribute(this.glowPts.size, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: tex }, uScale: { value: 600 } },
        vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; uniform float uScale;
          void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = size * uScale / -mv.z; vC *= exp(-(-mv.z) * 0.005); }`,
        fragmentShader: `uniform sampler2D map; varying vec3 vC; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC * t.a * 1.6, 1.0); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      this.glowMat = mat;
      this.disposables.push(mat);
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      this.add(pts);
    }
    if (this.aviation?.length) {
      const g = new THREE.BufferGeometry().setFromPoints(this.aviation);
      this.aviationMat = new THREE.PointsMaterial({ size: 5, map: tex, color: 0xff2010, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      this.disposables.push(this.aviationMat);
      const p = new THREE.Points(g, this.aviationMat);
      p.frustumCulled = false;
      this.add(p);
    }
  }

  // ------------------------------------------------------------------ runtime
  update(dt, t, focus, camera, viewH) {
    sharedUniforms.uTime.value = t;
    this.sky.position.copy(camera.position);
    if (this.glowMat) this.glowMat.uniforms.uScale.value = viewH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    // sun & shadows follow the rider
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.shadowDir, 160);
    if (this.aviationMat) this.aviationMat.opacity = Math.sin(t * 3) > 0.2 ? 1 : 0.1;
    if (this.carHazardMat) this.carHazardMat.color.setRGB(2.5, 0.3, 0.1).multiplyScalar(0.5 + 0.5 * (Math.sin(t * 5) > 0 ? 1 : 0.2));
    this._updateTokens(t);
    this._updateTraffic(t);
    if (this.signalMats) {
      const ph = t % 18;
      const on = ph < 8 ? 0 : ph < 10 ? 1 : 2;
      this.signalMats.forEach((m, i) => m.color.copy(this.signalBase[i]).multiplyScalar(i === on ? 3.2 : 0.08));
    }
    if (this.train) {
      const T = this.train;
      const x = ((t * T.speed) % T.loop) - T.loop / 2;
      T.group.position.copy(T.origin).addScaledVector(T.dir, x);
    }
    // dynamic point lights: brightest candidates near the rider
    if (this.pointLights.length) {
      this._lightTimer = (this._lightTimer || 0) - dt;
      if (this._lightTimer <= 0) {
        this._lightTimer = 0.25;
        const scored = [];
        for (const L of this.lightSpots) {
          const d = L.p.distanceToSquared(focus);
          if (d < 60 * 60) scored.push([d, L]);
        }
        scored.sort((a, b) => a[0] - b[0]);
        this._lightSel = scored.slice(0, this.pointLights.length).map((x) => x[1]);
      }
      this.pointLights.forEach((pl, i) => {
        const L = this._lightSel?.[i];
        if (!L) { pl.intensity = 0; return; }
        if (pl.userData.src !== L) {
          pl.userData.src = L;
          pl.position.copy(L.p);
          pl.color.copy(L.color);
          pl.intensity = 0;
        }
        const d = L.p.distanceTo(focus);
        const target = L.power * clamp(1 - (d - 25) / 30, 0, 1);
        pl.intensity += (target - pl.intensity) * Math.min(1, dt * 4);
      });
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const d of this.disposables) d.dispose?.();
    this.envRT?.dispose();
    this.scene.environment = null;
    this.scene.fog = null;
  }
}
