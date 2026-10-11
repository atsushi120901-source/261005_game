import * as THREE from 'three';

// Tileable procedural normal maps for clothing: nylon shell wrinkles,
// baggy pant folds and knit ribbing. Built once and shared.

const cache = new Map();
const TAU = Math.PI * 2;

function heightFn(kind) {
  if (kind === 'knit') {
    // vertical ribs with a small stitch pattern
    return (u, v) => {
      const rib = Math.pow(Math.abs(Math.sin(u * TAU * 24)), 0.6);
      const stitch = 0.25 * Math.sin(v * TAU * 64 + Math.sin(u * TAU * 24) * 1.5);
      return rib + stitch * 0.4;
    };
  }
  const folds = kind === 'pants'
    ? [[2, 1, 0.7, 0.3], [3, 2, 0.45, 1.7], [5, 3, 0.25, 2.9]]
    : [[2, 1, 0.55, 0.4], [4, 2, 0.35, 2.2], [7, 3, 0.2, 1.1]];
  return (u, v) => {
    let h = 0;
    // soft horizontal compression wrinkles that wander around the limb
    for (const [fv, fu, a, ph] of folds) {
      // strongly warped so folds run diagonally and fade in and out around the limb
      const warp = 0.35 * Math.sin(TAU * (u * fu) + ph) + 0.15 * Math.sin(TAU * (u * (fu + 2)) + ph * 2);
      const fade = 0.55 + 0.45 * Math.sin(TAU * (u * (fu + 1)) + ph * 3);
      h += a * fade * Math.pow(0.5 + 0.5 * Math.sin(TAU * (v * fv + warp) + ph), 3.0);
    }
    // fine woven texture
    h += 0.035 * Math.sin(u * TAU * 96) * Math.sin(v * TAU * 96);
    return h;
  };
}

export function fabricNormal(kind = 'nylon', strength = 4) {
  const key = kind + strength;
  if (cache.has(key)) return cache.get(key);
  const N = 256;
  const f = heightFn(kind);
  const H = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) H[y * N + x] = f(x / N, y / N);
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const l = H[y * N + ((x - 1 + N) % N)], r = H[y * N + ((x + 1) % N)];
      const d = H[((y - 1 + N) % N) * N + x], u = H[((y + 1) % N) * N + x];
      let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * N + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}

// Weathering map (multiplied over the garment colour): soft stains, scuffs,
// dust specks and a few lighter faded patches.
const grimeCache = new Map();
export function grimeTexture(seed = 1, amount = 1) {
  const key = seed + ':' + amount;
  if (grimeCache.has(key)) return grimeCache.get(key);
  let a = seed * 9301 + 49297;
  const rnd = () => ((a = (a * 233280 + 12345) % 2147483647) / 2147483647);
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, N, N);
  const blob = (x, y, r, col, alpha) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${col},${alpha})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    // draw wrapped so the texture tiles
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) { ctx.save(); ctx.translate(dx, dy); ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.restore(); }
  };
  // large soft dirt stains
  for (let i = 0; i < 22 * amount; i++) blob(rnd() * N, rnd() * N, 14 + rnd() * 70, rnd() < 0.5 ? '120,100,80' : '95,92,95', 0.14 + rnd() * 0.24);
  // faded / sun-bleached patches
  for (let i = 0; i < 6 * amount; i++) blob(rnd() * N, rnd() * N, 18 + rnd() * 40, '255,250,240', 0.25);
  // scuffs and scratches
  ctx.lineCap = 'round';
  for (let i = 0; i < 22 * amount; i++) {
    const x = rnd() * N, y = rnd() * N, l = 4 + rnd() * 18, ang = rnd() * Math.PI;
    ctx.strokeStyle = `rgba(${rnd() < 0.6 ? '90,80,70' : '255,255,255'},${0.06 + rnd() * 0.12})`;
    ctx.lineWidth = 0.6 + rnd() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * l, y + Math.sin(ang) * l);
    ctx.stroke();
  }
  // dust specks
  const img = ctx.getImageData(0, 0, N, N);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 18 * amount;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n * 0.9));
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  grimeCache.set(key, t);
  return t;
}
