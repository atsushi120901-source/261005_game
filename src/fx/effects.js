import * as THREE from 'three';
import { glowTexture } from '../gfx/textures.js';

// ------------------------------------------------------------------ falling snow
// GPU-animated snow volume that wraps around the camera.
export class Snowfall {
  constructor(scene, cfg, quality) {
    const count = Math.round(cfg.count * quality.particles);
    const box = 70;
    const pos = new Float32Array(count * 3);
    const rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * box;
      pos[i * 3 + 1] = Math.random() * box;
      pos[i * 3 + 2] = Math.random() * box;
      rnd[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: box },
        uFall: { value: cfg.speed },
        uWind: { value: new THREE.Vector3(...cfg.wind) },
        uSize: { value: cfg.size * 0.09 },
        uScale: { value: 800 },
        uColor: { value: new THREE.Color(0xffffff) },
        uVel: { value: new THREE.Vector3() },
        uMap: { value: glowTexture() },
      },
      vertexShader: /* glsl */ `
        attribute float rnd;
        uniform float uTime, uBox, uFall, uSize, uScale;
        uniform vec3 uCam, uWind, uVel;
        varying float vA;
        void main(){
          vec3 p = position;
          float t = uTime;
          p.y -= t * uFall * (0.7 + rnd * 0.6);
          p += uWind * t * (0.6 + rnd * 0.8);
          p.x += sin(t * (0.8 + rnd) + rnd * 20.0) * 0.6;
          p.z += cos(t * (0.6 + rnd) + rnd * 13.0) * 0.6;
          vec3 c = uCam - vec3(uBox * 0.5);
          p = mod(p - c, uBox) + c;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          gl_PointSize = uSize * (0.6 + rnd * 0.9) * uScale / d;
          vA = smoothstep(uBox * 0.5, uBox * 0.25, length(p - uCam)) * smoothstep(0.4, 2.5, d);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform sampler2D uMap;
        varying float vA;
        void main(){
          float a = texture2D(uMap, gl_PointCoord).a;
          gl_FragColor = vec4(uColor, a * vA * 0.9);
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.scene = scene;
  }
  update(t, camera, viewH, tint) {
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uCam.value.copy(camera.position);
    this.mat.uniforms.uScale.value = viewH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    if (tint) this.mat.uniforms.uColor.value.copy(tint);
  }
  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------ CPU particles
class ParticlePool {
  constructor(scene, max, { additive = false, size = 0.3, color = 0xffffff, gravity = 6, drag = 2.0, map = glowTexture() }) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.gravity = gravity;
    this.drag = drag;
    this.head = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uMap: { value: map }, uColor: { value: new THREE.Color(color) }, uScale: { value: 800 } },
      vertexShader: /* glsl */ `
        attribute float size; attribute float alpha; varying float vA; uniform float uScale;
        void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = size * uScale / max(0.1, -mv.z); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform vec3 uColor; varying float vA;
        void main(){ float a = texture2D(uMap, gl_PointCoord).a * vA * 0.75; if (a < 0.003) discard; gl_FragColor = vec4(uColor, a); }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
    this.baseSize = size;
  }
  emit(x, y, z, vx, vy, vz, life, size) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size ?? this.baseSize;
  }
  update(dt, scale) {
    const d = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = i * 3;
      this.vel[k + 1] -= this.gravity * dt;
      this.vel[k] *= d; this.vel[k + 1] *= d; this.vel[k + 2] *= d;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.min(1, t * 2.2) * (t > 0.9 ? (1 - t) * 10 : 1);
      this.size[i] *= 1 + dt * 0.5;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
    this.mat.uniforms.uScale.value = scale;
  }
  dispose(scene) {
    scene.remove(this.points);
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------ board trail
// Carved groove left in the snow: a ribbon following the board.
class Trail {
  constructor(scene, max = 900) {
    this.max = max;
    this.pos = new Float32Array(max * 2 * 3);
    this.alpha = new Float32Array(max * 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < max - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      uniforms: { uColor: { value: new THREE.Color(0x1a2240) } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor, vA * 0.16); }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.count = 0;
    this.head = 0;
    this.last = new THREE.Vector3(1e9, 0, 0);
    this.broken = true;
  }
  add(p, fwd, n, on) {
    if (!on) { this.broken = true; return; }
    if (p.distanceToSquared(this.last) < 0.3 * 0.3 && !this.broken) return;
    const side = new THREE.Vector3().crossVectors(fwd, n).normalize().multiplyScalar(0.11);
    const i = this.head;
    const o = n.clone().multiplyScalar(0.03);
    this.pos.set([p.x + side.x + o.x, p.y + side.y + o.y, p.z + side.z + o.z], i * 6);
    this.pos.set([p.x - side.x + o.x, p.y - side.y + o.y, p.z - side.z + o.z], i * 6 + 3);
    // break the strip when re-starting after a gap
    const v = this.broken ? 0 : 1;
    this.alpha[i * 2] = v;
    this.alpha[i * 2 + 1] = v;
    this.broken = false;
    this.head = (this.head + 1) % this.max;
    this.last.copy(p);
    // the segment joining the ring wrap-around should be invisible
    this.alpha[this.head * 2] = 0;
    this.alpha[this.head * 2 + 1] = 0;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
  clear() {
    this.alpha.fill(0);
    this.geo.attributes.alpha.needsUpdate = true;
    this.broken = true;
  }
  dispose(scene) {
    scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------ FX hub
export class Effects {
  constructor(scene, stage, quality) {
    this.scene = scene;
    this.q = quality;
    const pq = quality.particles;
    this.snowPuffs = new ParticlePool(scene, Math.round(2000 * pq), { size: 0.2, color: 0xf4f8ff, gravity: 5, drag: 2.6 });
    this.sparkPool = new ParticlePool(scene, 400, { additive: true, size: 0.09, color: 0xffb04a, gravity: 14, drag: 1.2 });
    this.glints = new ParticlePool(scene, 300, { additive: true, size: 0.35, color: 0x9fe4ff, gravity: -1, drag: 3.0 });
    this.trailFx = new Trail(scene);
    this.snowfall = new Snowfall(scene, stage.snow, quality);
    const night = stage.id !== 'golden';
    this.puffTint = new THREE.Color(night ? 0xc8d2ff : 0xfff2e6);
    this.snowPuffs.mat.uniforms.uColor.value.copy(this.puffTint);
    this._acc = 0;
  }
  spray(p, vel, amount, n) {
    const count = Math.min(8, Math.floor(amount * 6 * this.q.particles + Math.random()));
    for (let i = 0; i < count; i++) {
      const spread = 1.5 + amount * 2;
      this.snowPuffs.emit(
        p.x + (Math.random() - 0.5) * 0.4, p.y + Math.random() * 0.15, p.z + (Math.random() - 0.5) * 0.4,
        vel.x * 0.35 + (Math.random() - 0.5) * spread + (n ? n.x * 2 : 0),
        1.2 + Math.random() * 2.4 * amount,
        vel.z * 0.35 + (Math.random() - 0.5) * spread + (n ? n.z * 2 : 0),
        0.5 + Math.random() * 0.6, 0.1 + Math.random() * 0.18
      );
    }
  }
  burst(p, amount) {
    const count = Math.round(30 * amount * this.q.particles);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 2 + Math.random() * 5 * amount;
      this.snowPuffs.emit(p.x, p.y + 0.1, p.z, Math.cos(a) * s, 1 + Math.random() * 3 * amount, Math.sin(a) * s, 0.6 + Math.random() * 0.7, 0.15 + Math.random() * 0.25);
    }
  }
  sparks(p, vel) {
    for (let i = 0; i < 3; i++) {
      this.sparkPool.emit(p.x, p.y + 0.02, p.z, -vel.x * 0.2 + (Math.random() - 0.5) * 3, Math.random() * 3, -vel.z * 0.2 + (Math.random() - 0.5) * 3, 0.25 + Math.random() * 0.3, 0.06 + Math.random() * 0.06);
    }
  }
  collect(p) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI - Math.PI / 2;
      const s = 2 + Math.random() * 3;
      this.glints.emit(p.x, p.y, p.z, Math.cos(a) * Math.cos(b) * s, Math.sin(b) * s, Math.sin(a) * Math.cos(b) * s, 0.5 + Math.random() * 0.4, 0.25 + Math.random() * 0.3);
    }
  }
  trail(p, fwd, n, on) {
    this.trailFx.add(p, fwd, n, on);
  }
  update(dt, t, camera, viewH) {
    const scale = viewH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.snowPuffs.update(dt, scale);
    this.sparkPool.update(dt, scale);
    this.glints.update(dt, scale);
    this.snowfall.update(t, camera, viewH);
  }
  reset() {
    this.trailFx.clear();
  }
  dispose() {
    this.snowPuffs.dispose(this.scene);
    this.sparkPool.dispose(this.scene);
    this.glints.dispose(this.scene);
    this.trailFx.dispose(this.scene);
    this.snowfall.dispose();
  }
}
