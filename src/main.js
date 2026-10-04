import * as THREE from 'three';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { clamp, damp } from './core/utils.js';
import { STAGES, getStage } from './world/stages.js';
import { Track } from './world/track.js';
import { World } from './world/world.js';
import { RIDERS, getRider } from './player/characters.js';
import { Character } from './player/character.js';
import { Rider, trickName, trickPoints } from './player/rider.js';
import { Effects } from './fx/effects.js';
import { PostFX } from './gfx/post.js';
import { CameraRig } from './gfx/cameraRig.js';
import { UI } from './ui/ui.js';

const dpr = Math.min(window.devicePixelRatio || 1, 2);
const QUALITY = {
  high: { name: 'HIGH', pixelRatio: Math.min(dpr, 1.6), shadows: true, shadowSize: 2048, msaa: true, bloom: true, particles: 1, trackDetail: 2, pointLights: 4 },
  medium: { name: 'MEDIUM', pixelRatio: Math.min(dpr, 1.2), shadows: true, shadowSize: 1024, msaa: false, bloom: true, particles: 0.6, trackDetail: 2, pointLights: 2 },
  low: { name: 'LOW', pixelRatio: Math.min(dpr, 1), shadows: false, shadowSize: 512, msaa: false, bloom: false, particles: 0.35, trackDetail: 1, pointLights: 0 },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('cp_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cp_' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

class Game {
  constructor() {
    this.canvas = document.getElementById('view');
    const params = new URLSearchParams(location.search);
    const isMobile = matchMedia('(pointer: coarse)').matches;
    this.qualityKey = params.get('q') || store.get('quality', isMobile ? 'medium' : 'high');
    this.quality = QUALITY[this.qualityKey] || QUALITY.high;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 4000);
    this.rig = new CameraRig(this.camera);
    this.post = new PostFX(this.renderer, this.scene, this.camera, this.quality);
    this.post.setSize(innerWidth, innerHeight);
    this.input = new Input();
    this.audio = new AudioEngine();
    this.audio.setMuted(store.get('muted', false));
    this.ui = new UI(this);

    this.stageId = params.get('stage') || store.get('stage', STAGES[0].id);
    this.riderId = params.get('rider') || store.get('rider', RIDERS[0].id);
    this.state = 'loading';
    this.time = 0;
    this.timeScale = 1;
    this.lastNow = performance.now();
    this.autoplay = params.has('autoplay');

    addEventListener('resize', () => this.resize());
    const unlock = () => {
      this.audio.init();
      if (this.state === 'play' || this.state === 'countdown') {
        if (!this.audio._seqTimer) this.audio.startMusic(this.stage);
      }
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
    this.resize();
    this.boot(params);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h);
    this.viewH = h * this.renderer.getPixelRatio();
  }

  async boot(params) {
    await this.loadStage(this.stageId);
    this.setRider(this.riderId);
    if (params.has('inspect')) {
      this.state = 'inspect';
      this.placeShowcase();
      this.rig.mode = 'inspect';
      this.ui.show('none');
    } else if (params.has('play')) {
      this.startRun();
    } else {
      this.toTitle();
    }
    this.ui.hideLoading();
    requestAnimationFrame(() => this.loop());
  }

  // ------------------------------------------------------------------ loading
  async loadStage(id) {
    const stage = getStage(id);
    this.ui.showLoading(stage);
    await this.ui.progress(0.1, '地形を生成中...');
    if (this.world) {
      this.world.dispose();
      this.fx.dispose();
    }
    this.stage = stage;
    this.stageId = stage.id;
    this.track = new Track(stage);
    await this.ui.progress(0.35, `${stage.jp} を建設中...`);
    this.world = new World(this.renderer, this.scene, stage, this.track, this.quality);
    await this.ui.progress(0.7, '雪を降らせています...');
    this.fx = new Effects(this.scene, stage, this.quality);
    this.post.applyStage(stage);
    if (this.rider) {
      this.rider.track = this.track;
      this.rider.fx = this.fx;
    }
    await this.ui.progress(0.85, 'シェーダーをコンパイル中...');
    // place camera somewhere sensible and precompile everything
    this.camera.position.copy(this.track.toWorld(10, 0, this.track.baseY(10) + 3));
    this.camera.lookAt(this.track.toWorld(30, 0, this.track.baseY(30)));
    try {
      this.renderer.compile(this.scene, this.camera);
    } catch (e) {
      console.warn(e);
    }
    await this.ui.progress(1, 'READY');
  }

  setRider(id) {
    const def = getRider(id);
    this.riderId = def.id;
    if (this.character) {
      this.scene.remove(this.character.root, this.character.extras);
      this.character.dispose();
    }
    this.character = new Character(def);
    this.scene.add(this.character.root, this.character.extras);
    const prev = this.rider;
    this.rider = new Rider(this.track, this.character, def.handling, this.fx, this.audio);
    if (prev && this.state !== 'play') this.placeShowcase();
  }

  placeShowcase() {
    this.rider.reset(this.state === 'title' ? 36 : 24, this.state === 'title' ? -3 : 0);
    this.rider.phi = this.state === 'title' ? 0.5 : 0.35;
    this.rider._updateTransform(0);
    this.character.setPose('idle');
    this.character.snap();
    this.fx.reset();
  }

  // ------------------------------------------------------------------ states
  toTitle() {
    this.state = 'title';
    this.placeShowcase();
    this.rig.mode = 'orbit';
    this.audio.silenceLoops();
    this.ui.show('title');
  }

  toSelect() {
    this.state = 'select';
    this.placeShowcase();
    this.rig.mode = 'showcase';
    this.audio.silenceLoops();
    this.ui.show('select');
    this.ui.renderSelect();
  }

  async changeStage(id) {
    if (id === this.stageId) return;
    store.set('stage', id);
    await this.loadStage(id);
    this.ui.hideLoading();
    this.placeShowcase();
    if (this.state === 'play' || this.state === 'countdown') return;
    this.audio.startMusic(this.stage);
  }

  changeRider(id) {
    if (id === this.riderId) return;
    store.set('rider', id);
    this.setRider(id);
    this.placeShowcase();
  }

  startRun() {
    if (this.audio.ctx && !this.audio._seqTimer) this.audio.startMusic(this.stage);
    this.state = 'countdown';
    this.countdown = 3.2;
    this.lastCount = 4;
    this.rider.reset(8, 0);
    this.fx.reset();
    this.world.tokenAlive.fill(1);
    this.rig.mode = 'follow';
    this.rig.snapTo(this.rider);
    this.rig.intro = 1;
    this.score = 0;
    this.tokens = 0;
    this.runTime = 0;
    this.combo = { count: 0, pts: 0, timer: 0, names: [] };
    this.bestTrick = null;
    this.maxCombo = 1;
    this.timeScale = 1;
    this.finishT = 0;
    this.ui.show('hud');
    this.ui.resetHud(this.stage);
  }

  pause() {
    if (this.state !== 'play' && this.state !== 'countdown') return;
    this.prevState = this.state;
    this.state = 'paused';
    this.audio.silenceLoops();
    this.ui.show('pause', true);
  }
  resume() {
    if (this.state !== 'paused') return;
    this.state = this.prevState;
    this.ui.hide('pause');
  }

  setQuality(key) {
    store.set('quality', key);
    const url = new URL(location.href);
    url.searchParams.delete('q');
    location.href = url.toString();
  }

  toggleSound() {
    const m = !this.audio.muted;
    this.audio.setMuted(m);
    store.set('muted', m);
    return m;
  }

  // ------------------------------------------------------------------ scoring
  addCombo(name, pts, cls = '') {
    const c = this.combo;
    c.count++;
    c.pts += pts;
    c.timer = 3.0;
    c.names.push(name);
    const mult = Math.min(c.count, 10);
    this.maxCombo = Math.max(this.maxCombo, mult);
    if (!this.bestTrick || pts > this.bestTrick.pts) this.bestTrick = { name, pts };
    this.ui.trick(name, pts, mult, cls);
    if (c.count > 1) this.audio.play('combo');
  }

  bankCombo() {
    const c = this.combo;
    if (c.count === 0) return;
    const mult = Math.min(c.count, 10);
    const total = c.pts * mult;
    this.score += total;
    if (c.count > 1) this.ui.trick(`${mult}x COMBO`, total, 1, 'small');
    c.count = 0;
    c.pts = 0;
    c.names = [];
  }

  loseCombo() {
    if (this.combo.count > 0) this.audio.play('lost');
    this.combo = { count: 0, pts: 0, timer: 0, names: [] };
  }

  handleEvents(events) {
    for (const e of events) {
      switch (e.type) {
        case 'land': {
          const t = e.trick;
          this.rig.shake(Math.min(1.2, e.impact / 12));
          if (t) {
            const name = trickName(t);
            let pts = trickPoints(t);
            if (name && pts >= 100) {
              if (e.perfect) pts = Math.round(pts * 1.25 / 10) * 10;
              if (e.sketchy) pts = Math.round(pts * 0.5 / 10) * 10;
              this.addCombo(name + (e.perfect ? ' ★' : e.sketchy ? ' (SKETCHY)' : ''), pts, e.perfect ? 'perfect' : '');
              this.audio.play(e.perfect ? 'perfect' : 'trick', Math.min(1, pts / 2000 + 0.4));
              if (pts > 1500) this.post.flash(0xffffff, 0.12);
            }
          }
          break;
        }
        case 'grindStart':
          if (e.air) {
            const name = trickName(e.air);
            const pts = trickPoints(e.air);
            if (name && pts >= 150) this.addCombo(name, pts);
          }
          this.ui.grind(e.name);
          break;
        case 'grindEnd': {
          const pts = Math.round((e.time * 520 * this.rider.h.grind + 120) / 10) * 10;
          this.ui.grind(null);
          this.addCombo(e.name, pts);
          break;
        }
        case 'crash':
          this.ui.grind(null);
          this.ui.trick('BAIL!', 0, 1, 'bad');
          this.loseCombo();
          this.rig.shake(1.5);
          this.post.flash(0xff3344, 0.18);
          break;
        case 'takeoff':
          break;
        case 'finish':
          this.onFinish();
          break;
        default:
          break;
      }
    }
  }

  checkTokens() {
    const p = this.rider.position;
    const w = this.world;
    for (let i = 0; i < w.tokenPos.length; i++) {
      if (!w.tokenAlive[i]) continue;
      const q = w.tokenPos[i];
      const dx = q.x - p.x, dy = q.y - (p.y + 0.8), dz = q.z - p.z;
      if (dx * dx + dy * dy + dz * dz < 2.4) {
        w.collectToken(i);
        this.tokens++;
        this.score += 50;
        this.fx.collect(q);
        this.audio.play('token');
      }
    }
  }

  onFinish() {
    this.bankCombo();
    this.finishT = 0.001;
    this.audio.play('finish');
    this.post.flash(0xffffff, 0.3);
    this.ui.center('FINISH!', true);
  }

  showResults() {
    this.state = 'results';
    this.audio.silenceLoops();
    const par = this.track.length / 17;
    const bonus = Math.max(0, Math.round((par - this.runTime) * 120 / 10) * 10);
    const total = this.score + bonus;
    const perKm = total / (this.track.length / 1000);
    const rank = perKm > 50000 ? 'S' : perKm > 30000 ? 'A' : perKm > 16000 ? 'B' : perKm > 7000 ? 'C' : 'D';
    const key = 'best_' + this.stageId;
    const best = store.get(key, 0);
    const record = total > best;
    if (record) store.set(key, total);
    this.ui.results({
      stage: this.stage,
      rider: getRider(this.riderId),
      trick: this.score - this.tokens * 50,
      tokens: this.tokens,
      tokenTotal: this.world.tokenPos.length,
      time: this.runTime,
      bonus,
      best: this.bestTrick,
      combo: this.maxCombo,
      total,
      rank,
      record,
    });
    this.rig.mode = 'orbit';
  }

  nextStage() {
    const i = STAGES.findIndex((s) => s.id === this.stageId);
    const next = STAGES[(i + 1) % STAGES.length];
    this.ui.hide('results');
    this.changeStage(next.id).then(() => this.startRun());
  }

  // ------------------------------------------------------------------ loop
  loop() {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const dt = Math.min((now - this.lastNow) / 1000, 1 / 20);
    this.lastNow = now;
    this.tick(dt, true);
    this.adaptResolution(dt);
  }

  // Dynamic resolution: trade pixels for frame rate when the GPU struggles.
  adaptResolution(dt) {
    if (this.state !== 'play') return;
    const a = (this._perf ||= { t: 0, frames: 0, scale: 1 });
    a.t += dt;
    a.frames++;
    if (a.t < 2) return;
    const fps = a.frames / a.t;
    a.t = 0;
    a.frames = 0;
    let next = a.scale;
    if (fps < 45) next = Math.max(0.6, a.scale - 0.12);
    else if (fps > 58 && a.scale < 1) next = Math.min(1, a.scale + 0.06);
    if (next !== a.scale) {
      a.scale = next;
      this.renderer.setPixelRatio(this.quality.pixelRatio * next);
      this.resize();
    }
  }

  // Advance the simulation without waiting for frames (used by tests / debugging).
  debugStep(seconds, dt = 1 / 60) {
    for (let t = 0; t < seconds; t += dt) this.tick(dt, false);
    return { s: this.rider.s, u: this.rider.u, state: this.rider.state, speed: this.rider.speed, score: this.score, gameState: this.state };
  }

  tick(dt, render) {
    this.time += dt;
    const inp = this.input;
    const inputState = inp.update(dt);
    this.ui.menuInput(inp);

    const r = this.rider;
    if (this.state === 'play' || this.state === 'countdown') {
      // slow motion for huge airs
      let wantScale = 1;
      if (r.state === 'air') {
        const above = r.y - this.track.height(r.s, r.u);
        if (above > 6.5 && r.vy < 4) wantScale = 0.55;
      }
      if (this.finishT > 0) wantScale = 0.6;
      this.timeScale = damp(this.timeScale, wantScale, 5, dt);
      const sdt = dt * this.timeScale;

      if (this.state === 'countdown') {
        this.countdown -= dt;
        const c = Math.ceil(this.countdown - 0.2);
        if (c !== this.lastCount && c >= 0) {
          this.lastCount = c;
          this.ui.center(c > 0 ? String(c) : 'GO!', true);
          this.audio.play('countdown', c > 0 ? 0 : 1);
        }
        this.character.setPose(this.countdown > 1.2 ? 'idle' : 'crouch');
        this.character.update(dt, {});
        r._updateTransform(dt);
        this.rig.intro = clamp((this.countdown - 0.5) / 2.7, 0, 1);
        if (this.countdown <= 0.2) {
          this.state = 'play';
          this.rig.intro = 0;
        }
      } else {
        let ctl = inputState;
        if (this.autoplay) ctl = this.autoInput(dt);
        if (this.finishT > 0) ctl = { steer: 0, up: false, down: this.finishT > 1.2, jump: false, grab: null };
        const events = r.update(sdt, ctl);
        this.handleEvents(events);
        this.checkTokens();
        if (this.finishT <= 0) this.runTime += dt;
        // combo timer runs only while riding on the ground
        if (this.combo.count > 0 && r.state === 'ground') {
          this.combo.timer -= dt;
          if (this.combo.timer <= 0) this.bankCombo();
        }
        if (this.finishT > 0) {
          this.finishT += dt;
          if (r.state === 'ground') this.character.setPose('celebrate');
          if (this.finishT > 3.2) this.showResults();
        }
        this.audio.setRide({ speed: r.speed, carve: r.sprayAmt || 0, grounded: r.state === 'ground', air: r.state === 'air' });
      }
      this.rig.update(sdt, r);
      this.ui.updateHud(this);
      this.fx.update(sdt, this.time, this.camera, this.viewH);
      this.world.update(sdt, this.time, r.position, this.camera, this.viewH);
      if (render) this.post.render(dt, this.time, clamp((r.speed - 8) / 26, 0, 1) * (this.timeScale < 0.9 ? 0.4 : 1));
    } else {
      // menus / paused / results: keep the city alive
      if (this.state !== 'paused') {
        if (this.state === 'results') {
          if (r.state !== 'crash') r.update(dt, { steer: 0, up: false, down: true, jump: false, grab: null });
          this.character.setPose(r.groundSpeed < 2 ? 'celebrate' : 'ride', { brake: true });
        } else {
          this.character.setPose(this.debugPose || 'idle');
          this.character.update(dt, { wind: new THREE.Vector3(1, 1, 0.5) });
        }
        this.rig.update(dt, r);
      }
      this.fx.update(this.state === 'paused' ? 0 : dt, this.time, this.camera, this.viewH);
      this.world.update(dt, this.time, r.position, this.camera, this.viewH);
      if (render) this.post.render(dt, this.time, 0);
    }
    inp.endFrame();
  }

  // Simple bot used for automated testing / attract mode.
  autoInput(dt) {
    const r = this.rider;
    this._bot = this._bot || { t: 0 };
    const b = this._bot;
    b.t += dt;
    const target = Math.sin(r.s * 0.03) * 4;
    const steer = clamp((target - r.u) * 0.3 - r.vu * 0.15, -1, 1);
    let jump = false, grab = null, spin = 0, up = false;
    if (r.state === 'ground') {
      jump = (b.t % 3) < 0.4;
    } else if (r.state === 'air') {
      spin = r.airTime < 0.9 ? 1 : 0;
      grab = r.airTime > 0.3 && r.airTime < 1.0 ? 'indy' : null;
    }
    return { steer: r.state === 'air' ? spin : steer, up, down: false, jump, grab };
  }
}

window.game = new Game();
