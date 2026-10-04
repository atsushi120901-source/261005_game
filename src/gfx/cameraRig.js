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
    // dynamic shots
    this.camMode = 'dynamic'; // dynamic | chase | pov
    this.shot = null;
    this.shotW = 0;
    this.shotPos = new THREE.Vector3();
    this.shotLook = new THREE.Vector3();
    this.shotFov = 55;
    this.variant = 0;
    this.prevState = 'ground';
    this.roll = 0;
  }

  cycleMode() {
    const order = ['dynamic', 'chase', 'pov'];
    this.camMode = order[(order.indexOf(this.camMode) + 1) % order.length];
    this.shot = null;
    return this.camMode;
  }

  // Field of view that keeps a subject of about \`size\` metres framed from the shot position.
  _zoom(p, size) {
    const d = this.shotPos.distanceTo(p);
    return clamp((2 * Math.atan(size / Math.max(d, 0.5)) * 180) / Math.PI, 26, 66);
  }

  // Decide on cinematic shots (big airs, grinds) and compute their framing.
  _shots(dt, rider, tr) {
    const st = rider.state;
    const enter = st !== this.prevState;
    this.prevState = st;
    if (this.camMode !== 'dynamic' || this.intro > 0) {
      this.shot = null;
    } else if (enter && st === 'air') {
      const h = Math.max(0, rider.y - tr.height(rider.s, rider.u));
      const T = (rider.vy + Math.sqrt(Math.max(0, rider.vy * rider.vy + 2 * G * h))) / G;
      if (T > 1.15) {
        const kinds = ['side', 'low', 'orbit'];
        const kind = kinds[this.variant++ % kinds.length];
        const apex = h + (rider.vy > 0 ? (rider.vy * rider.vy) / (2 * G) : 0);
        const centre = rider.u > 0 ? -1 : 1; // keep the camera towards the middle of the street
        this.shot = { kind, t: 0, T, s0: rider.s, u0: rider.u, vs: rider.vs, vu: rider.vu, apex, side: centre, a0: Math.atan2(rider.vu, rider.vs) };
      }
    } else if (enter && st === 'grind') {
      this.shot = { kind: 'grind', t: 0, side: rider.u > 0 ? -1 : 1 };
    } else if (enter && st === 'crash') {
      this.shot = null;
    }
    const sh = this.shot;
    if (sh) {
      sh.t += dt;
      if (sh.kind !== 'grind' && st !== 'air') {
        sh.after = (sh.after || 0) + dt;
        if (sh.after > 0.45 || st === 'crash') this.shot = null;
      }
      if (sh.kind === 'grind' && st !== 'grind') this.shot = null;
    }
    this.shotW = damp(this.shotW, this.shot ? 1 : 0, this.shot ? 4.5 : 3, dt);
    if (!this.shot) return;
    const B = BUILD_U - 2.2;
    const p = rider.position;
    if (sh.kind === 'side') {
      // broadcast camera beside the flight path, holding position and panning
      const sm = sh.s0 + sh.vs * sh.T * 0.55;
      const um = clamp(sh.u0 + sh.vu * sh.T * 0.5 + sh.side * 8, -B, B);
      const y = tr.height(sm, um, false) + Math.max(1.6, sh.apex * 0.4);
      tr.toWorld(sm, um, y, this.shotPos);
      this.shotLook.copy(p).y += 0.6;
      this.shotFov = this._zoom(p, 3.4);
    } else if (sh.kind === 'low') {
      // hero shot from the landing, looking up at the rider against the sky
      const sm = sh.s0 + sh.vs * sh.T * 0.8 + 5;
      const um = clamp(sh.u0 + sh.vu * sh.T * 0.8 + sh.side * 4.5, -B, B);
      tr.toWorld(sm, um, tr.height(sm, um, false) + 0.8, this.shotPos);
      this.shotLook.copy(p).y += 0.4;
      this.shotFov = this._zoom(p, 4.2);
    } else if (sh.kind === 'orbit') {
      // swing around the rider during the flight
      const k = Math.min(1, sh.t / Math.max(0.6, sh.T));
      const a = sh.a0 + Math.PI + sh.side * (k * k * (3 - 2 * k)) * 2.4;
      const um = clamp(rider.u + Math.sin(a) * 6.2, -B, B);
      const sm = rider.s + Math.cos(a) * 6.2;
      tr.toWorld(sm, um, Math.max(rider.y + 1.2, tr.height(sm, um, false) + 1), this.shotPos);
      this.shotLook.copy(p).y += 0.7;
      this.shotFov = 58;
    } else if (sh.kind === 'grind') {
      // low tracking shot alongside the rail
      const um = clamp(rider.u + sh.side * 3.4, -B, B);
      tr.toWorld(rider.s - 1.8, um, rider.y + 0.55, this.shotPos);
      tr.toWorld(rider.s + 2.5, rider.u, rider.y + 0.6, this.shotLook);
      this.shotFov = 62;
    }
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
      this._shots(dt, rider, tr);
      // lean the horizon into carves for a sense of g-force
      const wantRoll = rider.state === 'ground' ? -rider.edge * 0.22 * clamp(sp / 18, 0, 1) : 0;
      this.roll = damp(this.roll, wantRoll * (this.camMode === 'pov' ? 1.8 : 1), 4, dt);
      this._apply(tr, rider);
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
      this.look.set(p.x, p.y + (this.inspectLook ?? 0.85), p.z);
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

  _apply(tr, rider) {
    tr.toWorld(this.cs, this.cu, this.cy, this.camera.position);
    if (rider && this.camMode === 'pov' && !(this.intro > 0) && rider.state !== 'crash') {
      // helmet cam: eyes of the rider, looking along the direction of travel
      const a = this.dir;
      tr.toWorld(rider.s + Math.cos(a) * 0.15, rider.u + Math.sin(a) * 0.15, rider.y + 1.5, this.camera.position);
      tr.toWorld(rider.s + Math.cos(a) * 12, rider.u + Math.sin(a) * 12, rider.y - 0.2, _d);
      this.camera.lookAt(_d);
      this.camera.rotateZ(this.roll);
      this.fov = Math.max(this.fov, 74);
      return;
    }
    const w = this.shotW;
    if (rider && w > 0.001) {
      const e = w * w * (3 - 2 * w);
      this.camera.position.lerp(this.shotPos, e);
      this.fov += (this.shotFov - this.fov) * e;
    }
    const look = w > 0.001 ? _l.copy(this.look).lerp(this.shotLook, w * w * (3 - 2 * w)) : this.look;
    const k = this.intro || 0;
    if (k > 0 && rider) {
      // countdown fly-around: start in front of the rider, swing behind
      const e = k * k * (3 - 2 * k);
      const a = e * 2.4;
      const ip = tr.toWorld(rider.s + Math.cos(a) * 6.5, rider.u + Math.sin(a) * 6.5, rider.y + 1.4 + e * 2.2, _v);
      this.camera.position.lerp(ip, e);
      _d.copy(rider.position).setY(rider.position.y + 0.9);
      _d.lerp(look, 1 - e);
      this.camera.lookAt(_d);
      return;
    }
    this.camera.lookAt(look);
    if (this.roll) this.camera.rotateZ(this.roll * (1 - this.shotW));
  }
}

const G = 13.5;
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _l = new THREE.Vector3();
