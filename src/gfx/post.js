import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uVignette: { value: 0.4 },
    uLift: { value: new THREE.Vector3() },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1.1 },
    uContrast: { value: 1.05 },
    uGrain: { value: 0.035 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uAspect: { value: 1.7 },
    uLines: { value: 1 },
    uSunPos: { value: new THREE.Vector2(-1, -1) },
    uFlare: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uSpeed, uVignette, uSat, uContrast, uGrain, uFlash, uAspect, uLines, uFlare;
    uniform vec2 uSunPos;
    uniform vec3 uLift, uGain, uFlashColor;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec2 dc = uv - 0.5;
      float r = length(dc * vec2(uAspect, 1.0)) / uAspect * 1.6;
      // radial speed blur + chromatic aberration toward the edges
      float blur = uSpeed * 0.022 * smoothstep(0.15, 0.9, r);
      vec3 col = vec3(0.0);
      float ca = 0.0012 + uSpeed * 0.004;
      const int N = 7;
      for (int i = 0; i < N; i++) {
        float t = float(i) / float(N - 1);
        vec2 o = -dc * blur * t;
        col.r += texture2D(tDiffuse, uv + o + dc * ca * r).r;
        col.g += texture2D(tDiffuse, uv + o).g;
        col.b += texture2D(tDiffuse, uv + o - dc * ca * r).b;
      }
      col /= float(N);
      // speed lines
      float ang = atan(dc.y, dc.x);
      float lane = floor(ang * 70.0);
      float h = hash(vec2(lane, floor(uTime * 18.0 + hash(vec2(lane, 1.0)) * 10.0)));
      float line = step(0.93, h) * smoothstep(0.45, 0.95, r) * smoothstep(0.35, 0.9, uSpeed) * uLines;
      col += vec3(0.9, 0.95, 1.0) * line * 0.22;
      // grading
      col = col * uGain + uLift * (1.0 - col);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat);
      col = (col - 0.5) * uContrast + 0.5;
      // lens flare from the sun, faded when the sun is hidden behind terrain
      if (uFlare > 0.0) {
        vec2 sp = uSunPos;
        float occ = 0.0;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.785;
          vec2 o = sp + vec2(cos(a), sin(a) * uAspect) * 0.008;
          occ += step(0.88, dot(texture2D(tDiffuse, clamp(o, 0.0, 1.0)).rgb, vec3(0.333)));
        }
        float inside = step(0.0, sp.x) * step(sp.x, 1.0) * step(0.0, sp.y) * step(sp.y, 1.0);
        float vis = uFlare * (occ / 8.0) * inside;
        vec2 asp = vec2(uAspect, 1.0);
        vec2 axis = vec2(0.5) - sp;
        vec3 fl = vec3(0.0);
        for (int i = 0; i < 6; i++) {
          float fi = float(i);
          vec2 gp = sp + axis * (0.45 + fi * 0.32);
          float rr = 0.018 + 0.028 * mod(fi * 1.7, 3.0);
          float dd = length((uv - gp) * asp);
          vec3 tint = mix(vec3(0.35, 0.65, 1.0), vec3(1.0, 0.55, 0.25), fract(fi * 0.37));
          fl += tint * (smoothstep(rr, rr * 0.55, dd) * 0.03 + smoothstep(rr * 1.02, rr, dd) * smoothstep(rr * 0.8, rr, dd) * 0.025);
        }
        float dr = length((uv - sp) * asp);
        fl += vec3(1.0, 0.82, 0.62) * smoothstep(0.01, 0.0, abs(dr - 0.22)) * 0.025;
        float ang = atan((uv.y - sp.y), (uv.x - sp.x) * uAspect);
        fl += vec3(1.0, 0.95, 0.85) * pow(max(0.0, cos(ang * 6.0 + 0.4)), 60.0) * exp(-dr * 5.0) * 0.35;
        fl += vec3(1.0, 0.9, 0.78) * exp(-dr * 12.0) * 0.45;
        col += fl * vis;
      }
      // vignette
      float vig = smoothstep(0.95, 0.25, r * (1.0 + uVignette * 0.3));
      col *= mix(1.0 - uVignette, 1.0, vig);
      // flash
      col = mix(col, uFlashColor, uFlash);
      // grain
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime * 13.7)) - 0.5;
      col += g * uGrain;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

// Screen-space light shafts streaming from the sun through gaps between buildings.
const GodRayShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: 0 },
    uColor: { value: new THREE.Color(1, 0.75, 0.45) },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uStrength; uniform vec3 uColor;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      if (uStrength <= 0.001) { gl_FragColor = vec4(base, 1.0); return; }
      const int N = 48;
      vec2 delta = (vUv - uSun) * (0.92 / float(N));
      vec2 c = vUv - delta * hash(vUv * 731.0);
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < N; i++) {
        c -= delta;
        vec3 sm = texture2D(tDiffuse, clamp(c, 0.0, 1.0)).rgb;
        float l = max(dot(sm, vec3(0.3, 0.59, 0.11)) - 0.9, 0.0);
        acc += uColor * min(l, 4.0) * illum;
        illum *= 0.962;
      }
      float fall = 1.0 - smoothstep(0.0, 0.9, length((vUv - uSun) * vec2(1.6, 1.0)));
      gl_FragColor = vec4(base + acc / float(N) * uStrength * (0.4 + 0.6 * fall), 1.0);
    }`,
};

const _sp = new THREE.Vector3();
const _cd = new THREE.Vector3();

export class PostFX {
  constructor(renderer, scene, camera, quality) {
    this.renderer = renderer;
    this.quality = quality;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: quality.msaa ? 4 : 0,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.8, 0.5, 0.8);
    this.bloom.enabled = quality.bloom;
    this.godrays = new ShaderPass(GodRayShader);
    this.godrays.enabled = false;
    this.composer.addPass(this.godrays);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.u = this.final.uniforms;
  }
  setCamera(camera) {
    this.renderPass.camera = camera;
  }
  setScene(scene) {
    this.renderPass.scene = scene;
  }
  applyStage(stage) {
    const b = stage.bloom;
    this.bloom.strength = b.strength;
    this.bloom.radius = b.radius;
    this.bloom.threshold = b.threshold;
    const g = stage.grade;
    this.u.uLift.value.set(...g.lift);
    this.u.uGain.value.set(...g.gain);
    this.u.uSat.value = g.saturation;
    this.u.uContrast.value = g.contrast;
    this.u.uVignette.value = g.vignette;
    this.renderer.toneMappingExposure = stage.exposure;
    this.godRayStrength = this.quality.bloom ? stage.godRays || 0 : 0;
    this.godrays.enabled = this.godRayStrength > 0;
    this.flareStrength = stage.sky.lensFlare ? 1 : 0;
  }

  // Place the light-shaft origin at the sun's screen position.
  updateSun(camera, sunDir) {
    if (this.flareStrength > 0) {
      const sp = _sp.copy(camera.position).addScaledVector(sunDir, 1000).project(camera);
      camera.getWorldDirection(_cd);
      const front = _cd.dot(sunDir) > 0;
      this.u.uSunPos.value.set(front ? sp.x * 0.5 + 0.5 : -5, front ? sp.y * 0.5 + 0.5 : -5);
      this.u.uFlare.value = this.flareStrength;
    } else {
      this.u.uFlare.value = 0;
    }
    if (!this.godrays.enabled) return;
    const p = _sp.copy(camera.position).addScaledVector(sunDir, 1000).project(camera);
    camera.getWorldDirection(_cd);
    const facing = _cd.dot(sunDir);
    this.godrays.uniforms.uSun.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    const onScreen = 1 - Math.min(1, Math.max(0, Math.max(Math.abs(p.x), Math.abs(p.y)) - 1) * 1.2);
    this.godrays.uniforms.uStrength.value = this.godRayStrength * Math.max(0, facing) * onScreen;
  }
  setSize(w, h) {
    this.composer.setSize(w, h);
    this.u.uAspect.value = w / h;
  }
  render(dt, t, speed01) {
    this.u.uTime.value = t;
    this.u.uSpeed.value += (speed01 - this.u.uSpeed.value) * Math.min(1, dt * 4);
    this.u.uFlash.value *= Math.exp(-dt * 6);
    this.composer.render(dt);
  }
  flash(color = 0xffffff, amount = 0.35) {
    this.u.uFlashColor.value.set(color);
    this.u.uFlash.value = Math.max(this.u.uFlash.value, amount);
  }
}
