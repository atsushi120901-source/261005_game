import * as THREE from 'three';
import { damp, dampAngle, clamp, noise1 } from '../core/utils.js';
import { BUILD_U } from '../world/track.js';

// Chase camera that lives in track space so it never clips into buildings
// or the snow, plus an orbit mode for menus.
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'follow';
    this.dir = 0; // smoothed travel angle in track space
    this.cs = 0; this.cu = 0; this.cy = 0;
    this.look = new THREE.Vector3();
    this.shakeAmt = 0;
    this.t = 0;
    this.fov = 62;
    this.side = 0;
    this.orbitAngle = 0;
  }

  shake(a) {
    this.shakeAmt = Math.max(this.shakeAmt, a);
  }

  snapTo(rider) {
    const tr = rider.track;
    this.dir = Math.atan2(rider.vu, Math.max(0.1, rider.vs));
    this.cs = rider.s - 7;
    this.cu = rider.u;
    this.cy = rider.y + 3;
    this.look.copy(rider.position);
    this._apply(tr);
  }

  update(dt, rider) {
    this.t += dt;
    const tr = rider.track;
    const sp = rider.groundSpeed;
    if (this.mode === 'follow') {
      const air = rider.state === 'air';
      if (sp > 1.5) this.dir = dampAngle(this.dir, Math.atan2(rider.vu, rider.vs), air ? 1.5 : 3.5, dt);
      // keep facing downhill-ish
      this.dir = clamp(this.dir, -1.2, 1.2);
      const dist = 4.4 + Math.min(sp, 35) * 0.055 + (air ? 0.9 : 0);
      const hgt = 1.85 + (air ? 0.3 : 0);
      // cinematic side offset during big airs
      const wantSide = air && rider.airTime > 0.35 ? (rider.u > 0 ? -1 : 1) * 2.6 : 0;
      this.side = damp(this.side, wantSide, 1.8, dt);
      const ts = rider.s - Math.cos(this.dir) * dist;
      let tu = rider.u - Math.sin(this.dir) * dist + this.side;
      tu = clamp(tu, -(BUILD_U - 1.6), BUILD_U - 1.6);
      const ground = tr.height(ts, tu, false) + 1.0;
      let ty = Math.max(ground, rider.y + hgt);
      if (air) ty = Math.max(ground + 0.5, rider.y + hgt - Math.min(1.6, rider.airTime * 1.2));
      if (rider.state === 'crash') ty = Math.max(ground + 1.5, rider.y + 3.5);
      const k = rider.state === 'crash' ? 2 : 7;
      this.cs = damp(this.cs, ts, k, dt);
      this.cu = damp(this.cu, tu, air ? 3 : 5, dt);
      this.cy = damp(this.cy, ty, air ? 4 : 7, dt);
      if (this.cy < ground) this.cy = ground;
      const ahead = 2.5 + sp * 0.05;
      const lookTarget = tr.toWorld(rider.s + Math.cos(this.dir) * ahead, rider.u + Math.sin(this.dir) * ahead, rider.y + 1.0, _v);
      if (air) lookTarget.lerp(rider.position, 0.75).y += 0.5;
      this.look.x = damp(this.look.x, lookTarget.x, 10, dt);
      this.look.y = damp(this.look.y, lookTarget.y, 8, dt);
      this.look.z = damp(this.look.z, lookTarget.z, 10, dt);
      this.fov = damp(this.fov, 60 + clamp(sp / 32, 0, 1) * 18 + (air ? 3 : 0), 2.5, dt);
      this._apply(tr);
    } else if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.18;
      const p = rider.position;
      const r = 4.2;
      this.camera.position.set(p.x + Math.cos(this.orbitAngle) * r, p.y + 1.3 + Math.sin(this.t * 0.3) * 0.2, p.z + Math.sin(this.orbitAngle) * r);
      this._frame(p, 0.9, this.offsetX ?? -1.2);
      this.fov = 42;
    } else if (this.mode === 'inspect') {
      const p = rider.position;
      const a = this.inspectAngle ?? 0.6;
      const d = this.inspectDist ?? 4.2;
      this.camera.position.set(p.x + Math.cos(a) * d, p.y + (this.inspectH ?? 1.0), p.z + Math.sin(a) * d);
      this.look.set(p.x, p.y + 0.85, p.z);
      this.camera.lookAt(this.look);
      this.fov = 35;
    } else if (this.mode === 'showcase') {
      // slow cinematic dolly in front of the rider (character select)
      const p = rider.position;
      const fwd = rider.forward;
      const a = Math.sin(this.t * 0.25) * 0.5;
      const cx = Math.cos(a), sx = Math.sin(a);
      // rider faces +X of the board -> right of forward vector
      const rx = -fwd.z, rz = fwd.x;
      const dx = rx * cx + fwd.x * sx, dz = rz * cx + fwd.z * sx;
      this.camera.position.set(p.x + dx * 3.6, p.y + 1.15, p.z + dz * 3.6);
      this._frame(p, 0.85, this.offsetX ?? 0.0);
      this.fov = 38;
    }
    // shake
    if (this.shakeAmt > 0.001) {
      const s = this.shakeAmt;
      this.camera.position.x += noise1(this.t * 31) * s * 0.25;
      this.camera.position.y += noise1(this.t * 37 + 10) * s * 0.25;
      this.camera.position.z += noise1(this.t * 29 + 20) * s * 0.25;
      this.shakeAmt *= Math.exp(-dt * 7);
    }
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  // Look at the rider but shift the framing sideways so UI panels don't cover them.
  _frame(p, h, side) {
    _d.set(p.x - this.camera.position.x, 0, p.z - this.camera.position.z).normalize();
    // camera right vector = dir x up
    this.look.set(p.x - _d.z * side, p.y + h, p.z + _d.x * side);
    this.camera.lookAt(this.look);
  }

  _apply(tr) {
    tr.toWorld(this.cs, this.cu, this.cy, this.camera.position);
    this.camera.lookAt(this.look);
  }
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
