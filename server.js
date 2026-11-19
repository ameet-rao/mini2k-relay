// Mini2K relay server. No dependencies: plain Node (18 or newer).
//
// What it does:
//   GET  /            the online game page (public/index.html), so friends can just open the address
//   GET  /health      "ok" (also used by the game to wake the server up on free hosting)
//   WS   /ws?room=X   a room: every message one screen sends is passed to the other screens in the room.
//                     The game uses one room for finding each other (room code) and, when school wifi
//                     blocks a direct connection, a second room to carry the game itself.
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
const MAX_IN_ROOM = 8;            // 2v2: four players, someone watching, and a stale tab or a rejoin
const MAX_MSG = 2 * 1024 * 1024;  // one message (a full game snapshot is well under this)
const MAX_RATE = 3000;            // messages per 10 s per connection (the game sends about 130 a second)
const MAX_CONN = 400;             // whole server

const rooms = new Map();          // room -> Set<Client>
let conns = 0;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ http

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (url.pathname === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
    res.end(`ok ${rooms.size} rooms, ${conns} connections`);
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
