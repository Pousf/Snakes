'use strict';
/* Serveur de jeu « Serpents & Orbes » — WebSocket, autoritatif.
 * Le serveur simule tout le monde (core.js) ; les joueurs n'envoient que leur direction.
 *
 * Variables d'environnement (toutes facultatives) :
 *   PORT             port d'écoute (la plupart des hébergeurs le fournissent)       défaut 3000
 *   MAX_PLAYERS      joueurs simultanés maximum                                      défaut 30
 *   TARGET_POP       nombre de serpents visé ; des bots complètent les humains       défaut 10
 *   MAX_CONNECTIONS  connexions maximum (joueurs + spectateurs)                      défaut 100
 *   ALLOWED_ORIGINS  origines autorisées, séparées par des virgules, ex.
 *                    https://monsite.neocities.org  (vide = tout le monde)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { World, C, scoreOf, round1 } = require('./core.js');

const TICK_RATE = 30;
const STEP = 1 / TICK_RATE;
const r2 = v => Math.round(v * 100) / 100;

const FILES = { '/': 'index.html', '/index.html': 'index.html', '/core.js': 'core.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function cleanName(n) {
  return String(typeof n === 'string' ? n : '')
    .replace(/[\u0000-\u001f\u007f-\u009f<>&"'`]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 12) || 'Joueur';
}

function createGameServer(opts) {
  opts = opts || {};
  const MAX_PLAYERS = opts.maxPlayers || parseInt(process.env.MAX_PLAYERS, 10) || 30;
  const TARGET_POP = opts.targetPop || parseInt(process.env.TARGET_POP, 10) || 10;
  const MAX_CONNECTIONS = opts.maxConnections || parseInt(process.env.MAX_CONNECTIONS, 10) || 100;
  const MAX_PER_IP = opts.maxPerIp || 10;
  const ALLOWED_ORIGINS = (opts.allowedOrigins || process.env.ALLOWED_ORIGINS || '')
    .toString().split(',').map(s => s.trim()).filter(Boolean);
  const autoTick = opts.autoTick !== false;

  const world = new World({ targetPop: TARGET_POP, trackEvents: true });
  const conns = new Set();
  const bySnake = new Map();     // id du serpent -> connexion du joueur
  const perIp = new Map();
  let tickNo = 0, acc = 0, last = Date.now();
  const timers = [];

  /* ---------- HTTP : sert la page pour tester en local / héberger tout au même endroit ---------- */
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    const file = FILES[url];
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Introuvable'); return; }
    fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(file + ' est introuvable à côté de server.js');
        return;
      }
      let body = buf;
      if (file === 'index.html') {  // la page servie ici se connecte d'office à ce même serveur
        const host = String(req.headers.host || '').replace(/[^\w.:\-\[\]]/g, '');
        const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        body = buf.toString('utf8').replace("const DEFAULT_SERVER_URL = '';", "const DEFAULT_SERVER_URL = '" + (secure ? 'wss' : 'ws') + '://' + host + "';");
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
      res.end(body);
    });
  });

  /* ---------- WebSocket ---------- */
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });

  function clientIp(req) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xf || req.socket.remoteAddress || '?';
  }

  server.on('upgrade', (req, socket, head) => {
    const refuse = code => { socket.write('HTTP/1.1 ' + code + '\r\nConnection: close\r\n\r\n'); socket.destroy(); };
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin || '')) return refuse('403 Forbidden');
    if (conns.size >= MAX_CONNECTIONS) return refuse('503 Service Unavailable');
    const ip = clientIp(req);
    if ((perIp.get(ip) || 0) >= MAX_PER_IP) return refuse('429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, ws => { ws._ip = ip; wss.emit('connection', ws, req); });
  });

  const send = (ws, obj) => { if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  const flatSegs = s => { const a = []; for (const q of s.segs) a.push(round1(q.x), round1(q.y)); return a; };

  function helloMsg() {
    return JSON.stringify({
      t: 'hello', v: C.PROTOCOL, n: bySnake.size, max: MAX_PLAYERS,
      orbs: world.orbs.map(o => [o.id, o.x, o.y, o.v, o.hue]),
      snakes: world.snakes.map(s => ({ id: s.id, name: s.name, hue: s.hue, segs: flatSegs(s) }))
    });
  }

  wss.on('connection', ws => {
    const conn = { ws, ip: ws._ip, snakeId: 0, alive: true, msgs: 0, windowStart: Date.now() };
    conns.add(conn);
    perIp.set(conn.ip, (perIp.get(conn.ip) || 0) + 1);
    send(ws, helloMsg());

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const t = Date.now();
      if (t - conn.windowStart > 1000) { conn.windowStart = t; conn.msgs = 0; }
      if (++conn.msgs > 100) { ws.close(1008, 'trop de messages'); return; }
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;

      if (m.t === 'join') {
        if (conn.snakeId) return;
        if (bySnake.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); return; }
        const s = world.addHuman(cleanName(m.name));
        conn.snakeId = s.id;
        bySnake.set(s.id, conn);
        send(ws, { t: 'joined', id: s.id });
      } else if (m.t === 'in') {
        if (conn.snakeId) world.setInput(conn.snakeId, { m: m.m, a: m.a, d: m.d, b: m.b });
      }
    });
    ws.on('pong', () => { conn.alive = true; });
    ws.on('error', () => {});
    ws.on('close', () => {
      conns.delete(conn);
      const n = (perIp.get(conn.ip) || 1) - 1;
      if (n <= 0) perIp.delete(conn.ip); else perIp.set(conn.ip, n);
      if (conn.snakeId) {
        const s = world.byId(conn.snakeId);
        bySnake.delete(conn.snakeId);
        conn.snakeId = 0;
        if (s) world.killSnake(s, null, 'left');
      }
    });
  });

  /* ---------- Événements du monde -> messages ciblés ---------- */
  world.onKill = (victim, killer, reason) => {
    const c = bySnake.get(victim.id);
    if (c) {
      bySnake.delete(victim.id);
      c.snakeId = 0;
      if (reason === 'snake' || reason === 'border') {
        send(c.ws, { t: 'dead', why: reason, by: killer ? killer.name : null, score: scoreOf(victim.growth), kills: victim.kills });
      }
    }
    if (killer && killer.isHuman) {
      const kc = bySnake.get(killer.id);
      if (kc) send(kc.ws, { t: 'kill', victim: victim.name, n: killer.kills });
    }
  };

  /* ---------- Boucle de jeu ---------- */
  function buildSnapshot() {
    const snap = {
      t: 's', k: tickNo, n: bySnake.size,
      p: world.snakes.map(s => [s.id, round1(s.x), round1(s.y), r2(s.angle), round1(s.growth), s.boosting ? 1 : 0])
    };
    const plus = [], minus = [], oa = [], or = [];
    for (const ev of world.events) {
      if (ev.t === 'spawn') plus.push([ev.id, ev.name, ev.hue]);
      else if (ev.t === 'death') minus.push(ev.id);
      else if (ev.t === 'orb+') oa.push([ev.o.id, ev.o.x, ev.o.y, ev.o.v, ev.o.hue]);
      else if (ev.t === 'orb-') or.push(ev.id);
    }
    world.events.length = 0;
    if (plus.length) snap['+'] = plus;
    if (minus.length) snap['-'] = minus;
    if (oa.length) snap.oa = oa;
    if (or.length) snap.or = or;
    return JSON.stringify(snap);
  }

  function broadcast(msg) {
    for (const c of conns) {
      if (c.ws.readyState !== 1) continue;
      if (c.ws.bufferedAmount > (1 << 21)) { c.ws.terminate(); continue; }  // trop lent : on ne peut pas sauter de deltas
      c.ws.send(msg);
    }
  }

  function tick(steps) {
    for (let i = 0; i < steps; i++) { world.step(STEP); tickNo++; }
    broadcast(buildSnapshot());
  }

  if (autoTick) {
    timers.push(setInterval(() => {
      const t = Date.now();
      acc += Math.min(0.25, (t - last) / 1000);
      last = t;
      if (conns.size === 0) { acc = 0; world.events.length = 0; return; }   // personne : le monde est en pause
      let steps = 0;
      while (acc >= STEP && steps < 5) { acc -= STEP; steps++; }
      if (acc > STEP) acc = STEP;
      if (steps) tick(steps);
    }, 10));
  }

  timers.push(setInterval(() => {     // coupe les connexions mortes
    for (const c of conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch (e) {}
    }
  }, 20000));

  return {
    server, world, conns, bySnake, tick,
    listen(port) { return new Promise(res => server.listen(port, () => res(server.address().port))); },
    close() {
      timers.forEach(clearInterval);
      for (const c of conns) c.ws.terminate();
      wss.close();
      return new Promise(res => server.close(() => res()));
    }
  };
}

module.exports = { createGameServer };

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 3000;
  const game = createGameServer();
  game.listen(port).then(p => console.log('Serpents & Orbes : serveur prêt sur le port ' + p + ' — ouvre http://localhost:' + p));
  const stop = () => { game.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
