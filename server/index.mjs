import { WebSocketServer, WebSocket } from 'ws';
import { RoomStore, PROTOCOL_VERSION } from './rooms.mjs';

const port = Number(process.env.WS_PORT || 3001);
const host = process.env.WS_HOST || '0.0.0.0';
const allowed = new Set((process.env.ROOM_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map((s) => s.trim()).filter(Boolean));
const wss = new WebSocketServer({ host, port, maxPayload: 2048, perMessageDeflate: false, verifyClient: ({ origin }, cb) => cb(Boolean(origin && allowed.has(origin)), origin && allowed.has(origin) ? 200 : 403, 'Origin not allowed') });
const rooms = new RoomStore({ send: (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); } });

wss.on('connection', (socket) => {
  socket.alive = true;
  socket.rate = { start: Date.now(), count: 0 };
  socket.on('pong', () => { socket.alive = true; });
  socket.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION }));
  socket.on('message', (raw, isBinary) => {
    if (isBinary) { socket.close(1003, 'JSON only'); return; }
    const now = Date.now();
    if (now - socket.rate.start > 1000) socket.rate = { start: now, count: 0 };
    if (++socket.rate.count > 180) { socket.close(1008, 'Rate limit'); return; }
    try { rooms.handle(socket, JSON.parse(raw.toString('utf8'))); }
    catch { rooms.fail(socket, 'BAD_JSON', 'Malformed JSON.'); }
  });
  socket.on('close', () => rooms.leave(socket));
  socket.on('error', () => rooms.leave(socket));
});

const heartbeat = setInterval(() => {
  rooms.prune();
  for (const client of wss.clients) {
    if (!client.alive) { client.terminate(); continue; }
    client.alive = false;
    client.ping();
  }
}, 30_000);
heartbeat.unref();

process.on('SIGTERM', () => { clearInterval(heartbeat); wss.close(() => process.exit(0)); });
console.log(`RetroDeck multiplayer relay listening on ws://${host}:${port} (origins: ${[...allowed].join(', ')})`);
