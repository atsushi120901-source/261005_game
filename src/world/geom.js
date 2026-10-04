import * as THREE from 'three';

// Helper to accumulate non-indexed triangle soup with arbitrary attributes.
export class GeoBuilder {
  constructor(attrs = { color: 3, aFacade: 4 }) {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.extra = {};
    this.attrSizes = attrs;
    for (const k in attrs) this.extra[k] = [];
  }
  get count() {
    return this.pos.length / 3;
  }
  // Quad p0..p3 (counter clockwise seen from outside), with outward hint.
  quad(p0, p1, p2, p3, uvs, attrs, outward) {
    _a.subVectors(p1, p0);
    _b.subVectors(p3, p0);
    _n.crossVectors(_a, _b).normalize();
    let ps = [p0, p1, p2, p3];
    let us = uvs;
    if (outward && _n.dot(outward) < 0) {
      ps = [p0, p3, p2, p1];
      us = [uvs[0], uvs[3], uvs[2], uvs[1]];
      _n.negate();
    }
    const idx = [0, 1, 2, 0, 2, 3];
    for (const i of idx) {
      this.pos.push(ps[i].x, ps[i].y, ps[i].z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.uv.push(us[i][0], us[i][1]);
      for (const k in this.attrSizes) {
        const v = attrs[k];
        for (let j = 0; j < this.attrSizes[k]; j++) this.extra[k].push(v[j]);
      }
    }
  }
  tri(p0, p1, p2, uvs, attrs, outward) {
    _a.subVectors(p1, p0);
    _b.subVectors(p2, p0);
    _n.crossVectors(_a, _b).normalize();
    let ps = [p0, p1, p2];
    let us = uvs;
    if (outward && _n.dot(outward) < 0) {
      ps = [p0, p2, p1];
      us = [uvs[0], uvs[2], uvs[1]];
      _n.negate();
    }
    for (let i = 0; i < 3; i++) {
      this.pos.push(ps[i].x, ps[i].y, ps[i].z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.uv.push(us[i][0], us[i][1]);
      for (const k in this.attrSizes) {
        const v = attrs[k];
        for (let j = 0; j < this.attrSizes[k]; j++) this.extra[k].push(v[j]);
      }
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const k in this.attrSizes) {
      g.setAttribute(k, new THREE.Float32BufferAttribute(this.extra[k], this.attrSizes[k]));
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();

// Bake a transform + vertex color into a cloned geometry (for merging).
export function bake(geo, matrix, color) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(matrix);
  if (color !== undefined) {
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  // keep only common attributes
  for (const k of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
  }
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  return g;
}
