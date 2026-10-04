import { STAGES } from '../world/stages.js';
import { RIDERS } from '../player/characters.js';
import { trickName } from '../player/rider.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class UI {
  constructor(game) {
    this.game = game;
    this.row = 0;
    this.cache = {};
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this._bind();
    this._touch();
  }

  _bind() {
    const g = this.game;
    $('btn-start').onclick = () => this._titleGo();
    $('title').addEventListener('click', (e) => { if (e.target.id !== 'btn-start') this._titleGo(); });
    $('btn-back').onclick = () => { g.audio.play('ui'); g.toTitle(); };
    $('btn-go').onclick = () => this._go();
    $('pause').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      g.audio.play('ui');
      if (act === 'resume') g.resume();
      if (act === 'restart') { this.hide('pause'); g.startRun(); }
      if (act === 'select') { this.hide('pause'); g.toSelect(); }
      if (act === 'quality') {
        const order = ['high', 'medium', 'low'];
        const next = order[(order.indexOf(g.qualityKey) + 1) % order.length];
        g.setQuality(next);
      }
      if (act === 'sound') $('s-label').textContent = g.toggleSound() ? 'OFF' : 'ON';
    });
    $('results').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      g.audio.play('ui');
      if (act === 'retry') { this.hide('results'); g.startRun(); }
      if (act === 'next') g.nextStage();
      if (act === 'select') { this.hide('results'); g.toSelect(); }
    });
    $('q-label').textContent = g.quality.name;
    $('s-label').textContent = g.audio.muted ? 'OFF' : 'ON';
  }

  _titleGo() {
    const g = this.game;
    if (g.state !== 'title') return;
    g.audio.init();
    g.audio.play('select');
    g.audio.startMusic(g.stage);
    g.toSelect();
  }

  _go() {
    const g = this.game;
    if (g.state !== 'select') return;
    g.audio.play('select');
    this.fade(() => g.startRun());
  }

  fade(fn) {
    const f = $('fade');
    f.classList.add('on');
    setTimeout(() => {
      fn();
      setTimeout(() => f.classList.remove('on'), 60);
    }, 420);
  }

  // ------------------------------------------------------------------ loading
  showLoading(stage) {
    $('loading').classList.add('show');
    $('load-text').textContent = `${stage.name} — ${stage.jp}`;
    $('load-fill').style.width = '0%';
  }
  async progress(p, text) {
    $('load-fill').style.width = `${Math.round(p * 100)}%`;
    if (text) $('load-text').textContent = text;
    await frame();
  }
  hideLoading() {
    $('loading').classList.remove('show');
  }

  // ------------------------------------------------------------------ screens
  show(name, overlay = false) {
    for (const id of ['title', 'select', 'hud', 'pause', 'results']) {
      if (overlay && id === 'hud') continue;
      $(id).classList.toggle('show', id === name);
    }
    $('touch').classList.toggle('show', this.isTouch && name === 'hud');
  }
  hide(name) {
    $(name).classList.remove('show');
  }

  renderSelect() {
    const g = this.game;
    const rc = $('rider-cards');
    rc.innerHTML = '';
    for (const r of RIDERS) {
      const d = document.createElement('div');
      d.className = 'card rider-card' + (r.id === g.riderId ? ' sel' : '');
      d.innerHTML = `<div class="swatch" style="background:linear-gradient(${hex(r.look.jacket)},${hex(r.look.accent)})"></div>
        <div class="nm">${r.name}</div><div class="jp">${r.jp}</div><div class="tg">${r.tagline}</div>`;
      d.onclick = () => { this.row = 0; g.audio.play('ui'); g.changeRider(r.id); this.renderSelect(); };
      rc.appendChild(d);
    }
    const r = RIDERS.find((x) => x.id === g.riderId);
    const bar = (n) => Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
    $('rider-info').innerHTML = `<div class="bio">${r.bio}</div>
      <div class="stat"><span>SPEED</span><div class="bar">${bar(r.stats.speed)}</div></div>
      <div class="stat"><span>SPIN</span><div class="bar">${bar(r.stats.spin)}</div></div>
      <div class="stat"><span>POP</span><div class="bar">${bar(r.stats.pop)}</div></div>
      <div class="stat"><span>GRIND</span><div class="bar">${bar(r.stats.grind)}</div></div>`;
    const sc = $('stage-cards');
    sc.innerHTML = '';
    for (const s of STAGES) {
      const d = document.createElement('div');
      const best = (() => { try { return JSON.parse(localStorage.getItem('cp_best_' + s.id) || '0'); } catch { return 0; } })();
      d.className = 'card stage-card' + (s.id === g.stageId ? ' sel' : '');
      d.innerHTML = `<div class="swatch" style="background:linear-gradient(${hex(s.sky.horizon)},${hex(s.sky.glow)})"></div>
        <div class="row"><div class="nm">${s.name}</div><div class="time">${s.time}</div></div>
        <div class="jp">${s.jp}</div><div class="ds">${s.desc}</div>
        <div class="best">BEST ${best ? best.toLocaleString('en-US') : '---'} ・ ${(s.length / 1000).toFixed(1)}km</div>`;
      d.onclick = () => { this.row = 1; g.audio.play('ui'); g.changeStage(s.id).then(() => this.renderSelect()); this.renderSelect(); };
      sc.appendChild(d);
    }
    document.querySelectorAll('.sel-label').forEach((el) => el.classList.toggle('active', +el.dataset.row === this.row));
  }

  // keyboard / gamepad navigation for menus
  menuInput(inp) {
    const g = this.game;
    const any = (...c) => inp.was(...c);
    const ok = any('Enter', 'NumpadEnter', 'PadA');
    const back = any('Escape', 'PadB');
    switch (g.state) {
      case 'title':
        if (ok || any('Space', 'PadStart')) this._titleGo();
        break;
      case 'select': {
        if (any('ArrowUp', 'KeyW', 'PadUp')) { this.row = 0; g.audio.play('ui'); this.renderSelect(); }
        if (any('ArrowDown', 'KeyS', 'PadDown')) { this.row = 1; g.audio.play('ui'); this.renderSelect(); }
        const dir = any('ArrowRight', 'KeyD', 'PadRight') ? 1 : any('ArrowLeft', 'KeyA', 'PadLeft') ? -1 : 0;
        if (dir) {
          g.audio.play('ui');
          if (this.row === 0) {
            const i = RIDERS.findIndex((r) => r.id === g.riderId);
            g.changeRider(RIDERS[(i + dir + RIDERS.length) % RIDERS.length].id);
            this.renderSelect();
          } else {
            const i = STAGES.findIndex((s) => s.id === g.stageId);
            g.changeStage(STAGES[(i + dir + STAGES.length) % STAGES.length].id).then(() => this.renderSelect());
          }
        }
        if (ok || any('Space', 'PadStart')) this._go();
        if (back) { g.audio.play('ui'); g.toTitle(); }
        break;
      }
      case 'play':
      case 'countdown':
        if (any('Escape', 'KeyP', 'PadStart')) g.pause();
        break;
      case 'paused':
        if (any('Escape', 'KeyP', 'PadStart', 'PadB')) { g.resume(); break; }
        this._modalNav('pause', inp, ok);
        break;
      case 'results':
        if (back) { this.hide('results'); g.toSelect(); break; }
        this._modalNav('results', inp, ok);
        break;
      default:
        break;
    }
  }

  // Up/down (or left/right) moves focus between a modal's buttons, confirm clicks.
  _modalNav(id, inp, ok) {
    const btns = [...document.querySelectorAll(`#${id} [data-act]`)];
    if (!btns.length) return;
    if (this.modalId !== id) {
      this.modalId = id;
      this.focus = 0;
    }
    const dir = inp.was('ArrowDown', 'KeyS', 'PadDown', 'ArrowRight', 'KeyD', 'PadRight') ? 1
      : inp.was('ArrowUp', 'KeyW', 'PadUp', 'ArrowLeft', 'KeyA', 'PadLeft') ? -1 : 0;
    if (dir) {
      this.focus = (this.focus + dir + btns.length) % btns.length;
      this.game.audio.play('ui');
    }
    btns.forEach((b, i) => b.classList.toggle('focus', i === this.focus));
    if (ok) {
      this.modalId = null;
      btns[this.focus].click();
    }
  }

  // ------------------------------------------------------------------ HUD
  resetHud(stage) {
    $('trick-feed').innerHTML = '';
    $('district-name').textContent = `${stage.name}  ・  ${stage.jp}`;
    $('controls-hint').classList.remove('hide');
    this.hintTimer = 9;
    this.cache = {};
    this.grindEl = null;
  }

  set(id, v) {
    if (this.cache[id] !== v) {
      this.cache[id] = v;
      $(id).textContent = v;
    }
  }

  updateHud(g) {
    const r = g.rider;
    this.set('score', fmt(g.score));
    this.set('time', fmtTime(g.runTime));
    this.set('speed', String(g.state === 'countdown' ? 0 : Math.round(r.speed * 3.6)));
    this.set('tokens', `${g.tokens} / ${g.world.tokenPos.length}`);
    const c = g.combo;
    const on = c.count > 0;
    $('combo').classList.toggle('on', on);
    $('combo-bar').classList.toggle('on', on);
    if (on) {
      this.set('combo-mult', `x${Math.min(c.count, 10)}`);
      this.set('combo-pts', fmt(c.pts));
      $('combo-bar').firstElementChild.style.transform = `scaleX(${Math.max(0, c.timer / 3)})`;
    }
    const p = Math.min(1, Math.max(0, r.s / g.track.finishS));
    $('prog-fill').style.width = `${p * 100}%`;
    $('prog-dot').style.left = `${p * 100}%`;
    if (this.hintTimer > 0) {
      this.hintTimer -= 1 / 60;
      if (this.hintTimer <= 0) $('controls-hint').classList.add('hide');
    }
    // live readout of the trick being performed in the air
    let live = '';
    if (r.state === 'air' && r.trick && r.airTime > 0.25) {
      const t = r.trick;
      if (Math.abs(t.spin) > 2.4 || Math.abs(t.flip) > 2.4 || Object.keys(t.grabs).length) live = trickName(t);
    }
    if (live !== this.cache.live) {
      this.cache.live = live;
      const el = $('live-trick');
      if (live) el.textContent = live;
      el.classList.toggle('on', !!live);
    }
    if (this.grindEl && r.state === 'grind') {
      this.grindEl.querySelector('.tp').textContent = `+${fmt(r.grindTime * 520 * r.h.grind + 120)}`;
    }
  }

  trick(name, pts, mult = 1, cls = '') {
    const feed = $('trick-feed');
    const d = document.createElement('div');
    d.className = 'trick ' + cls;
    const multTxt = mult > 1 ? `  <span style="color:#ff4d8d">x${mult}</span>` : '';
    d.innerHTML = `<div class="tn">${name}</div>${pts ? `<div class="tp">+${fmt(pts)}${multTxt}</div>` : ''}`;
    feed.prepend(d);
    while (feed.children.length > 3) feed.lastChild.remove();
    setTimeout(() => d.remove(), 2300);
  }

  grind(name) {
    const feed = $('trick-feed');
    if (name) {
      const d = document.createElement('div');
      d.className = 'trick';
      d.style.animation = 'none';
      d.innerHTML = `<div class="tn">${name}</div><div class="tp">+0</div>`;
      feed.prepend(d);
      this.grindEl = d;
    } else if (this.grindEl) {
      this.grindEl.remove();
      this.grindEl = null;
    }
  }

  center(text, pop) {
    const el = $('center-msg');
    el.textContent = text;
    el.classList.remove('pop');
    void el.offsetWidth;
    if (pop) el.classList.add('pop');
  }

  results(d) {
    $('res-stage').textContent = d.stage.name;
    $('res-rider').textContent = `${d.rider.name} ・ ${d.stage.jp}`;
    $('res-rank').textContent = d.rank;
    $('res-trick').textContent = fmt(d.trick);
    $('res-tokens').textContent = `${d.tokens} / ${d.tokenTotal}`;
    $('res-time').textContent = fmtTime(d.time);
    $('res-bonus').textContent = fmt(d.bonus);
    $('res-best').textContent = d.best ? d.best.name : '-';
    $('res-combo').textContent = `x${d.combo}`;
    $('res-total').textContent = fmt(d.total);
    $('res-record').textContent = d.record ? 'NEW RECORD!' : '';
    this.show('results');
  }

  // ------------------------------------------------------------------ touch
  _touch() {
    const t = this.game.input.touch;
    const stick = $('stick'), knob = $('stick-knob');
    let id = null, cx = 0, cy = 0;
    const move = (e) => {
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const l = Math.min(55, Math.hypot(dx, dy));
      const a = Math.atan2(dy, dx);
      knob.style.transform = `translate(${Math.cos(a) * l}px, ${Math.sin(a) * l}px)`;
      t.steer = Math.max(-1, Math.min(1, dx / 50));
      t.up = dy < -28;
      t.down = dy > 28;
    };
    stick.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      t.active = true;
      stick.setPointerCapture(id);
      move(e);
    });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      t.steer = 0; t.up = false; t.down = false;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
    const btn = (el, on, off) => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); t.active = true; on(); el.classList.add('on'); this.game.audio.init(); });
      const up = () => { off(); el.classList.remove('on'); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
    };
    btn($('t-jump'), () => (t.jump = true), () => (t.jump = false));
    btn($('t-grab'), () => (t.grab = 'indy'), () => (t.grab = null));
    btn($('t-grab2'), () => (t.grab = 'method'), () => (t.grab = null));
    $('t-pause').addEventListener('click', () => this.game.pause());
  }
}
