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
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uSpeed, uVignette, uSat, uContrast, uGrain, uFlash, uAspect, uLines;
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
