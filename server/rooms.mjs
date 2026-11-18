import { randomInt } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_SIZE = 6;
const MAX_AHEAD = 24;
const MAX_ROOMS = 1000;
const MAX_NAME = 64;
const MAX_FRAME = 60 * 60 * 12; // 12 hours of uninterrupted play
const ROM_SHA = /^[a-f0-9]{64}$/;

function cleanName(name) {
  return typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
}

export class RoomStore {
  constructor({ send, now = () => Date.now(), makeCode } = {}) {
    this.rooms = new Map();
    this.peers = new Map();
    this.send = send ?? ((peer, message) => peer.send(JSON.stringify(message)));
    this.now = now;
    this.makeCode = makeCode ?? (() => Array.from({ length: CODE_SIZE }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join(''));
  }

  emit(peer, message) {
    if (peer) this.send(peer, message);
  }

  broadcast(room, message) {
    this.emit(room.host, message);
    this.emit(room.guest, message);
  }

  fail(peer, code, message) {
    this.emit(peer, { type: 'error', code, message });
  }

  handle(peer, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') return this.fail(peer, 'BAD_MESSAGE', 'Invalid message.');
    const member = this.peers.get(peer);
    if (message.type === 'create') {
      if (member) return this.fail(peer, 'ALREADY_IN_ROOM', 'Leave the current room first.');
      if (this.rooms.size >= MAX_ROOMS) return this.fail(peer, 'BUSY', 'Room capacity reached.');
      if (!ROM_SHA.test(message.romSha) || !cleanName(message.romName)) return this.fail(peer, 'INVALID_ROM', 'Choose a valid ROM first.');
      let code;
      for (let tries = 0; tries < 10; tries++) {
        const candidate = this.makeCode();
        if (/^[A-HJ-NP-Z2-9]{6}$/.test(candidate) && !this.rooms.has(candidate)) { code = candidate; break; }
      }
      if (!code) return this.fail(peer, 'BUSY', 'Unable to allocate a room.');
      const room = {
        code, host: peer, guest: null, romSha: message.romSha, romName: cleanName(message.romName),
        epoch: 0, nextFrame: 0, pending: new Map(), checksums: new Map(), paused: false,
        createdAt: this.now(), touchedAt: this.now(),
      };
      this.rooms.set(code, room);
      this.peers.set(peer, { code, player: 1 });
      this.emit(peer, { type: 'room', code, player: 1, romSha: room.romSha, romName: room.romName, players: 1, status: 'waiting' });
      return;
    }
    if (message.type === 'join') {
      if (member) return this.fail(peer, 'ALREADY_IN_ROOM', 'Leave the current room first.');
      const room = typeof message.code === 'string' ? this.rooms.get(message.code.trim().toUpperCase()) : undefined;
      if (!room) return this.fail(peer, 'ROOM_NOT_FOUND', 'Room not found. Ask the host for the code.');
      if (room.guest) return this.fail(peer, 'ROOM_FULL', 'This room already has two players.');
      if (room.romSha !== message.romSha) return this.fail(peer, 'ROM_MISMATCH', 'Players must load the exact same .nes file (SHA-256 mismatch).');
      room.guest = peer;
      room.touchedAt = this.now();
      this.peers.set(peer, { code: room.code, player: 2 });
      this.emit(peer, { type: 'room', code: room.code, player: 2, romSha: room.romSha, romName: room.romName, players: 2, status: 'ready' });
      this.emit(room.host, { type: 'peer_joined', players: 2 });
      this.start(room);
      return;
    }
    if (message.type === 'leave') return this.leave(peer);
    if (!member) return this.fail(peer, 'NOT_IN_ROOM', 'Create or join a room first.');
    const room = this.rooms.get(member.code);
    if (!room || room[member.player === 1 ? 'host' : 'guest'] !== peer) return this.fail(peer, 'NOT_IN_ROOM', 'Room is no longer available.');
    room.touchedAt = this.now();
    if (message.type === 'input') {
      if (!room.guest || room.paused || message.epoch !== room.epoch) return;
      if (!Number.isInteger(message.frame) || message.frame < room.nextFrame || message.frame > Math.min(MAX_FRAME, room.nextFrame + MAX_AHEAD) || !Number.isInteger(message.mask) || message.mask < 0 || message.mask > 255) return this.fail(peer, 'INVALID_INPUT', 'Input frame outside allowed window.');
      const pair = room.pending.get(message.frame) ?? { p1: null, p2: null };
      const field = member.player === 1 ? 'p1' : 'p2';
      if (pair[field] !== null) return; // first input for a frame is final
      pair[field] = message.mask;
      room.pending.set(message.frame, pair);
      this.flush(room);
      return;
    }
    if (message.type === 'pause') {
      if (!room.guest || typeof message.paused !== 'boolean') return;
      room.paused = message.paused;
      this.broadcast(room, { type: 'pause', paused: room.paused, by: member.player, epoch: room.epoch });
      if (!room.paused) this.flush(room);
      return;
    }
    if (message.type === 'reset') {
      if (!room.guest) return;
      this.start(room);
      return;
    }
    if (message.type === 'checksum') {
      if (!room.guest || room.paused || message.epoch !== room.epoch) return;
      if (!Number.isInteger(message.frame) || message.frame <= 0 || message.frame % 300 !== 0 || message.frame > room.nextFrame || !/^[a-f0-9]{8}$/.test(message.hash)) return;
      const check = room.checksums.get(message.frame) ?? { p1: null, p2: null };
      check[member.player === 1 ? 'p1' : 'p2'] = message.hash;
      room.checksums.set(message.frame, check);
      if (check.p1 && check.p2) {
        if (check.p1 !== check.p2) {
          room.paused = true;
          this.broadcast(room, { type: 'desync', frame: message.frame, message: 'Emulators diverged. Reset the match together.' });
        }
        room.checksums.delete(message.frame);
      }
      if (room.checksums.size > 6) room.checksums.delete(room.checksums.keys().next().value);
      return;
    }
    this.fail(peer, 'UNKNOWN_ACTION', 'Unsupported message type.');
  }

  start(room) {
    room.epoch++;
    room.paused = false;
    room.nextFrame = 0;
    room.pending.clear();
    room.checksums.clear();
    this.broadcast(room, { type: 'start', epoch: room.epoch, frame: 0 });
  }

  flush(room) {
    while (!room.paused && room.guest) {
      const pair = room.pending.get(room.nextFrame);
      if (!pair || pair.p1 === null || pair.p2 === null) break;
      room.pending.delete(room.nextFrame);
      this.broadcast(room, { type: 'frame', epoch: room.epoch, frame: room.nextFrame, p1: pair.p1, p2: pair.p2 });
      room.nextFrame++;
    }
  }

  leave(peer) {
    const member = this.peers.get(peer);
    if (!member) return;
    this.peers.delete(peer);
    const room = this.rooms.get(member.code);
    if (!room) return;
    if (member.player === 1) {
      this.rooms.delete(room.code);
      if (room.guest) {
        this.peers.delete(room.guest);
        this.emit(room.guest, { type: 'room_closed', message: 'Host left the room.' });
      }
    } else {
      room.guest = null;
      room.paused = false;
      room.pending.clear();
      room.checksums.clear();
      room.touchedAt = this.now();
      this.emit(room.host, { type: 'peer_left', players: 1, message: 'Player 2 left. Waiting for a replacement.' });
    }
  }

  prune(maxAgeMs = 30 * 60 * 1000) {
    for (const room of this.rooms.values()) {
      if (this.now() - room.touchedAt > maxAgeMs) {
        this.emit(room.host, { type: 'room_closed', message: 'Room expired due to inactivity.' });
        this.emit(room.guest, { type: 'room_closed', message: 'Room expired due to inactivity.' });
        this.peers.delete(room.host);
        if (room.guest) this.peers.delete(room.guest);
        this.rooms.delete(room.code);
      }
    }
  }
}
