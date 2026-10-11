/* core.js — logique de jeu partagée.
 * Utilisée par le navigateur (mode solo) ET par le serveur Node (mode en ligne). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnakeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const C = {
  PROTOCOL: 1,       // à incrémenter si le format des messages réseau change
  WORLD_R: 2000,     // rayon de l'arène
  ORB_TARGET: 650,   // nombre d'orbes « naturels » maintenus dans l'arène
  BASE_SPEED: 150,   // px / s
  BOOST_SPEED: 290,
  MAX_ORBS: 1800     // au-delà, l'accélération ne laisse plus d'orbes
};
const TAU = Math.PI * 2;
const BOT_NAMES = ['Vipère', 'Cobra', 'Python', 'Anaconda', 'Mamba', 'Boa', 'Crotale', 'Naja', 'Basilic', 'Couleuvre', 'Orvet', 'Aspic', 'Sifflant', 'Écaille', 'Venin', 'Ondulo'];
const BOT_HUES = [8, 30, 55, 195, 220, 255, 285, 320];

const rand = (a, b) => a + Math.random() * (b - a);
const round1 = v => Math.round(v * 10) / 10;

function wrapAngle(a) {                 // ramène un angle dans [-PI, PI]
  a %= TAU;
  if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU;
  return a;
}
const angDiff = (a, b) => wrapAngle(a - b);
const radiusOf = g => 7 + Math.min(10, Math.sqrt(g) * 0.55);
const segCount = g => 14 + Math.floor(g * 0.8);
const spacingOf = r => r * 0.8;
const orbRadius = v => Math.min(12, 4 + v * 3);
const scoreOf = g => Math.floor(g * 10);

// Le corps est une chaîne : chaque segment suit le précédent à distance fixe.
function resizeSegs(segs, n) {
  while (segs.length < n) { const l = segs[segs.length - 1]; segs.push({ x: l.x, y: l.y }); }
  if (segs.length > n) segs.length = n;
}
function followChain(segs, spacing) {
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i - 1], q = segs[i];
    const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy);
    if (d > spacing) { const k = (d - spacing) / d; q.x += dx * k; q.y += dy * k; }
  }
}

class World {
  /* opts.targetPop   : nombre de serpents visé (les humains comptent, les bots complètent)
   * opts.trackEvents : le serveur active ça pour pouvoir diffuser les changements */
  constructor(opts) {
    opts = opts || {};
    this.targetPop = opts.targetPop != null ? opts.targetPop : 9;
    this.trackEvents = !!opts.trackEvents;
    this.onKill = null;            // (victime, tueur|null, raison) — raison : snake | border | left | trim
    this.snakes = [];
    this.orbs = [];
    this.events = [];
    this.botQueue = [];
    this.time = 0;
    this.orbSeq = 0;
    this.snakeSeq = 0;
    this.hueSeq = Math.floor(rand(0, 360));
    while (this.orbs.length < C.ORB_TARGET) this.spawnAmbientOrb();
    for (let i = 0; i < this.targetPop; i++) this.spawnBot();
    this.events.length = 0;        // l'état initial est envoyé en bloc aux clients, pas en événements
  }

  emit(ev) { if (this.trackEvents) this.events.push(ev); }

  byId(id) {
    for (const s of this.snakes) if (s.id === id) return s;
    return null;
  }

  /* ----- orbes ----- */
  addOrb(x, y, v, hue, ownerId) {
    const o = {
      id: ++this.orbSeq, x: round1(x), y: round1(y), v,
      hue: hue == null ? Math.floor(rand(0, 360)) : hue,
      r: orbRadius(v), dead: false,
      owner: ownerId || 0, ownerUntil: ownerId ? this.time + 1.5 : 0
    };
    this.orbs.push(o);
    this.emit({ t: 'orb+', o });
    return o;
  }
  spawnAmbientOrb() {
    const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (C.WORLD_R - 40);
    this.addOrb(Math.cos(a) * d, Math.sin(a) * d, Math.round(rand(0.5, 1.1) * 100) / 100);
  }

  /* ----- serpents ----- */
  findSpawn() {
    for (let t = 0; t < 30; t++) {
      const a = rand(0, TAU), d = Math.sqrt(Math.random()) * C.WORLD_R * 0.8;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      let ok = true;
      for (const s of this.snakes) {
        for (let i = 0; i < s.segs.length; i += 4) {
          const q = s.segs[i], dx = q.x - x, dy = q.y - y;
          if (dx * dx + dy * dy < 300 * 300) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (ok) return { x, y };
    }
    return { x: rand(-500, 500), y: rand(-500, 500) };
  }

  makeSnake(name, hue, isHuman, growth) {
    const p = this.findSpawn();
    // cap vers l'intérieur de l'arène (± 46°) : un nouveau joueur a le temps de réagir avant de toucher le bord
    const ang = wrapAngle(Math.atan2(-p.y, -p.x) + rand(-0.8, 0.8));
    const s = {
      id: ++this.snakeSeq, name, hue, isHuman, growth, kills: 0,
      x: p.x, y: p.y, angle: ang, targetAngle: ang,
      boosting: false, boostAcc: 0, alive: true, segs: [], r: radiusOf(growth),
      think: 0, wander: rand(-1, 1), hunter: Math.random() < 0.45,
      input: { mode: 'n', a: ang, d: 0, boost: false },
      bx0: 0, by0: 0, bx1: 0, by1: 0
    };
    const n = segCount(growth), sp = spacingOf(s.r);
    for (let i = 0; i < n; i++) s.segs.push({ x: s.x - Math.cos(ang) * sp * i, y: s.y - Math.sin(ang) * sp * i });
    this.computeBB(s);
    this.snakes.push(s);
    this.emit({ t: 'spawn', id: s.id, name: s.name, hue: s.hue });
    return s;
  }

  /* Teintes des joueurs : on avance de 137,5° (angle d'or) à chaque arrivée, donc deux joueurs
     qui se suivent n'ont jamais des couleurs proches. */
  nextHue() {
    this.hueSeq = (this.hueSeq + 137.508) % 360;
    return Math.round(this.hueSeq);
  }

  addHuman(name, hue) {
    return this.makeSnake(name, hue == null ? this.nextHue() : hue, true, 0);
  }

  spawnBot() {
    const used = new Set(this.snakes.map(s => s.name));
    const free = BOT_NAMES.filter(n => !used.has(n));
    const pool = free.length ? free : BOT_NAMES;
    const name = pool[Math.floor(Math.random() * pool.length)];
    const hue = BOT_HUES[Math.floor(Math.random() * BOT_HUES.length)];
    return this.makeSnake(name, hue, false, rand(0, 25));
  }

  computeBB(s) {                    // boîte englobante, pour éliminer vite les collisions impossibles
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of s.segs) {
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
    }
    s.bx0 = x0; s.by0 = y0; s.bx1 = x1; s.by1 = y1;
  }

  /* inp : { m: 'a'|'k'|'n', a: angle, d: -1|0|1, b: 0|1 } — toujours assaini ici, jamais de confiance au réseau */
  setInput(id, inp) {
    const s = this.byId(id);
    if (!s || !s.isHuman || !inp) return;
    const i = s.input;
    if (inp.m === 'a' && Number.isFinite(inp.a)) { i.mode = 'a'; i.a = wrapAngle(inp.a); }
    else if (inp.m === 'k') { i.mode = 'k'; i.d = inp.d > 0 ? 1 : inp.d < 0 ? -1 : 0; }
    else if (inp.m === 'n') { i.mode = 'n'; }
    i.boost = !!inp.b;
  }

  steer(s, target, dt) {
    const maxTurn = (3.8 / (1 + s.growth * 0.003)) * dt;
    const d = angDiff(target, s.angle);
    s.angle += Math.max(-maxTurn, Math.min(maxTurn, d));
  }

  humanControl(s, dt) {
    const i = s.input;
    if (i.mode === 'k') s.angle += i.d * (3.6 / (1 + s.growth * 0.003)) * dt;
    else if (i.mode === 'a') this.steer(s, i.a, dt);
    s.boosting = i.boost && s.growth > 2;
  }

  /* ----- intelligence des bots ----- */
  thinkBot(s, dt) {
    s.think -= dt;
    if (s.think > 0) { this.steer(s, s.targetAngle, dt); return; }
    s.think = 0.08 + Math.random() * 0.06;

    const hx = Math.cos(s.angle), hy = Math.sin(s.angle);
    let target = s.angle;
    let danger = false;

    // 1. éviter le bord
    if (Math.hypot(s.x, s.y) > C.WORLD_R - 260) {
      target = Math.atan2(-s.y, -s.x);
      danger = true;
    }

    // 2. éviter les corps devant soi
    if (!danger) {
      const look = 70 + s.r * 3;
      let nearest = null, bd = Infinity;
      for (const o of this.snakes) {
        const start = o === s ? 10 : 0;
        const lim = look + o.r, lim2 = lim * lim;
        for (let i = start; i < o.segs.length; i += 2) {
          const q = o.segs[i], dx = q.x - s.x, dy = q.y - s.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < lim2 && dx * hx + dy * hy > -s.r && d2 < bd) { bd = d2; nearest = { dx, dy }; }
        }
      }
      if (nearest) {
        const cross = hx * nearest.dy - hy * nearest.dx;
        target = s.angle + (cross > 0 ? -1.4 : 1.4);
        danger = true;
      }
    }

    // 3. chasser un humain plus petit (certains bots) ou aller vers les orbes
    if (!danger) {
      let hunting = false;
      if (s.hunter) {
        let prey = null, pd = 600 * 600;
        for (const o of this.snakes) {
          if (!o.isHuman || o.growth < 3) continue;      // un joueur qui vient d'apparaître n'est pas pris pour cible
          const dx = o.x - s.x, dy = o.y - s.y, d2 = dx * dx + dy * dy;
          if (d2 < pd) { pd = d2; prey = o; }
        }
        if (prey && s.growth > prey.growth * 0.7) {
          const px = prey.x + Math.cos(prey.angle) * 220, py = prey.y + Math.sin(prey.angle) * 220;
          target = Math.atan2(py - s.y, px - s.x);
          hunting = true;
        }
      }
      if (!hunting) {
        let bestScore = -1, bo = null;
        for (const o of this.orbs) {
          if (o.dead) continue;
          const dx = o.x - s.x, dy = o.y - s.y, d2 = dx * dx + dy * dy;
          if (d2 > 450 * 450) continue;
          const sc = (o.v + 0.3) / (Math.sqrt(d2) + 40);
          if (sc > bestScore) { bestScore = sc; bo = o; }
        }
        if (bo) {
          target = Math.atan2(bo.y - s.y, bo.x - s.x);
        } else {
          s.wander = Math.max(-1.5, Math.min(1.5, s.wander + rand(-0.3, 0.3)));
          target = s.angle + s.wander * 0.6;
        }
      }
    }

    s.targetAngle = target;
    this.steer(s, target, dt);
  }

  /* ----- mouvement, orbes, collisions ----- */
  moveSnake(s, dt) {
    const sp = s.boosting ? C.BOOST_SPEED : C.BASE_SPEED;
    s.angle = wrapAngle(s.angle);
    s.x += Math.cos(s.angle) * sp * dt;
    s.y += Math.sin(s.angle) * sp * dt;
    s.r = radiusOf(s.growth);

    const segs = s.segs;
    segs[0].x = s.x; segs[0].y = s.y;
    resizeSegs(segs, segCount(s.growth));
    followChain(segs, spacingOf(s.r));
    this.computeBB(s);

    if (s.boosting) {               // accélérer coûte de la taille, laissée en orbes derrière soi
      s.growth = Math.max(0, s.growth - 3 * dt);
      s.boostAcc += 3 * dt;
      if (s.boostAcc >= 0.5) {
        s.boostAcc -= 0.5;
        if (this.orbs.length < C.MAX_ORBS) {
          const t = segs[segs.length - 1];
          this.addOrb(t.x, t.y, 0.5, s.hue, s.id);
        }
      }
    }
  }

  eatOrbs(s) {
    for (const o of this.orbs) {
      if (o.dead) continue;
      if (o.owner === s.id && this.time < o.ownerUntil) continue;
      const dx = s.x - o.x, dy = s.y - o.y;
      const er = s.r + 34 + o.r * 0.5;
      if (dx * dx + dy * dy < er * er) {
        o.dead = true;
        s.growth += o.v;
        this.emit({ t: 'orb-', id: o.id });
      }
    }
  }

  killSnake(s, killer, reason) {
    if (!s.alive) return;
    s.alive = false;
    const i = this.snakes.indexOf(s);
    if (i >= 0) this.snakes.splice(i, 1);
    for (let k = 0; k < s.segs.length; k += 2) {
      const q = s.segs[k];
      this.addOrb(q.x + rand(-6, 6), q.y + rand(-6, 6), 1.2, s.hue);
    }
    if (killer) killer.kills++;
    this.emit({ t: 'death', id: s.id });
    if (this.onKill) this.onKill(s, killer, reason);
  }

  checkCollisions() {
    const dead = [];
    const R = C.WORLD_R;
    for (const s of this.snakes) {
      if (Math.hypot(s.x, s.y) > R - s.r * 0.5) { dead.push([s, null, 'border']); continue; }
      let killer = null;
      outer:
      for (const o of this.snakes) {
        if (o === s) continue;
        const lim = (s.r + o.r) * 0.78;
        if (s.x < o.bx0 - lim || s.x > o.bx1 + lim || s.y < o.by0 - lim || s.y > o.by1 + lim) continue;
        const lim2 = lim * lim, segs = o.segs;
        for (let i = 1; i < segs.length; i++) {
          const q = segs[i], dx = q.x - s.x, dy = q.y - s.y;
          if (dx * dx + dy * dy < lim2) { killer = o; break outer; }
        }
      }
      if (killer) dead.push([s, killer, 'snake']);
    }
    for (const d of dead) this.killSnake(d[0], d[1], d[2]);
  }

  /* Les bots complètent la population : retirés quand des humains arrivent, remplacés quand ils meurent. */
  manageBots() {
    while (this.snakes.length > this.targetPop) {
      let worst = null;
      for (const s of this.snakes) if (!s.isHuman && (!worst || s.growth < worst.growth)) worst = s;
      if (!worst) break;
      this.killSnake(worst, null, 'trim');
    }
    const missing = this.targetPop - this.snakes.length - this.botQueue.length;
    for (let i = 0; i < missing; i++) this.botQueue.push(this.time + rand(2, 4));
    for (let i = this.botQueue.length - 1; i >= 0; i--) {
      if (this.botQueue[i] <= this.time) {
        this.botQueue.splice(i, 1);
        if (this.snakes.length < this.targetPop) this.spawnBot();
      }
    }
  }

  step(dt) {
    this.time += dt;
    for (const s of this.snakes) {
      if (s.isHuman) this.humanControl(s, dt); else this.thinkBot(s, dt);
      this.moveSnake(s, dt);
    }
    for (const s of this.snakes) this.eatOrbs(s);
    this.orbs = this.orbs.filter(o => !o.dead);
    this.checkCollisions();
    this.manageBots();
    while (this.orbs.length < C.ORB_TARGET) this.spawnAmbientOrb();
  }
}

return { C, World, TAU, wrapAngle, angDiff, radiusOf, segCount, spacingOf, orbRadius, scoreOf, resizeSegs, followChain, round1 };
});
