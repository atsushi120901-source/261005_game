import * as THREE from 'three';
import { snowNormalTexture } from './textures.js';

export const sharedUniforms = {
  uTime: { value: 0 },
};

const HASH = /* glsl */ `
float h12(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float h13(vec3 p){ p = fract(p*0.3183099 + .1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
`;

// ------------------------------------------------------------------ snow
// Physically based snow with a fine normal map and view dependent glints.
export function createSnowMaterial(stage) {
  const nm = snowNormalTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xf2f6ff),
    roughness: 0.78,
    metalness: 0.0,
    normalMap: nm,
    normalScale: new THREE.Vector2(0.55, 0.55),
    vertexColors: true,
  });
  mat.userData.glint = stage.id === 'golden' ? 3.0 : 2.2;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = sharedUniforms.uTime;
    sh.uniforms.uGlint = { value: mat.userData.glint };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\nuniform float uGlint;\n' + HASH)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 vd = normalize(vWPos - cameraPosition);
          vec3 cell = floor(vWPos * 28.0);
          float hh = h13(cell);
          vec3 sd = normalize(vec3(h13(cell+1.7)-0.5, 1.0, h13(cell+3.1)-0.5));
          vec3 r = reflect(vd, sd);
          float spec = pow(max(dot(r, normalize(vec3(0.3,0.6,-0.4) - vd*0.6)), 0.0), 40.0);
          float tw = step(0.93, hh) * spec;
          float dist = length(vWPos - cameraPosition);
          totalEmissiveRadiance += vec3(0.9,0.95,1.0) * tw * uGlint * smoothstep(45.0, 5.0, dist);
        }`
      );
  };
  return mat;
}

// ------------------------------------------------------------------ facade
// One material renders every building: windows, shop fronts, sills with snow,
// randomly lit rooms -- all procedurally from per-vertex attributes.
// aFacade = (style, seed, litRatio, isRoof)
export function createFacadeMaterial(stage) {
  const c = stage.city;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.0,
    vertexColors: true,
  });
  const warm = new THREE.Color(c.windowWarm);
  const cool = new THREE.Color(c.windowCool);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWarm = { value: warm };
    sh.uniforms.uCool = { value: cool };
    sh.uniforms.uTime = sharedUniforms.uTime;
    sh.uniforms.uNight = { value: stage.id === 'golden' ? 0.35 : 1.0 };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aFacade;
        varying vec4 vFac;
        varying vec2 vFUv;
        varying vec3 vWPos2;`
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        vFac = aFacade;
        vFUv = uv;`
      )
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos2 = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec4 vFac;
        varying vec2 vFUv;
        varying vec3 vWPos2;
        uniform vec3 uWarm;
        uniform vec3 uCool;
        uniform float uTime;
        uniform float uNight;
        ${HASH}
        float vn2(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
          return mix(mix(h12(i),h12(i+vec2(1,0)),u.x), mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),u.x), u.y); }
        // Interior mapping: ray-trace a box room behind the window.
        // w: window coords 0..1, size: window size in metres, depth: room depth in metres,
        // Vt: view direction in facade tangent space (z points out of the wall).
        vec3 interiorRoom(vec2 w, vec2 size, float depth, vec3 Vt, vec3 L, float rnd, float kind) {
          vec3 o = vec3(w, 0.0);
          vec3 d = vec3(Vt.x / size.x, Vt.y / size.y, Vt.z / depth);
          float tx = ((d.x > 0.0 ? 1.0 : 0.0) - o.x) / (abs(d.x) < 1e-5 ? 1e-5 : d.x);
          float ty = ((d.y > 0.0 ? 1.0 : 0.0) - o.y) / (abs(d.y) < 1e-5 ? 1e-5 : d.y);
          float tz = -1.0 / d.z;
          float t = min(min(tx, ty), tz);
          vec3 h = o + d * t;
          vec3 c;
          if (t == tz) {
            // back wall with furniture silhouettes and a picture
            c = L * 0.85;
            float fx = 0.5 + (rnd - 0.5) * 0.5;
            float sofa = step(h.y, 0.28 + 0.12 * rnd) * step(abs(h.x - fx), 0.28);
            float shelf = step(0.6, rnd) * step(abs(h.x - (1.0 - fx)), 0.12) * step(h.y, 0.75);
            float pic = step(abs(h.x - fx), 0.1) * step(abs(h.y - 0.62), 0.08);
            if (kind > 1.5) { sofa = step(h.y, 0.45) * step(0.12, fract(h.x * 3.0)); shelf = 0.0; pic = 0.0; }
            if (kind > 0.5 && kind < 1.5) { sofa = step(h.y, 0.3) * step(0.3, fract(h.x * 2.5 + rnd)); shelf = 0.0; }
            c *= 1.0 - 0.65 * clamp(sofa + shelf, 0.0, 1.0);
            c *= 1.0 - 0.35 * pic;
          } else if (t == tx) {
            c = L * (0.5 + 0.3 * (1.0 + h.z));
          } else if (d.y > 0.0) {
            // ceiling with a lamp (office: fluorescent panels)
            float lamp = kind > 0.5 ? step(0.75, fract(h.x * 2.0)) * step(0.5, fract(h.z * 3.0)) * 0.8
                                    : smoothstep(0.22, 0.0, length(vec2(h.x - 0.5, h.z + 0.45)));
            c = L * (0.55 + 2.2 * lamp);
          } else {
            // floor (planks / carpet)
            c = L * 0.32 * (0.85 + 0.15 * step(0.5, fract(h.x * 5.0 + rnd)));
          }
          return c * mix(1.0, 0.6, clamp(-h.z, 0.0, 1.0));
        }
        `
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fRough = 0.85;
        float fMetal = 0.0;
        vec3 fEmis = vec3(0.0);
        {
          // quantize: interpolated attributes carry tiny errors the hash would amplify
          float style = floor(vFac.x + 0.5);
          float seed = floor(vFac.y * 997.0 + 0.5) / 997.0;
          float litR = floor(vFac.z * 100.0 + 0.5) / 100.0;
          vec2 p = vFUv;
          vec3 wall = diffuseColor.rgb;
          // tangent frame of the facade from screen derivatives (for interior parallax)
          vec3 dp1 = dFdx(vWPos2), dp2 = dFdy(vWPos2);
          vec2 duv1 = dFdx(p), duv2 = dFdy(p);
          vec3 Nw = normalize(cross(dp1, dp2));
          if (dot(Nw, cameraPosition - vWPos2) < 0.0) Nw = -Nw;
          vec3 dp2p = cross(dp2, Nw), dp1p = cross(Nw, dp1);
          float det = dot(dp1, dp2p);
          vec3 Tw = (dp2p * duv1.x + dp1p * duv2.x) * sign(det);
          vec3 Bw = (dp2p * duv1.y + dp1p * duv2.y) * sign(det);
          vec3 Vw = normalize(vWPos2 - cameraPosition);
          vec3 Vt = vec3(dot(Vw, normalize(Tw + 1e-6)), dot(Vw, normalize(Bw + 1e-6)), min(dot(Vw, Nw), -0.05));
          float camDist = length(vWPos2 - cameraPosition);

          if (vFac.w > 0.5) {
            // snow caps on roofs, ledges and sills
            diffuseColor.rgb = vec3(0.93, 0.95, 1.0) * (0.92 + 0.08 * vn2(p * 3.0));
            fRough = 0.8;
          } else if (style > 4.5) {
            // plain props: AC units, balcony slabs, parapets, awnings, tanks
            float grime = vn2(p * vec2(1.5, 0.6) + seed * 7.0);
            diffuseColor.rgb = wall * (0.85 + 0.2 * grime);
            fRough = 0.55;
          } else {
            vec2 cs; vec2 wf;
            if (style < 0.5) { cs = vec2(2.2, 3.6); wf = vec2(0.94, 0.86); }        // glass
            else if (style < 1.5) { cs = vec2(3.0, 3.2); wf = vec2(0.56, 0.52); }   // concrete
            else if (style < 2.5) { cs = vec2(2.4, 2.9); wf = vec2(0.5, 0.48); }    // old town
            else if (style < 3.5) { cs = vec2(1.4, 4.0); wf = vec2(0.78, 0.92); }   // tower
            else { cs = vec2(3.0, 3.2); wf = vec2(0.6, 0.5); }                      // shop

            // ---- wall surface: panel joints, rain stains, weathering
            float stain = vn2(vec2(p.x * 1.7, p.y * 0.12) + seed * 31.0);
            float blotch = vn2(p * 0.45 + seed * 17.0);
            wall *= 0.78 + 0.22 * blotch;
            wall *= 1.0 - 0.18 * smoothstep(0.45, 0.85, stain);
            if (style > 0.5 && style < 1.5 || style > 3.5) {
              vec2 pj = abs(fract(p / vec2(1.8, 1.6)) - 0.5);
              wall *= 1.0 - 0.12 * step(0.47, max(pj.x, pj.y)) * step(camDist, 60.0);
            }
            if (style > 1.5 && style < 2.5) {
              // vertical wooden boards on the lower part, plaster above
              float board = step(0.9, fract(p.x * 4.0));
              wall *= p.y < 3.0 ? (0.75 - 0.2 * board) : 1.05;
            }
            if (style < 0.5 || (style > 2.5 && style < 3.5)) wall = mix(wall, vec3(0.16, 0.17, 0.19), 0.4); // metal mullions
            wall *= 0.9 + 0.1 * smoothstep(0.0, 6.0, p.y);

            float groundH = (style > 3.5 || style > 0.5 && style < 1.5) ? 4.4 : (style > 1.5 && style < 2.5 ? 3.2 : 0.0);
            vec2 q = vec2(p.x, p.y - groundH);
            vec2 cell = floor(q / cs);
            vec2 f = fract(q / cs);
            vec2 m0 = (1.0 - wf) * 0.5;
            // anti-aliased window mask that fades to its average when windows get tiny
            vec2 fw = max(fwidth(q / cs), vec2(1e-4));
            float detail = 1.0 - smoothstep(0.1, 0.28, max(fw.x, fw.y));
            vec2 e0 = smoothstep(m0 - fw, m0 + fw, f) * (1.0 - smoothstep(1.0 - m0 - fw, 1.0 - m0 + fw, f));
            float win = mix(wf.x * wf.y, e0.x * e0.y, detail);
            float sill = step(m0.x - 0.03, f.x) * step(f.x, 1.03 - m0.x) * step(m0.y - 0.07, f.y) * step(f.y, m0.y) * detail;
            float hh = h12(cell + seed * 37.0);
            float lit = mix(litR, step(hh, litR), detail) * step(0.0, q.y);
            float tone = mix(0.5, h12(cell * 1.7 + seed * 11.0), detail);
            vec3 lc = mix(uWarm, uCool, mix(0.38, step(0.62, tone), detail));
            float inten = 0.35 + 1.0 * tone;
            // flicker on a few windows
            inten *= 1.0 - 0.6 * step(0.985, hh) * step(0.5, sin(uTime*13.0 + hh*50.0)) * detail;
            vec3 glass = vec3(0.03, 0.04, 0.06);
            if (style < 0.5 || (style > 2.5 && style < 3.5)) glass = vec3(0.05, 0.08, 0.12);

            // window-local coordinates and interior room seen through the glass
            vec2 w = clamp((f - m0) / wf, 0.0, 1.0);
            float office = (style < 0.5 || (style > 2.5 && style < 3.5)) ? 1.0 : 0.0;
            float rnd = h12(cell * 3.1 + seed * 5.0);
            vec3 lightCol = lc * inten * uNight * lit + vec3(0.012, 0.014, 0.02) * (1.0 - lit);
            vec3 room = interiorRoom(w, cs * wf, office > 0.5 ? 5.0 : 3.2, Vt, lightCol, rnd, office);
            // curtains / blinds
            float cur = step(0.55, h12(cell + 3.3));
            if (office > 0.5) {
              float blinds = step(0.5, fract(w.y * 22.0)) * step(0.7, rnd) * step(w.y, 0.35 + rnd * 0.6);
              room = mix(room, lightCol * 0.55, blinds * 0.85);
            } else {
              float cw = 0.18 + 0.2 * rnd;
              float folds = 0.75 + 0.25 * sin(w.x * 60.0 + rnd * 9.0);
              float drape = cur * (step(w.x, cw) + step(1.0 - cw, w.x));
              room = mix(room, lightCol * 0.7 * folds * vec3(1.0, 0.9, 0.8), clamp(drape, 0.0, 1.0));
            }
            // flat average far away
            vec3 roomAvg = lightCol * 0.75;
            room = mix(roomAvg, room, detail);
            // window frames / mullions
            float frameW = office > 0.5 ? 0.0 : (step(abs(w.x - 0.5), 0.018) + (style > 0.5 && style < 1.5 ? step(abs(w.y - 0.68), 0.02) : 0.0));
            float edge = 1.0 - step(0.025, w.x) * step(w.x, 0.975) * step(0.025, w.y) * step(w.y, 0.975);
            float frame = clamp(frameW + edge, 0.0, 1.0) * detail;

            if (q.y < 0.0) {
              // ground floor
              if (style > 3.5 || (style > 0.5 && style < 1.5)) {
                float bay = fract(p.x / 6.0);
                float shopWin = step(0.5, p.y) * step(p.y, 3.4) * step(0.1, bay) * step(bay, 0.9);
                float on = step(0.25, h12(vec2(floor(p.x/6.0), seed+1.0)));
                vec3 sc = mix(uWarm, vec3(1.0,0.9,0.8), h12(vec2(floor(p.x/6.0), seed)) * 0.6) * (0.85 * uNight * on + 0.04);
                vec2 sw = vec2((bay - 0.1) / 0.8, (p.y - 0.5) / 2.9);
                vec3 shop = interiorRoom(clamp(sw, 0.0, 1.0), vec2(4.8, 2.9), 5.0, Vt, sc, h12(vec2(floor(p.x/6.0), seed + 4.0)), 2.0);
                float sframe = 1.0 - step(0.012, sw.x) * step(sw.x, 0.988) * step(0.02, sw.y) * step(sw.y, 0.98);
                diffuseColor.rgb = mix(wall * 0.55, glass, shopWin);
                fEmis += shop * shopWin * (1.0 - sframe);
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08), sframe * shopWin);
                fRough = mix(0.85, 0.1, shopWin);
                fMetal = 0.4 * shopWin;
              } else if (style > 1.5 && style < 2.5) {
                // old town: wooden lattice + warm paper glow
                float lat = step(0.85, fract(p.x*2.5)) + step(0.85, fract(p.y*2.5));
                float door = step(0.4, p.y) * step(p.y, 2.6) * step(0.15, fract(p.x/4.0)) * step(fract(p.x/4.0), 0.85);
                vec3 paper = vec3(1.0, 0.72, 0.42);
                diffuseColor.rgb = mix(wall, mix(paper*0.3, vec3(0.12,0.08,0.05), clamp(lat,0.0,1.0)), door);
                fEmis += paper * door * (1.0 - clamp(lat,0.0,1.0)) * 1.0 * uNight * step(0.3, h12(vec2(floor(p.x/4.0), seed)));
              } else {
                diffuseColor.rgb = wall * 0.7;
              }
            } else {
              vec3 col = mix(wall, glass, win);
              col = mix(col, vec3(0.9,0.93,1.0), sill * (1.0 - win));
              // floor slab lines
              col *= 1.0 - 0.25 * step(0.97, fract(q.y / cs.y)) * (1.0 - win);
              col = mix(col, vec3(0.1, 0.1, 0.11), frame * win);
              diffuseColor.rgb = col;
              fRough = mix(0.88, 0.06, win * (1.0 - frame));
              fMetal = mix(0.0, 0.55, win * (1.0 - frame));
              fEmis += room * win * (1.0 - frame);
              if (style > 1.5 && style < 2.5) {
                // shoji lattice on old town windows
                float lat2 = step(0.88, fract(f.x * 3.0)) + step(0.88, fract(f.y * 3.0));
                fEmis *= 1.0 - 0.7 * clamp(lat2, 0.0, 1.0) * detail;
              }
            }
          }
        }`
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = fRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = fMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fEmis;');
  };
  return mat;
}

// ------------------------------------------------------------------ video screens
export function createScreenMaterial(seed) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = sharedUniforms.uTime;
    sh.uniforms.uSeed = { value: seed };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSUv;\nuniform float uTime;\nuniform float uSeed;\n' + HASH)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec2 uv = vSUv;
          float t = uTime * 0.6 + uSeed * 10.0;
          float scene = floor(mod(t / 4.0, 4.0));
          vec3 c;
          if (scene < 1.0) {
            c = 0.5 + 0.5*cos(6.2831*(uv.x*0.6 + t*0.15 + vec3(0.0,0.33,0.67)));
            c *= 0.6 + 0.4*sin(uv.y*30.0 + t*4.0);
          } else if (scene < 2.0) {
            vec2 g = floor(uv * vec2(16.0, 9.0));
            float b = step(0.5, h12(g + floor(t*3.0)));
            c = mix(vec3(0.05,0.0,0.2), vec3(1.0,0.2,0.6), b);
          } else if (scene < 3.0) {
            float r = length(uv - 0.5);
            c = vec3(0.1,0.6,1.0) * (0.5 + 0.5*sin(r*40.0 - t*6.0)) + vec3(1.0,0.9,0.4)*smoothstep(0.12,0.0,r);
          } else {
            float bar = step(0.5, fract(uv.x*6.0 - t*0.5));
            c = mix(vec3(1.0,0.75,0.1), vec3(0.95,0.2,0.1), bar) * (0.7 + 0.3*uv.y);
          }
          float scan = 0.85 + 0.15*sin(vSUv.y*500.0);
          float edge = smoothstep(0.0, 0.02, uv.x) * smoothstep(1.0, 0.98, uv.x) * smoothstep(0.0, 0.03, uv.y) * smoothstep(1.0, 0.97, uv.y);
          diffuseColor.rgb = c * scan * edge * 1.35;
        }`
      );
  };
  return mat;
}

// ------------------------------------------------------------------ sky
export function createSkyMaterial(stage, sunOverride = null) {
  const s = stage.sky;
  const sunDir = sunOverride ? sunOverride.clone() : new THREE.Vector3(...s.sunDir).normalize();
  return new THREE.ShaderMaterial({
    defines: s.aurora > 0 ? { AURORA: 1 } : {},
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: sharedUniforms.uTime,
      uZenith: { value: new THREE.Color(s.zenith) },
      uHorizon: { value: new THREE.Color(s.horizon) },
      uGlow: { value: new THREE.Color(s.glow) },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(s.sunColor) },
      uSunSize: { value: s.sunSize },
      uSunGlow: { value: s.sunGlow },
      uMoon: { value: s.moon ? 1 : 0 },
      uStars: { value: s.stars },
      uAurora: { value: s.aurora },
      uClouds: { value: s.clouds },
      uCloudColor: { value: new THREE.Color(s.cloudColor) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uTime;
      uniform vec3 uZenith, uHorizon, uGlow, uSunDir, uSunColor, uCloudColor;
      uniform float uSunSize, uSunGlow, uMoon, uStars, uAurora, uClouds;
      ${HASH}
      float n2(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(h12(i),h12(i+vec2(1,0)),u.x), mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),u.x), u.y); }
      float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<5;i++){ v+=a*n2(p); p*=2.02; a*=0.5; } return v; }
      #ifdef AURORA
      // "Auroras" technique by nimitz (triangle noise curtains)
      mat2 mm2(float a){ float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
      float tri(float x){ return clamp(abs(fract(x) - 0.5), 0.01, 0.49); }
      vec2 tri2(vec2 p){ return vec2(tri(p.x) + tri(p.y), tri(p.y + tri(p.x))); }
      float triNoise2d(vec2 p, float spd){
        float z = 1.8, z2 = 2.5, rz = 0.0;
        p *= mm2(p.x * 0.06);
        vec2 bp = p;
        const mat2 m2 = mat2(0.95534, 0.29552, -0.29552, 0.95534);
        for (int i = 0; i < 5; i++) {
          vec2 dg = tri2(bp * 1.85) * 0.75;
          dg *= mm2(uTime * spd);
          p -= dg / z2;
          bp *= 1.3; z2 *= 0.45; z *= 0.42;
          p *= 1.21 + (rz - 1.0) * 0.02;
          rz += tri(p.x + tri(p.y)) * z;
          p *= -m2;
        }
        return clamp(1.0 / pow(rz * 29.0, 1.3), 0.0, 0.55);
      }
      #endif
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        float hp = max(h, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(hp, 0.45));
        // horizon city glow
        col += uGlow * 0.35 * exp(-hp * 9.0);
        col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.25, h));
        float sd = dot(d, uSunDir);
        // sun / moon
        col += uSunColor * uSunGlow * (pow(max(sd,0.0), 6.0) * 0.35 + pow(max(sd,0.0), 60.0) * 0.8);
        float disk = smoothstep(cos(uSunSize), cos(uSunSize * 0.85), sd);
        if (uMoon > 0.5) {
          vec2 mp = vec2(dot(d, normalize(cross(uSunDir, vec3(0,1,0)))), d.y - uSunDir.y) / uSunSize;
          float crater = 0.75 + 0.25 * n2(mp * 3.0 + 4.0);
          col = mix(col, uSunColor * 2.2 * crater, disk);
          col += uSunColor * 0.25 * pow(max(sd, 0.0), 300.0);
        } else {
          col += uSunColor * disk * 6.0;
        }
        // stars
        if (uStars > 0.0) {
          vec3 sp = d * 260.0;
          vec3 cell = floor(sp);
          float st = h13(cell);
          vec3 fp = fract(sp) - 0.5;
          float star = step(0.985, st) * smoothstep(0.32, 0.0, length(fp));
          float tw = 0.6 + 0.4 * sin(uTime * (2.0 + st * 6.0) + st * 50.0);
          col += vec3(0.85, 0.9, 1.0) * star * tw * uStars * smoothstep(0.02, 0.3, h) * 2.5;
          // milky band
          float band = exp(-pow(dot(d, normalize(vec3(0.6, 0.6, -0.5))) * 3.0, 2.0));
          col += vec3(0.25, 0.22, 0.35) * band * fbm(d.xz * 8.0) * uStars * 0.25 * smoothstep(0.0, 0.4, h);
        }
        #ifdef AURORA
        if (h > 0.0) {
          vec3 ro = vec3(0.0, 0.0, -6.7);
          vec3 rd = vec3(d.x, d.y, d.z);
          vec4 acc = vec4(0.0);
          vec4 avg = vec4(0.0);
          for (int k = 0; k < 30; k++) {
            float i = float(k) * 1.65;
            float of = 0.006 * h12(gl_FragCoord.xy) * smoothstep(0.0, 15.0, i);
            float pt = ((0.8 + pow(i, 1.4) * 0.002) - ro.y) / (rd.y * 2.0 + 0.4);
            pt -= of;
            vec3 bp = ro + pt * rd;
            float rz = triNoise2d(bp.zx, 0.06);
            vec4 c2 = vec4((sin(1.0 - vec3(2.15, -0.5, 1.2) + i * 0.043) * 0.5 + 0.5) * rz, rz);
            avg = mix(avg, c2, 0.5);
            acc += avg * exp2(-i * 0.065 - 2.5) * smoothstep(0.0, 5.0, i);
          }
          acc *= clamp(rd.y * 15.0 + 0.4, 0.0, 1.0);
          col += acc.rgb * 1.5 * uAurora;

        }
        #endif
        // clouds
        if (uClouds > 0.0 && h > 0.0) {
          vec2 cp = d.xz / (h + 0.12) * 1.4 + vec2(uTime * 0.004, 0.0);
          float c = fbm(cp * 1.3);
          c = smoothstep(0.45, 0.85, c) * uClouds;
          vec3 cc = uCloudColor * (0.7 + 0.8 * pow(max(sd, 0.0), 4.0));
          col = mix(col, cc, c * smoothstep(0.0, 0.15, h) * 0.85);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}
