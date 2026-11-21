// Mini2K relay server. No dependencies: plain Node (18 or newer).
//
// What it does:
//   GET  /            the online game page (public/index.html), so friends can just open the address
//   GET  /health      "ok" (also used by the game to wake the server up on free hosting)
//   WS   /ws?room=X   a room: every message one screen sends is passed to the other screens in the room.
//                     The game uses one room for finding each other (room code) and, when school wifi
//                     blocks a direct connection, a second room to carry the game itself.
//   POST /presence    "who's online": a page checks in about once a minute with its name and how long
//                     its player has been idle; the answer is everyone online. Kept in memory only.
//                     Someone idle for 15 minutes, or whose page stopped checking in, drops off.
//                     Everyone with the game open is listed; no name typed = "Player 1", "Player 2"...
//                     Each entry also shows a rough location ("Greenville, NC") looked up once from
//                     the IP address the page connects from (ipwho.is, then ip-api.com; cached a day).
//                     Nothing is asked of the player. GEO=off turns the lookup off.
// The server never looks inside the messages. It sends its own {"t":"_n","n":count} to everyone in a
// room whenever someone joins or leaves, so each side knows when the other one is there.
//
// Run locally:   node server.js            (PORT=8080 by default)

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8080;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(DIR, 'public', 'index.html');
const MAX_IN_ROOM = 10;           // 3v3: six players, people watching, and a stale tab or a rejoin
const MAX_MSG = 2 * 1024 * 1024;  // one message (a full game snapshot is well under this)
const MAX_RATE = 3000;            // messages per 10 s per connection (the game sends about 130 a second)
const MAX_CONN = 400;             // whole server

const rooms = new Map();          // room -> Set<Client>
let conns = 0;
const IDLE_DROP = 15 * 60 * 1000;  // presence: idle this long and you are off the list
const GONE_DROP = 150 * 1000;       // presence: page stopped checking in (closed, asleep)
const ACTIVE = 2 * 60 * 1000;       // presence: green dot if they did something in the last 2 minutes
const MAX_PEOPLE = 500;
const people = new Map();           // id -> { name, num, loc, since, lastActive, lastSeen, doing }
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ http

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (url.pathname === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
    res.end(`ok ${rooms.size} rooms, ${conns} connections, ${people.size} online`);
    return;
  }
  if (url.pathname === '/presence' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', async () => {
      let m = {};
      try { m = JSON.parse(body); } catch { /* bad body: just answer with the list */ }
      const answer = await presence(m, clientIp(req));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(PAGE, (err, buf) => {
      if (err) { res.writeHead(404, cors); res.end('No game page here (public/index.html is missing). The relay still works.'); return; }
      res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, cors); res.end('not found');
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const room = url.searchParams.get('room') ?? '';
  const key = req.headers['sec-websocket-key'];
  const bad = (code, text) => { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); };
  if (url.pathname !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return bad(400, 'Bad Request');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(room)) return bad(400, 'Bad Room');
  if (conns >= MAX_CONN) return bad(503, 'Busy');
  const set = rooms.get(room) ?? new Set();
  if (set.size >= MAX_IN_ROOM) return bad(409, 'Room Full');
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  rooms.set(room, set);
  const c = new Client(socket, room);
  set.add(c); conns++;
  count(room);
});

function count(room) {
  const set = rooms.get(room);
  if (!set) return;
  const msg = JSON.stringify({ t: '_n', n: set.size });
  for (const c of set) c.sendText(msg);
}

// ------------------------------------------------------------------ who's online

async function presence(m, ip) {
  const now = Date.now();
  for (const [id, p] of people) if (now - p.lastActive > IDLE_DROP || now - p.lastSeen > GONE_DROP) people.delete(id);
  const id = typeof m.id === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(m.id) ? m.id : null;
  const name = String(m.name ?? '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 16);
  if (id && m.bye) people.delete(id);
  else if (id) {
    const idle = Math.max(0, Math.min(IDLE_DROP, Number(m.idle) * 1000 || 0));
    if (idle < IDLE_DROP) {
      let p = people.get(id);
      if (!p && people.size < MAX_PEOPLE) { p = { since: now, num: freeNumber(), loc: '' }; people.set(id, p); }
      if (p) {
        Object.assign(p, { name, lastActive: now - idle, lastSeen: now, doing: String(m.doing ?? '').slice(0, 24) });
        if (p.ip !== ip) {
          // new player (or new network): look the place up; wait a moment so the first answer has it
          p.ip = ip;
          const look = locate(ip).then((loc) => { if (p.ip === ip) p.loc = loc; });
          await Promise.race([look, new Promise((r) => setTimeout(r, 1500))]);
        }
      }
    }
  }
  const list = [...people.entries()]
    .sort((a, b) => a[1].since - b[1].since)
    .slice(0, 100)
    .map(([pid, p]) => ({ name: p.name || `Player ${p.num}`, anon: !p.name || undefined, loc: p.loc || undefined, min: Math.floor((now - p.since) / 60000), active: now - p.lastActive < ACTIVE, idleMin: Math.floor((now - p.lastActive) / 60000), doing: p.doing, me: pid === id || undefined }));
  return { n: people.size, list };
}

/** Lowest player number nobody online is using, so numbers stay small and each player keeps theirs. */
function freeNumber() {
  const used = new Set([...people.values()].map((p) => p.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** The player's public IP. Railway and Render put it first in X-Forwarded-For. */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return (fwd || req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// ------------------------------------------------------------------ rough location from the IP address

const GEO_ON = process.env.GEO !== 'off';
const GEO_KEEP = 24 * 60 * 60 * 1000;
const geoCache = new Map();          // ip -> { loc, at }
const geoPending = new Map();        // ip -> Promise<string>

/** "Greenville, NC" in the US, "Toronto, CA" elsewhere; '' if unknown. One lookup per IP per day. */
function locate(ip) {
  if (!GEO_ON || !ip || isPrivate(ip)) return Promise.resolve('');
  const hit = geoCache.get(ip);
  if (hit && Date.now() - hit.at < GEO_KEEP) return Promise.resolve(hit.loc);
  if (geoPending.has(ip)) return geoPending.get(ip);
  const job = (async () => {
    let loc = '';
    try {
      const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,region_code,country_code`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      if (j.success) loc = placeName(j.city, j.region_code || j.region, j.country_code);
    } catch { /* try the second service */ }
    if (!loc) {
      try {
        const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,region,regionName,countryCode`, { signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        if (j.status === 'success') loc = placeName(j.city, j.region || j.regionName, j.countryCode);
      } catch { /* unknown */ }
    }
    if (geoCache.size > 5000) geoCache.clear();
    geoCache.set(ip, { loc, at: Date.now() });
    geoPending.delete(ip);
    if (loc) log('location', loc);
    return loc;
  })();
  geoPending.set(ip, job);
  return job;
}

function placeName(city, region, country) {
  const clean = (v) => String(v ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 28);
  city = clean(city); region = clean(region); country = clean(country).toUpperCase();
  const second = country === 'US' ? region : country;
  return [city || (country === 'US' ? '' : region), second].filter(Boolean).join(', ');
}

function isPrivate(ip) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/.test(ip)
    || ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}

// ------------------------------------------------------------------ websocket (RFC 6455, text frames)

class Client {
  constructor(socket, room) {
    this.socket = socket; this.room = room;
    this.buf = Buffer.alloc(0); this.frag = []; this.fragLen = 0;
    this.closed = false; this.alive = true;
    this.win = Date.now(); this.n = 0;
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.gone());
    socket.on('error', () => this.gone());
  }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > MAX_MSG + 16) return this.kill(1009);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, at = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return this.kill(1009); len = Number(big); at = 10; }
      if (!masked) return this.kill(1002);            // browsers always mask
      if (len > MAX_MSG) return this.kill(1009);
      if (b.length < at + 4 + len) return;
      const mask = b.subarray(at, at + 4);
      const data = Buffer.from(b.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(at + 4 + len);
      this.alive = true;
      if (op === 0x8) return this.kill(1000);
      if (op === 0x9) { this.frame(0xa, data); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frag.push(data); this.fragLen += data.length;
        if (this.fragLen > MAX_MSG) return this.kill(1009);
        if (!fin) continue;
        const msg = this.frag.length === 1 ? this.frag[0] : Buffer.concat(this.frag);
        this.frag = []; this.fragLen = 0;
        this.onMessage(msg);
        if (this.closed) return;
      }
    }
  }
  onMessage(msg) {
    const now = Date.now();
    if (now - this.win > 10000) { this.win = now; this.n = 0; }
    if (++this.n > MAX_RATE) return this.kill(1008);
    const set = rooms.get(this.room);
    if (!set) return;
    for (const c of set) if (c !== this) c.frame(0x1, msg);
  }
  sendText(s) { this.frame(0x1, Buffer.from(s)); }
  frame(op, data) {
    if (this.closed || this.socket.destroyed) return;
    const n = data.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n])
      : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
    this.socket.write(Buffer.concat([head, data]));
  }
  kill(code) {
    if (!this.closed) {
      const d = Buffer.alloc(2); d.writeUInt16BE(code);
      this.frame(0x8, d);
    }
    this.socket.end();
    this.gone();
  }
  gone() {
    if (this.closed) return;
    this.closed = true; conns--;
    const set = rooms.get(this.room);
    if (set) { set.delete(this); if (!set.size) rooms.delete(this.room); else count(this.room); }
    this.socket.destroy();
  }
}

// Keep connections open through proxies and drop dead ones (a closed laptop, lost wifi).
setInterval(() => {
  for (const set of rooms.values()) for (const c of set) {
    if (!c.alive) { c.kill(1001); continue; }
    c.alive = false;
    c.frame(0x9, Buffer.alloc(0));
  }
}, 20000).unref();

server.listen(PORT, () => log(`Mini2K relay on port ${PORT}`));
