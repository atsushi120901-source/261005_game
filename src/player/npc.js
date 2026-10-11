import * as THREE from 'three';
import { Character } from './character.js';
import { damp, clamp } from '../core/utils.js';

// Other riders sharing the mountain: they carve lazy turns down the slope
// ahead of the player and respawn further down once they are passed.
const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _n = new THREE.Vector3();
const _f = {};

export class NpcRider {
  constructor(scene, track, def, seed) {
    this.track = track;
    this.char = new Character(def, { cell: 0.02 }); // lighter body for riders seen at a distance
    this.char.root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    scene.add(this.char.root, this.char.extras);
    this.scene = scene;
    this.seed = seed;
    this.t = seed * 3.1;
    this.alignQ = new THREE.Quaternion();
    this.edge = 0;
  }

  place(s, nearU = 0) {
    const tr = this.track;
    this.s = s;
    this.route = tr.nearestRoute ? tr.nearestRoute(s, nearU) : null;
    this.base = (Math.random() - 0.5) * 8;
    this.speed = 12 + Math.random() * 5;
    this.width = 3 + Math.random() * 3;
    if (this.route) {
      const c = this.route.at(s, {});
      this.off = (Math.random() - 0.5) * c.w * 0.6;
      this.u = c.u + this.off;
    } else {
      this.u = (Math.random() - 0.5) * 12;
    }
    this.char.setPose('ride');
    this.char.snap();
    this.char.resetStrands();
  }

  update(dt, playerS, playerU = 0) {
    const tr = this.track;
    const far = this.route && (Math.abs(this.u - playerU) > 160 || this.s > this.route.s1 - 10);
    if (this.s === undefined || this.s < playerS - 25 || this.s > playerS + 260 || far) this.place(Math.min(tr.finishS - 20, playerS + 70 + Math.random() * 90), playerU);
    this.t += dt;
    const prevU = this.u;
    this.s += this.speed * dt;
    let target;
    if (this.route) {
      const c = this.route.at(Math.min(this.s, this.route.s1), {});
      target = c.u + clamp(this.off + Math.sin(this.t * 0.75 + this.seed) * this.width, -c.w * 0.7, c.w * 0.7);
    } else {
      target = clamp(this.base + Math.sin(this.t * 0.75 + this.seed) * this.width, -9, 9);
    }
    this.u = damp(this.u, target, 1.4, dt);
    const vu = (this.u - prevU) / Math.max(dt, 1e-4);
    const phi = Math.atan2(vu, this.speed);
    const y = tr.height(this.s, this.u);
    const root = this.char.root;
    tr.toWorld(this.s, this.u, y, root.position);
    tr.normal(this.s, this.u, _n);
    _q.setFromUnitVectors(UP, _n);
    this.alignQ.slerp(_q, 1 - Math.exp(-10 * dt));
    const f = tr.frame(this.s, _f);
    const nx = f.tx * Math.cos(phi) + f.rx * Math.sin(phi), nz = f.tz * Math.cos(phi) + f.rz * Math.sin(phi);
    root.quaternion.copy(this.alignQ).multiply(_q2.setFromAxisAngle(UP, Math.atan2(-nx, -nz)));
    const turn = clamp(vu / 6, -1, 1);
    this.edge = damp(this.edge, turn * 0.45, 5, dt);
    root.quaternion.multiply(_q2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -this.edge));
    this.char.setPose('ride', { carve: turn });
    this.char.update(dt, { wind: new THREE.Vector3(-nx * 20, 2, -nz * 20), shadow: { p: root.position, n: _n, h: 0, yaw: Math.atan2(-nx, -nz) } });
  }

  dispose() {
    this.scene.remove(this.char.root, this.char.extras);
    this.char.dispose();
  }
}
