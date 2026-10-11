import { buildRiderData } from './riderModel.js';

// Off-main-thread sculpting of rider bodies.
self.onmessage = (e) => {
  const { key, look, bind, cell } = e.data;
  const t0 = performance.now();
  const d = buildRiderData(look, bind, cell);
  d.ms = performance.now() - t0;
  self.postMessage({ key, data: d }, [d.position.buffer, d.normal.buffer, d.color.buffer, d.aMat.buffer, d.skinIndex.buffer, d.skinWeight.buffer, d.index.buffer]);
};
