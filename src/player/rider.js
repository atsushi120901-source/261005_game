import * as THREE from 'three';
import { clamp, damp, dampAngle, wrapAngle, TAU, lerp } from '../core/utils.js';
import { EDGE_U, BUILD_U, BANK_TOP } from '../world/track.js';

const G = 13.5;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _f = {};
const _g = { gs: 0, gu: 0 };

const SPIN_POINTS = [0, 150, 400, 800, 1300, 2000, 2800, 3800, 5000, 6400];
const GRAB_NAMES = { indy: 'Indy', method: 'Method', nose: 'Nose Grab', tail: 'Tail Grab' };

export function trickName(t) {
  const half = Math.round(Math.abs(t.spin) / Math.PI);
  const deg = half * 180;
  const flips = Math.round(Math.abs(t.flip) / TAU);
  const back = t.flip > 0;
  // regular rider faces the toe side: turning the chest downhill first (ccw) is frontside
  const fs = (t.spin < 0) !== !!t.switch;
  const parts = [];
  if (t.switch && (deg > 0 || flips > 0)) parts.push(fs && deg > 0 ? 'Cab' : 'Switch');
  if (flips > 0) {
    const mult = flips === 1 ? '' : flips === 2 ? 'Double ' : flips === 3 ? 'Triple ' : `${flips}x `;
    if (deg >= 360) {
      if (!(t.switch && fs)) parts.push(fs ? 'Frontside' : 'Backside');
      parts.push(`${mult}${back ? (fs ? 'Cork' : 'Rodeo') : 'Misty'} ${deg}`);
    } else {
      parts.push(`${mult}${back ? 'Backflip' : 'Frontflip'}`);
    }
  } else if (deg > 0) {
    if (!(t.switch && fs)) parts.push(fs ? 'Frontside' : 'Backside');
    parts.push(String(deg));
  }
  const grabs = Object.entries(t.grabs).filter(([, v]) => v > 0.12).sort((a, b) => b[1] - a[1]);
  if (grabs.length) parts.push(grabs.slice(0, 2).map(([k]) => GRAB_NAMES[k]).join(' → '));
  if (!parts.length) {
    if (t.air > 1.5) parts.push('Big Air');
    else if (t.air > 0.7) parts.push(t.quarter ? 'Wall Air' : 'Ollie');
  }
  return parts.join(' ');
}

export function trickPoints(t) {
  const half = Math.min(9, Math.round(Math.abs(t.spin) / Math.PI));
  const flips = Math.round(Math.abs(t.flip) / TAU);
  let pts = SPIN_POINTS[half] + (flips ? Math.round(1100 * Math.pow(flips, 1.35)) : 0);
  for (const k in t.grabs) {
    const h = t.grabs[k];
    if (h > 0.12) pts += 220 + Math.min(h, 2.5) * 520;
  }
  if (t.air > 0.6) pts += Math.round(t.air * 140);
  if (half >= 2 && flips >= 1) pts = Math.round(pts * 1.25); // combo rotation bonus
  if (t.switch && (half > 0 || flips > 0)) pts = Math.round(pts * 1.1);
  return Math.round(pts / 10) * 10;
}

export class Rider {
  constructor(track, character, handling, fx, audio) {
    this.track = track;
    this.char = character;
    this.h = handling;
    this.fx = fx;
    this.audio = audio;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.events = [];
    this.normal = new THREE.Vector3(0, 1, 0);
    this.alignQ = new THREE.Quaternion();
    this.reset(8);
  }

  reset(s = 8, u = 0) {
    const tr = this.track;
    this.s = s;
    this.u = u;
    this.y = tr.height(s, u);
    this.vs = 6;
    this.vu = 0;
    this.vy = 0;
    this.phi = 0; // board nose angle in track plane (0 = downhill)
    this.state = 'ground';
    this.switch = false;
    this.spin = 0;
    this.spinVel = 0;
    this.flip = 0;
    this.flipVel = 0;
    this.edge = 0;
    this.skid = 0;
    this.charge = 0;
    this.airTime = 0;
    this.trick = null;
    this.grab = null;
    this.rail = null;
    this.crashT = 0;
    this.invuln = 1.0;
    this.groundTimer = 0;
    this.lastSafe = { s, u: 0 };
    this.finished = false;
    this.surfaceVy = 0;
    this.tumble = new THREE.Quaternion();
    this.tumbleAxis = new THREE.Vector3(1, 0, 0);
    this.char.setPose('ride');
    this.char.snap();
    this.char.resetStrands();
    this._updateTransform(0);
  }

  get speed() {
    return Math.hypot(this.vs, this.vu, this.vy);
  }
  get groundSpeed() {
    return Math.hypot(this.vs, this.vu);
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
  }

  // -------------------------------------------------------------- main update
  update(dt, input) {
    this.events.length = 0;
    this.invuln = Math.max(0, this.invuln - dt);
    switch (this.state) {
      case 'ground': this._ground(dt, input); break;
      case 'air': this._air(dt, input); break;
      case 'grind': this._grind(dt, input); break;
      case 'crash': this._crash(dt); break;
      default: break;
    }
    // course limits
    const umax = BUILD_U - 0.7;
    if (Math.abs(this.u) > umax) {
      this.u = Math.sign(this.u) * umax;
      if (this.vu * this.u > 0) this.vu = -this.vu * 0.3;
    }
    if (this.s >= this.track.finishS && !this.finished) {
      this.finished = true;
      this.emit('finish');
    }
    this._updateTransform(dt);
    this._updatePose(dt, input);
    return this.events;
  }

  // -------------------------------------------------------------- ground
  _ground(dt, input) {
    const tr = this.track;
    const h = this.h;
    const g = tr.gradient(this.s, this.u, _g);
    const g2 = 1 + g.gs * g.gs + g.gu * g.gu;
    let vs = this.vs, vu = this.vu;
    // gravity along the surface
    vs += (-G * g.gs / g2) * dt;
    vu += (-G * g.gu / g2) * dt;
    let sp = Math.hypot(vs, vu);
    // drag + friction
    const tuck = input.up && !input.jump ? 1 : 0;
    const brake = input.down ? 1 : 0;
    const k = (tuck ? 0.0012 : 0.0021) / h.speed;
    let dec = k * sp * sp + 0.28 + brake * 9.5;
    if (Math.abs(this.u) > EDGE_U + 0.05) dec += 1.2; // sidewalk is slower
    const nsp = Math.max(0, sp - dec * dt);
    if (sp > 1e-4) { vs *= nsp / sp; vu *= nsp / sp; }
    sp = nsp;

    // steering (carving rotates velocity)
    const steer = input.steer;
    const turnRate = lerp(2.0, 1.15, clamp(sp / 30, 0, 1)) * (brake ? 0.6 : 1);
    const dTheta = steer * turnRate * dt;
    if (sp > 0.3) {
      const c = Math.cos(dTheta), s = Math.sin(dTheta);
      const nvs = vs * c - vu * s, nvu = vs * s + vu * c;
      vs = nvs; vu = nvu;
      this.phi += dTheta;
      if (Math.abs(steer) > 0.2) { vs *= 1 - Math.abs(steer) * 0.035 * dt; vu *= 1 - Math.abs(steer) * 0.035 * dt; }
    } else {
      this.phi += steer * 1.5 * dt;
      // push off when nearly stopped on flat ground
      if (Math.abs(g.gs) < 0.03) vs += 2.5 * dt;
    }
    // edge grip: kill sideways motion relative to the board axis
    const bx = Math.cos(this.phi), by = Math.sin(this.phi);
    const along = vs * bx + vu * by;
    let latS = vs - along * bx, latU = vu - along * by;
    const lat = Math.hypot(latS, latU);
    const grip = Math.exp(-(brake ? 3 : 9) * dt);
    latS *= grip; latU *= grip;
    vs = along * bx + latS;
    vu = along * by + latU;

    // align board with travel direction (or switch)
    const theta = Math.atan2(vu, vs);
    sp = Math.hypot(vs, vu);
    if (sp > 0.8) {
      const dReg = wrapAngle(theta - this.phi);
      const dSw = wrapAngle(theta + Math.PI - this.phi);
      if (Math.abs(dReg) <= Math.abs(dSw)) { this.phi += dReg * Math.min(1, dt * 10); this.switch = false; }
      else { this.phi += dSw * Math.min(1, dt * 10); this.switch = true; }
    }
    this.phi = wrapAngle(this.phi);
    this.vs = vs;
    this.vu = vu;
    this.edge = damp(this.edge, steer * clamp(sp / 18, 0.25, 1) * 0.55, 8, dt);
    this.skid = damp(this.skid, brake ? 1 : 0, 8, dt);

    // integrate
    const prevY = this.y;
    this.s += vs * dt;
    this.u += vu * dt;
    const ng = tr.height(this.s, this.u);

    // obstacles (car sides) -> crash; ordinary steep snow never trips you
    if (ng - prevY > 0.5 && this.invuln <= 0 && ng - tr.height(this.s, this.u, false) > 0.3) {
      this.y = prevY;
      this._startCrash('obstacle');
      return;
    }

    // quarter-pipe coping launch
    const au = Math.abs(this.u);
    if (au > EDGE_U - 0.3 && au < EDGE_U + 0.2 && this.u * vu > 0 && prevY < tr.baseY(this.s) + BANK_TOP + 0.1) {
      const gu = tr.lateralSlope(Math.sign(this.u) * (EDGE_U - 0.35));
      const up = Math.abs(vu) * Math.sqrt(1 + gu * gu) * 0.92;
      this.u = Math.sign(this.u) * (EDGE_U - 0.3);
      this.vu = -Math.sign(this.u) * 0.7;
      this.vy = up;
      this.y = prevY;
      this._takeoff(true);
      return;
    }

    // natural launch off lips and crests
    const yBall = prevY + this.surfaceVy * dt - 0.5 * G * dt * dt;
    if (yBall > ng + 0.06 && this.surfaceVy > 0.6) {
      this.y = yBall;
      this.vy = this.surfaceVy - G * dt;
      this._takeoff(false);
      return;
    }
    this.surfaceVy = (ng - prevY) / Math.max(dt, 1e-4);
    this.y = ng;
    this.vy = this.surfaceVy;

    // ollie
    if (input.jump) {
      this.charge = Math.min(1, this.charge + dt * 2.2);
    } else if (this.charge > 0) {
      const pop = (4.6 + 2.8 * this.charge) * this.h.pop;
      this.vy = Math.max(this.surfaceVy, 0) + pop;
      this.y += 0.02;
      this.charge = 0;
      this.audio?.play('pop');
      this._takeoff(false, true);
      return;
    }

    // ground combo timer
    this.groundTimer += dt;
    if (this.groundTimer > 0.6 && au < EDGE_U - 1) this.lastSafe = { s: this.s, u: this.u };

    // fx: spray when carving hard / braking
    const carveAmt = Math.abs(steer) * clamp(sp / 20, 0, 1) + brake * clamp(sp / 8, 0, 1.2) + lat * 0.15;
    this.sprayAmt = carveAmt;
    this.contact = true;
    if (this.fx) {
      if (carveAmt > 0.15) this.fx.spray(this._tailPoint(), this.velocity, carveAmt, this.normal);
      this.fx.trail(this.position, this.forward, this.normal, true);
    }
  }

  _tailPoint() {
    // trailing edge of the board (relative to travel direction)
    const th = Math.atan2(this.vu, this.vs);
    return this.track.toWorld(this.s - Math.cos(th) * 0.6, this.u - Math.sin(th) * 0.6, this.y + 0.05);
  }

  _takeoff(quarter, ollie = false) {
    this.state = 'air';
    this.airTime = 0;
    this.spin = 0;
    this.flip = 0;
    this.spinVel = 0;
    this.flipVel = 0;
    this.grab = null;
    this.charge = 0;
    this.takeoffPhi = this.phi;
    this.contact = false;
    // keys already held when leaving the ground (carving / speed tuck) must be
    // released and pressed again before they rotate the rider
    this.spinLock = true;
    this.flipLock = true;
    this.trick = { spin: 0, flip: 0, grabs: {}, air: 0, switch: this.switch, quarter };
    this.emit('takeoff', { quarter, ollie });
    if (!ollie) this.audio?.play('whoosh');
    this.fx?.trail(this.position, this.forward, this.normal, false);
  }

  // -------------------------------------------------------------- air
  _air(dt, input) {
    const tr = this.track;
    this.airTime += dt;
    this.vy -= G * dt;
    // tiny air drag
    const sp = Math.hypot(this.vs, this.vu);
    const d = Math.max(0, 1 - 0.0008 * sp * dt);
    this.vs *= d;
    this.vu *= d;

    // rotation control
    const maxSpin = 2 * Math.PI * 1.05 * this.h.spin;
    const maxFlip = 2 * Math.PI * 0.9 * this.h.spin;
    const rawSteer = input.rawSteer ?? input.steer;
    const flipRaw = input.down ? 1 : input.up ? -1 : 0;
    if (this.spinLock && Math.abs(rawSteer) < 0.1) this.spinLock = false;
    if (this.flipLock && !flipRaw) this.flipLock = false;
    const spinIn = this.spinLock ? 0 : rawSteer;
    const flipIn = this.flipLock ? 0 : flipRaw;
    // landing assist: when touchdown is close, line the board up hard
    const hAbove = Math.max(0, this.y - tr.height(this.s, this.u));
    const tImpact = (this.vy + Math.sqrt(Math.max(0, this.vy * this.vy + 2 * G * hAbove))) / G;
    const assist = tImpact < 0.45 ? 2.6 : 1;
    this.landAssist = assist > 1;
    if (Math.abs(spinIn) > 0.1) {
      this.spinVel = damp(this.spinVel, spinIn * maxSpin, 9, dt);
    } else {
      // settle so the board lines up with the travel direction (regular or switch)
      let off = wrapAngle(Math.atan2(this.vu, this.vs) - this.phi);
      if (Math.abs(off) > Math.PI / 2) off -= Math.sign(off) * Math.PI;
      this.spinVel = damp(this.spinVel, clamp(off * 6 * assist, -maxSpin * 1.5, maxSpin * 1.5), 14, dt);
    }
    if (flipIn) {
      this.flipVel = damp(this.flipVel, flipIn * maxFlip, 7, dt);
    } else {
      const target = Math.round(this.flip / TAU) * TAU;
      this.flipVel = damp(this.flipVel, clamp((target - this.flip) * 5.5 * assist, -maxFlip * 1.5, maxFlip * 1.5), 12, dt);
    }
    this.spin += this.spinVel * dt;
    this.flip += this.flipVel * dt;
    this.phi = this.takeoffPhi + this.spin;
    this.trick.spin = this.spin;
    this.trick.flip = this.flip;
    this.trick.air = this.airTime;

    // grabs
    this.grab = input.grab || null;
    if (this.grab) this.trick.grabs[this.grab] = (this.trick.grabs[this.grab] || 0) + dt;

    this.edge = damp(this.edge, 0, 5, dt);
    this.skid = damp(this.skid, 0, 8, dt);

    const prevY = this.y;
    this.s += this.vs * dt;
    this.u += this.vu * dt;
    this.y += this.vy * dt;
    // bounce off building walls
    if (Math.abs(this.u) > BUILD_U - 0.7 && this.u * this.vu > 0) this.vu = -this.vu * 0.4;

    // rails
    if (this.vy < 3) {
      const r = tr.findRail(this.s, this.u, this.y, this.vy);
      if (r && this.airTime > 0.08) {
        this._startGrind(r);
        return;
      }
    }

    const ground = tr.height(this.s, this.u);
    if (this.y <= ground) {
      // side impact into an obstacle?
      if (ground - this.y > 0.65 && ground - prevY > 0.4 && this.invuln <= 0 && ground - tr.height(this.s, this.u, false) > 0.3) {
        this.y = prevY;
        this._startCrash('obstacle');
        return;
      }
      this._land(ground);
    }
    this.contact = false;
  }

  _land(ground) {
    const tr = this.track;
    const theta = Math.atan2(this.vu, this.vs);
    const dYaw = wrapAngle(this.phi - theta);
    const alignErr = Math.min(Math.abs(dYaw), Math.PI - Math.abs(dYaw));
    const flipErr = Math.abs(wrapAngle(this.flip));
    const sp = Math.hypot(this.vs, this.vu);
    const ok = (alignErr < 1.15 || sp < 3) && flipErr < 1.25;
    const sketchy = alignErr > 0.6 || flipErr > 0.7;
    this.y = ground;
    if (!ok && this.invuln <= 0) {
      this._startCrash('landing');
      return;
    }
    // project velocity onto the surface
    const g = tr.gradient(this.s, this.u, _g);
    const nx = -g.gs, ny = -g.gu, nz = 1;
    const nl = Math.hypot(nx, ny, nz);
    const vn = (this.vs * nx + this.vu * ny + this.vy * nz) / nl;
    const impact = Math.max(0, -vn);
    this.vs -= (vn / nl) * nx;
    this.vu -= (vn / nl) * ny;
    // landing on a downslope converts some of the drop into speed
    const keep = (impact > 16 ? 0.85 : 0.97) * (sketchy ? 0.75 : 1);
    this.vs *= keep;
    this.vu *= keep;
    this.vy = 0;
    this.surfaceVy = 0;
    this.flip = 0;
    this.spin = 0;
    this.spinVel = 0;
    this.flipVel = 0;
    const dReg = Math.abs(wrapAngle(theta - this.phi));
    this.switch = dReg > Math.PI / 2;
    this.phi = this.switch ? wrapAngle(theta + Math.PI) : theta;
    this.state = 'ground';
    this.groundTimer = 0;
    this.grab = null;
    const t = this.trick;
    const perfect = alignErr < 0.18 && flipErr < 0.25;
    this.emit('land', { impact, perfect, sketchy, trick: t, alignErr });
    this.fx?.burst(this.position, Math.min(1.5, impact / 10 + 0.3));
    this.audio?.play('land', Math.min(1, impact / 14 + 0.25));
    this.trick = null;
  }

  // -------------------------------------------------------------- grind
  _startGrind(r) {
    const tr = this.track;
    this.state = 'grind';
    this.rail = r;
    this.u = r.u;
    this.y = tr.railY(r, this.s);
    const sp = Math.hypot(this.vs, this.vu);
    this.vs = Math.max(4, Math.abs(this.vs) * 0.98 + Math.abs(this.vu) * 0.3) * Math.sign(this.vs || 1);
    this.vu = 0;
    this.vy = 0;
    // settle flip; keep board yaw relative to rail
    this.flip = 0;
    this.flipVel = 0;
    this.spinVel = 0;
    const rel = Math.abs(wrapAngle(this.phi));
    const a = Math.min(rel, Math.PI - rel);
    this.grindName = a < 0.55 ? '50-50' : a > 1.0 ? 'Boardslide' : 'Crooked Grind';
    if (r.type === 'ledge') this.grindName = a > 1.0 ? 'Lipslide' : '5-0 Grind';
    // snap board angle to clean grind orientation
    const base = rel < Math.PI / 2 ? 0 : Math.PI;
    this.grindPhi = a > 1.0 ? (wrapAngle(this.phi) > 0 ? Math.PI / 2 : -Math.PI / 2) : base;
    this.grindTime = 0;
    this.grindAir = this.trick;
    this.trick = null;
    this.emit('grindStart', { name: this.grindName, air: this.grindAir, speed: sp });
    this.audio?.startGrind();
  }

  _grind(dt, input) {
    const tr = this.track;
    const r = this.rail;
    this.grindTime += dt;
    const slope = (r.y1 - r.y0) / (r.s1 - r.s0);
    this.vs += (-G * slope / (1 + slope * slope)) * dt;
    this.vs -= Math.sign(this.vs) * 0.5 * dt / this.h.grind;
    this.s += this.vs * dt;
    this.y = tr.railY(r, this.s);
    this.vy = slope * this.vs;
    this.phi = dampAngle(this.phi, this.grindPhi, 12, dt);
    this.edge = Math.sin(this.time = (this.time || 0) + dt * 9) * 0.04;
    this.fx?.sparks(this.position, this.velocity);
    this.fx?.trail(this.position, this.forward, this.normal, false);
    const end = this.s > r.s1 || this.s < r.s0 || Math.abs(this.vs) < 0.5;
    if (input.jump && !this._grindJumpLock) {
      this._grindJumpLock = true;
    }
    if ((!input.jump && this._grindJumpLock) || end) {
      const jumped = !input.jump && this._grindJumpLock;
      this._grindJumpLock = false;
      this.emit('grindEnd', { name: this.grindName, time: this.grindTime });
      this.audio?.stopGrind();
      this.state = 'air';
      this.rail = null;
      if (jumped) {
        this.vy = Math.max(this.vy, 0) + 5.5 * this.h.pop;
        this.audio?.play('pop');
      }
      this.y += 0.05;
      this.u += 0;
      this._takeoffKeepYaw();
    }
  }

  _takeoffKeepYaw() {
    const phi = this.phi;
    this._takeoff(false, true);
    this.takeoffPhi = phi; // spin out of a boardslide from its current angle
  }

  // -------------------------------------------------------------- crash
  _startCrash(reason) {
    this.state = 'crash';
    this.crashT = 0;
    this.trick = null;
    this.grab = null;
    this.rail = null;
    this.audio?.stopGrind();
    this.audio?.play('crash');
    this.tumbleAxis.set(Math.random() - 0.5, 0.3, Math.random() - 0.5).normalize();
    this.tumbleSpeed = 7 + Math.random() * 4;
    this.tumble.identity();
    this.emit('crash', { reason });
    this.fx?.burst(this.position, 1.6);
    this.vs *= 0.55;
    this.vu *= 0.4;
    this.vy = Math.max(this.vy, 2.5);
  }

  _crash(dt) {
    const tr = this.track;
    this.crashT += dt;
    this.vy -= G * dt;
    this.s += this.vs * dt;
    this.u += this.vu * dt;
    this.y += this.vy * dt;
    const gnd = tr.height(this.s, this.u);
    if (this.y < gnd) {
      this.y = gnd;
      this.vy = Math.abs(this.vy) > 3 ? -this.vy * 0.25 : 0;
      this.vs *= Math.exp(-2.4 * dt);
      this.vu *= Math.exp(-2.4 * dt);
      if (Math.random() < 0.4) this.fx?.spray(this.position, this.velocity, 0.6, this.normal);
    }
    this.tumbleSpeed *= Math.exp(-1.5 * dt);
    _q.setFromAxisAngle(this.tumbleAxis, this.tumbleSpeed * dt);
    this.tumble.premultiply(_q);
    if (this.crashT > 2.0) {
      // respawn at the last safe spot near where we fell
      const s = Math.max(this.lastSafe.s, this.s - 4);
      let u = this.u;
      if (Math.abs(u) > 7) u = Math.sign(u) * 5;
      // nudge clear of obstacles
      let ss = s;
      for (let i = 0; i < 40; i++) {
        const bump = tr.height(ss, u) - tr.height(ss, u, false);
        if (bump < 0.05) break;
        ss += 1;
      }
      const keepFinished = this.finished;
      this.reset(ss, u);
      this.finished = keepFinished;
      this.vs = 7;
      this.invuln = 1.5;
      this.emit('respawn');
    }
  }

  // -------------------------------------------------------------- transform & pose
  _updateTransform(dt) {
    const tr = this.track;
    const f = tr.frame(this.s, _f);
    tr.toWorld(this.s, this.u, this.y, this.position);
    // world velocity
    this.velocity.set(
      f.tx * this.vs + f.rx * this.vu,
      this.vy,
      f.tz * this.vs + f.rz * this.vu
    );
    // board nose direction in world
    const c = Math.cos(this.phi), s = Math.sin(this.phi);
    const nx = f.tx * c + f.rx * s, nz = f.tz * c + f.rz * s;
    this.forward.set(nx, 0, nz);
    const yaw = Math.atan2(-nx, -nz);

    // ground alignment
    if (this.state === 'ground' || this.state === 'crash') {
      tr.normal(this.s, this.u, this.normal);
    } else if (this.state === 'grind') {
      this.normal.set(0, 1, 0);
    } else {
      this.normal.lerp(UP, 1 - Math.exp(-3 * dt)).normalize();
    }
    _q.setFromUnitVectors(UP, this.normal);
    this.alignQ.slerp(_q, dt > 0 ? 1 - Math.exp(-14 * dt) : 1);

    const root = this.char.root;
    root.position.copy(this.position);
    _q2.setFromAxisAngle(UP, yaw);
    root.quaternion.copy(this.alignQ).multiply(_q2);
    // skid (braking turns the board across the slope, visually)
    const skidYaw = this.skid * 1.1 * (this.switch ? -1 : 1);
    if (skidYaw) root.quaternion.multiply(_q.setFromAxisAngle(UP, skidYaw));
    // edge roll + flips both rotate around the board's long axis (Z)
    const localTurn = this.edge * (this.switch ? -1 : 1);
    const roll = -localTurn + this.flip;
    root.quaternion.multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), roll));
    if (this.state === 'crash') {
      root.quaternion.premultiply(this.tumble);
      root.position.y += 0.25;
    }
  }

  _updatePose(dt, input) {
    const ch = this.char;
    const sp = this.groundSpeed;
    let fast = false;
    if (this.state === 'ground') {
      const localTurn = input.steer * (this.switch ? -1 : 1);
      if (this.charge > 0) ch.setPose('crouch');
      else ch.setPose('ride', { carve: localTurn * clamp(sp / 12, 0.3, 1), tuck: input.up ? 1 : 0, brake: input.down });
    } else if (this.state === 'air') {
      fast = true;
      if (this.grab) ch.setPose(this.grab);
      else if (Math.abs(this.flipVel) > 2) ch.setPose('flip');
      else if (Math.abs(this.spinVel) > 2) ch.setPose('spin', { dir: Math.sign(this.spinVel) });
      else if (this.airTime < 0.18) ch.setPose('pop');
      else ch.setPose('air');
    } else if (this.state === 'grind') {
      ch.setPose('grind');
    } else if (this.state === 'crash') {
      ch.setPose('crash');
    }
    const wind = _v.copy(this.velocity).multiplyScalar(-2.2);
    wind.y += 2;
    ch.update(dt, { fast, wind: wind.clone(), vibration: this.state === 'grind' ? 1 : this.state === 'ground' ? clamp(sp / 30, 0, 1) * 0.4 : 0 });
  }
}
