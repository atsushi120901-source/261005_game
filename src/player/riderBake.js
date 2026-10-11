import { buildRiderData } from './riderModel.js';
import { bodyGeometry } from './sdfBody.js';

// Rider bodies are sculpted once per rider and cached. The work runs in a
// Web Worker when available so menus and gameplay never stall.
const cache = new Map();
let worker = null;
const pending = new Map();

function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./bodyWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { key, data } = e.data;
      const p = pending.get(key);
      pending.delete(key);
      const geo = bodyGeometry(data);
      geo.userData.cached = true;
      geo.userData.buildMs = data.ms;
      p?.resolve(geo);
    };
    worker.onerror = () => { worker = false; for (const [k, p] of pending) { pending.delete(k); p.fallback(); } };
  } catch {
    worker = false;
  }
  return worker;
}

export function bakeRider(def, bind, cell = 0.012) {
  const key = def.id + ':' + cell;
  if (cache.has(key)) return cache.get(key);
  const bindArr = bind.map((m) => Array.from(m.elements));
  const local = () => {
    const geo = bodyGeometry(buildRiderData(def.look, bindArr, cell));
    geo.userData.cached = true;
    return geo;
  };
  const w = getWorker();
  const prom = w
    ? new Promise((resolve) => {
      pending.set(key, { resolve, fallback: () => resolve(local()) });
      w.postMessage({ key, look: def.look, bind: bindArr, cell });
    })
    : Promise.resolve().then(local);
  cache.set(key, prom);
  return prom;
}
