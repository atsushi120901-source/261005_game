import * as THREE from 'three';
import { mulberry32, fbm2 } from '../core/utils.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let _snowNormal = null;
// Tileable snow normal map built from layered noise.
export function snowNormalTexture() {
  if (_snowNormal) return _snowNormal;
  const N = 256;
  const hgt = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // tileable noise by sampling a torus
      const a = (x / N) * Math.PI * 2, b = (y / N) * Math.PI * 2;
      const nx = Math.cos(a) * 3, ny = Math.sin(a) * 3, nz = Math.cos(b) * 3, nw = Math.sin(b) * 3;
      hgt[y * N + x] = fbm2(nx + nz * 0.7, ny + nw * 0.7, 5) * 0.7 + fbm2(nx * 4 + nw, nz * 4 + ny, 3) * 0.3;
    }
  }
  const c = canvas(N, N);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const k = 3.2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const l = hgt[y * N + ((x - 1 + N) % N)], r = hgt[y * N + ((x + 1) % N)];
      const d = hgt[((y - 1 + N) % N) * N + x], u = hgt[((y + 1) % N) * N + x];
      let dx = (l - r) * k, dy = (d - u) * k, dz = 1;
      const len = Math.hypot(dx, dy, dz);
      dx /= len; dy /= len; dz /= len;
      const i = (y * N + x) * 4;
      img.data[i] = (dx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy * 0.5 + 0.5) * 255;
      img.data[i + 2] = (dz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  _snowNormal = t;
  return t;
}

let _glow = null;
export function glowTexture() {
  if (_glow) return _glow;
  const c = canvas(128, 128);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.65)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c);
  _glow.colorSpace = THREE.SRGBColorSpace;
  return _glow;
}

const hex = (c) => '#' + new THREE.Color(c).getHexString();

// Neon sign: returns { map, aspect }. The text glows on a dark panel.
export function neonSignTexture(text, color, vertical, seed = 1) {
  const rng = mulberry32(seed);
  const chars = [...text];
  const fs = 96;
  let w, h;
  if (vertical) {
    w = 160;
    h = Math.max(1, chars.length) * (fs + 16) + 60;
  } else {
    w = Math.max(3, chars.length) * fs * (/[　-鿿]/.test(text) ? 1.05 : 0.68) + 90;
    h = 170;
  }
  const c = canvas(Math.ceil(w), Math.ceil(h));
  const ctx = c.getContext('2d');
  // panel
  const panelDark = rng() < 0.6;
  ctx.fillStyle = panelDark ? '#0b0910' : hex(new THREE.Color(color).multiplyScalar(0.18));
  ctx.fillRect(0, 0, c.width, c.height);
  // tube border
  ctx.strokeStyle = hex(color);
  ctx.lineWidth = 6;
  ctx.shadowColor = hex(color);
  ctx.shadowBlur = 24;
  ctx.strokeRect(12, 12, c.width - 24, c.height - 24);
  // text
  ctx.font = `900 ${fs}px "Hiragino Sans","Noto Sans JP","Yu Gothic","Meiryo",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const draw = (blur, col) => {
    ctx.shadowBlur = blur;
    ctx.fillStyle = col;
    if (vertical) {
      chars.forEach((ch, i) => ctx.fillText(ch, c.width / 2, 30 + (fs + 16) * (i + 0.5) + 8));
    } else {
      ctx.fillText(text, c.width / 2, c.height / 2 + 6);
    }
  };
  draw(40, hex(color));
  draw(14, hex(color));
  draw(0, '#ffffff');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { map: t, aspect: c.width / c.height };
}

// Snowboard top-sheet graphic.
export function boardTexture(colors, label, pattern = 0) {
  const c = canvas(256, 1024);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 1024);
  g.addColorStop(0, hex(colors[0]));
  g.addColorStop(0.5, hex(colors[1]));
  g.addColorStop(1, hex(colors[0]));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1024);
  ctx.save();
  if (pattern === 0) {
    // diagonal stripes
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = hex(colors[2]);
    for (let i = -10; i < 30; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * 60);
      ctx.lineTo(256, i * 60 - 160);
      ctx.lineTo(256, i * 60 - 130);
      ctx.lineTo(0, i * 60 + 30);
      ctx.fill();
    }
  } else if (pattern === 1) {
    // circles
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = hex(colors[2]);
    ctx.lineWidth = 10;
    for (let i = 0; i < 9; i++) {
      ctx.beginPath();
      ctx.arc(128, 512, 30 + i * 46, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    // mountain / skyline zigzag
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = hex(colors[2]);
    for (let y = 200; y < 900; y += 140) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= 256; x += 32) ctx.lineTo(x, y - ((x / 32) % 2 ? 50 : 0));
      ctx.lineTo(256, y + 40);
      ctx.lineTo(0, y + 40);
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.save();
  ctx.translate(128, 512);
  ctx.rotate(-Math.PI / 2);
  ctx.font = '900 92px "Arial Black", Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillText(label, 6, 6);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, 0, 0);
  ctx.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Banner text texture (start / finish gates).
export function bannerTexture(text, bg, fg) {
  const c = canvas(1024, 192);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 1024, 0);
  g.addColorStop(0, hex(bg[0]));
  g.addColorStop(1, hex(bg[1]));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 192);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (let x = -200; x < 1100; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x + 30, 0); ctx.lineTo(x - 50, 192); ctx.lineTo(x - 80, 192);
    ctx.fill();
  }
  ctx.font = 'italic 900 120px "Arial Black", Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hex(fg);
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 12;
  ctx.fillText(text, 512, 100);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Vending machine front panel.
export function vendingTexture(seed) {
  const rng = mulberry32(seed);
  const c = canvas(128, 256);
  const ctx = c.getContext('2d');
  const base = rng.pick(['#e8eef5', '#d92b2b', '#1b4fd1', '#f2f2f2', '#12a05a']);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 256);
  ctx.fillStyle = '#dff3ff';
  ctx.fillRect(10, 14, 108, 130);
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 6; k++) {
      ctx.fillStyle = rng.pick(['#ff5a5a', '#3a7bff', '#ffd23a', '#38c172', '#ffffff', '#ff8a3a', '#7a4aff']);
      ctx.fillRect(16 + k * 17, 22 + r * 31, 11, 20);
      ctx.fillStyle = '#f33';
      ctx.fillRect(18 + k * 17, 44 + r * 31, 7, 3);
    }
  }
  ctx.fillStyle = '#222';
  ctx.fillRect(14, 196, 100, 34);
  ctx.fillStyle = '#9fb';
  ctx.fillRect(96, 160, 14, 10);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
