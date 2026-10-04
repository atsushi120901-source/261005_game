// Procedural audio: wind / carve / grind loops, SFX and a generative lo-fi soundtrack.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicOn = true;
    this.stage = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.32;
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 5200;
    this.music.connect(this.musicFilter).connect(this.master);
    // simple reverb (generated impulse)
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.6);
    this.revGain = ctx.createGain();
    this.revGain.gain.value = 0.25;
    this.reverb.connect(this.revGain).connect(this.master);

    // noise
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.wind = this._loop('bandpass', 600, 0.6);
    this.carve = this._loop('bandpass', 2600, 1.2);
    this.grind = this._loop('bandpass', 3800, 6);
    this.grindRing = ctx.createOscillator();
    this.grindRing.type = 'triangle';
    this.grindRing.frequency.value = 1320;
    this.grindRingGain = ctx.createGain();
    this.grindRingGain.gain.value = 0;
    this.grindRing.connect(this.grindRingGain).connect(this.sfx);
    this.grindRing.start();
    this._seqTimer = null;
  }

  _impulse(sec) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    return b;
  }

  _loop(type, freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.sfx);
    src.start();
    return { src, f, g };
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  // Continuous layers driven by gameplay each frame.
  setRide({ speed = 0, carve = 0, grounded = false, air = false }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, speed / 32);
    this.wind.g.gain.setTargetAtTime(0.02 + s * s * (air ? 0.4 : 0.28), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(400 + s * 1400, t, 0.1);
    const c = grounded ? Math.min(1, 0.12 + carve * 0.8) * (0.2 + s) : 0;
    this.carve.g.gain.setTargetAtTime(c * 0.22, t, 0.05);
    this.carve.f.frequency.setTargetAtTime(1500 + carve * 2500, t, 0.05);
    this.musicFilter.frequency.setTargetAtTime(air ? 1800 : 5200, t, 0.25);
  }

  startGrind() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.grind.g.gain.setTargetAtTime(0.32, t, 0.02);
    this.grindRingGain.gain.setTargetAtTime(0.03, t, 0.02);
  }
  stopGrind() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.grind.g.gain.setTargetAtTime(0, t, 0.04);
    this.grindRingGain.gain.setTargetAtTime(0, t, 0.04);
  }
  silenceLoops() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const l of [this.wind, this.carve, this.grind]) l.g.gain.setTargetAtTime(0, t, 0.1);
    this.grindRingGain.gain.setTargetAtTime(0, t, 0.05);
  }

  // ------------------------------------------------------------- one shots
  _env(node, t, a, d, peak) {
    node.gain.setValueAtTime(0.0001, t);
    node.gain.exponentialRampToValueAtTime(peak, t + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  _tone(freq, type, t, a, d, peak, dest = this.sfx, glide = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * glide), t + a + d);
    const g = this.ctx.createGain();
    this._env(g, t, a, d, peak);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + a + d + 0.05);
    return g;
  }
  _noise(t, dur, type, freq, peak, q = 1, dest = this.sfx, sweep = 0) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    this._env(g, t, 0.005, dur, peak);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random());
    s.stop(t + dur + 0.05);
  }

  play(name, v = 1) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + 0.005;
    switch (name) {
      case 'pop':
        this._tone(160, 'sine', t, 0.005, 0.12, 0.5, this.sfx, 0.4);
        this._noise(t, 0.08, 'highpass', 2500, 0.25);
        break;
      case 'whoosh':
        this._noise(t, 0.45, 'bandpass', 500, 0.3, 1.5, this.sfx, 4);
        break;
      case 'land':
        this._tone(90, 'sine', t, 0.005, 0.25, 0.8 * v, this.sfx, 0.5);
        this._noise(t, 0.25 + v * 0.2, 'lowpass', 1800, 0.5 * v);
        break;
      case 'crash':
        this._tone(70, 'sine', t, 0.005, 0.4, 0.9, this.sfx, 0.4);
        this._noise(t, 0.9, 'lowpass', 1200, 0.7, 1, this.sfx, 0.3);
        break;
      case 'token': {
        const base = 84 + Math.floor(Math.random() * 3) * 2;
        this._tone(mtof(base), 'triangle', t, 0.005, 0.18, 0.18);
        this._tone(mtof(base + 7), 'sine', t + 0.06, 0.005, 0.3, 0.14, this.reverb);
        this._tone(mtof(base + 12), 'sine', t + 0.06, 0.005, 0.25, 0.1);
        break;
      }
      case 'trick': {
        const notes = [72, 76, 79, 84];
        notes.forEach((n, i) => this._tone(mtof(n), 'triangle', t + i * 0.045, 0.005, 0.5, 0.12 * v));
        notes.forEach((n, i) => this._tone(mtof(n), 'sine', t + i * 0.045, 0.005, 0.9, 0.06 * v, this.reverb));
        break;
      }
      case 'perfect':
        this._tone(mtof(91), 'sine', t, 0.005, 0.6, 0.12, this.reverb);
        this._tone(mtof(96), 'sine', t + 0.08, 0.005, 0.8, 0.1, this.reverb);
        break;
      case 'combo':
        this._tone(mtof(79), 'square', t, 0.005, 0.12, 0.05);
        this._tone(mtof(86), 'square', t + 0.07, 0.005, 0.2, 0.05);
        break;
      case 'lost':
        this._tone(mtof(60), 'sawtooth', t, 0.005, 0.35, 0.06, this.sfx, 0.7);
        break;
      case 'ui':
        this._tone(mtof(88), 'sine', t, 0.002, 0.08, 0.12);
        break;
      case 'select':
        this._tone(mtof(76), 'triangle', t, 0.002, 0.12, 0.15);
        this._tone(mtof(83), 'triangle', t + 0.06, 0.002, 0.2, 0.15);
        break;
      case 'finish': {
        const seq = [72, 76, 79, 84, 88];
        seq.forEach((n, i) => {
          this._tone(mtof(n), 'sawtooth', t + i * 0.09, 0.01, 0.5, 0.05);
          this._tone(mtof(n), 'sine', t + i * 0.09, 0.01, 1.2, 0.08, this.reverb);
        });
        break;
      }
      case 'countdown':
        this._tone(mtof(v > 0.5 ? 84 : 72), 'sine', t, 0.005, 0.25, 0.25);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- music
  startMusic(stage) {
    if (!this.ctx) return;
    this.stopMusic();
    this.stage = stage;
    const m = stage.music;
    this.step = 0;
    this.bar = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.spb = 60 / m.bpm / 4; // seconds per 16th
    this.music.gain.cancelScheduledValues(this.ctx.currentTime);
    this.music.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.music.gain.exponentialRampToValueAtTime(0.32, this.ctx.currentTime + 2);
    this._seqTimer = setInterval(() => this._schedule(), 25);
  }
  stopMusic() {
    if (this._seqTimer) clearInterval(this._seqTimer);
    this._seqTimer = null;
  }

  _schedule() {
    const ctx = this.ctx;
    const m = this.stage.music;
    while (this.nextTime < ctx.currentTime + 0.12) {
      const st = this.step % 16;
      const t = this.nextTime + (st % 2 ? this.spb * 0.12 : 0); // swing
      const chord = m.prog[this.bar % m.prog.length].map((n) => n + m.root);
      if (this.musicOn) this._musicStep(st, t, chord, m);
      this.nextTime += this.spb;
      this.step++;
      if (this.step % 16 === 0) this.bar++;
    }
  }

  _musicStep(st, t, chord, m) {
    const dest = this.music;
    // pad at bar start
    if (st === 0) {
      for (const n of chord) {
        for (const det of [-6, 6]) {
          const o = this.ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = mtof(n + 12);
          o.detune.value = det;
          const f = this.ctx.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = 700 + m.bright * 900;
          const g = this.ctx.createGain();
          const dur = this.spb * 16;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.022, t + dur * 0.3);
          g.gain.linearRampToValueAtTime(0.0001, t + dur * 1.02);
          o.connect(f).connect(g);
          g.connect(dest);
          g.connect(this.reverb);
          o.start(t);
          o.stop(t + dur * 1.05);
        }
      }
    }
    // bass
    if (st === 0 || st === 7 || st === 10) {
      const n = chord[0] - 12 + (st === 10 ? 7 : 0);
      this._tone(mtof(n), 'triangle', t, 0.01, this.spb * 3, 0.22, dest);
    }
    // kick
    if (st === 0 || st === 8 || (st === 11 && this.bar % 2)) {
      this._tone(120, 'sine', t, 0.002, 0.22, 0.55, dest, 0.35);
    }
    // snare / clap
    if (st === 4 || st === 12) {
      this._noise(t, 0.16, 'bandpass', 1800, 0.22, 0.8, dest);
      this._noise(t, 0.3, 'bandpass', 1800, 0.06, 0.8, this.reverb);
    }
    // hats
    if (st % 2 === 0 || Math.random() < 0.3) {
      this._noise(t, st % 4 === 2 ? 0.07 : 0.03, 'highpass', 8000, st % 4 === 2 ? 0.07 : 0.04, 1, dest);
    }
    // arpeggio pluck
    if (Math.random() < 0.45 * (0.5 + m.bright * 0.5)) {
      const n = chord[Math.floor(Math.random() * chord.length)] + 24 + (Math.random() < 0.2 ? 12 : 0);
      const g = this._tone(mtof(n), 'triangle', t, 0.003, 0.22, 0.045, dest);
      g.connect(this.reverb);
    }
  }
}
