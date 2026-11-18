import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/rooms.mjs';

function setup() {
  const messages = new Map();
  const host = {}, guest = {}, third = {};
  const store = new RoomStore({ makeCode: () => 'ABC234', send: (socket, value) => {
    if (!messages.has(socket)) messages.set(socket, []);
    messages.get(socket).push(value);
  }});
  const inbox = (socket) => messages.get(socket) ?? [];
  const last = (socket) => inbox(socket).at(-1);
  return { store, host, guest, third, inbox, last };
}
function join(r) {
  r.store.handle(r.host, { type: 'create' });
  r.store.handle(r.guest, { type: 'join', code: 'abc234' });
}

test('new room is waiting; second peer starts same epoch', () => {
  const r=setup();
  r.store.handle(r.host, { type: 'create' });
  assert.equal(r.last(r.host).status, 'waiting');
  r.store.handle(r.guest, { type:'join', code:'abc234' });
  assert.deepEqual(r.last(r.host), { type: 'start', epoch: 1, frame: 0 });
  assert.deepEqual(r.last(r.guest), { type: 'start', epoch: 1, frame: 0 });
});

test('no game upload or ROM selection is needed; rejects missing rooms and third player', () => {
  const r = setup();
  r.store.handle(r.third, {type:'join',code:'MISSING'});
  assert.equal(r.last(r.third).code,'ROOM_NOT_FOUND');
  r.store.handle(r.host, {type:'create'});
  assert.equal(r.last(r.host).status,'waiting');
  r.store.handle(r.guest, {type:'join',code:'ABC234'});
  assert.equal(r.last(r.guest).type,'start');
  r.store.handle(r.third, {type:'join',code:'ABC234'});
  assert.equal(r.last(r.third).code,'ROOM_FULL');
});

test('room ignores arbitrary ROM metadata from clients', () => {
  const r = setup();
  r.store.handle(r.host, {type:'create',romSha:'untrusted',romName:'other-ROM'});
  const room = r.store.rooms.get('ABC234');
  assert.ok(room);
  assert.equal('romSha' in room, false);
  assert.equal('romName' in room, false);
  r.store.handle(r.guest, {type:'join',code:'ABC234',romSha:'different'});
  assert.equal(r.last(r.guest).type,'start');
});

test('broadcasts only complete ordered input frames', () => {
  const r=setup(); join(r);
  r.store.handle(r.host, {type:'input',epoch:1,frame:1,mask:1});
  r.store.handle(r.guest, {type:'input',epoch:1,frame:1,mask:2});
  assert.equal(r.last(r.host).type, 'start');
  r.store.handle(r.guest, {type:'input',epoch:1,frame:0,mask:8});
  r.store.handle(r.host, {type:'input',epoch:1,frame:0,mask:4});
  assert.deepEqual(r.inbox(r.host).filter(x=>x.type==='frame'), [
    {type:'frame',epoch:1,frame:0,p1:4,p2:8},
    {type:'frame',epoch:1,frame:1,p1:1,p2:2}
  ]);
});

test('rejects invalid and out-of-window input, ignores duplicate and stale frames', () => {
  const r=setup();join(r);
  r.store.handle(r.host,{type:'input',epoch:1,frame:26,mask:1});
  assert.equal(r.last(r.host).code, 'INVALID_INPUT');
  r.store.handle(r.host,{type:'input',epoch:1,frame:0,mask:1});
  r.store.handle(r.host,{type:'input',epoch:1,frame:0,mask:2});
  r.store.handle(r.guest,{type:'input',epoch:1,frame:0,mask:4});
  assert.equal(r.last(r.guest).p1,1);
  r.store.handle(r.host,{type:'reset'});
  assert.equal(r.last(r.host).epoch,2);
  r.store.handle(r.guest,{type:'input',epoch:1,frame:0,mask:4});
  assert.equal(r.last(r.host).type,'start');
});

test('pause blocks advancement; resume and reset unblock', () => {
  const r=setup();join(r);
  r.store.handle(r.guest,{type:'pause',paused:true});
  assert.equal(r.last(r.host).paused,true);
  r.store.handle(r.guest,{type:'input',epoch:1,frame:0,mask:0});
  r.store.handle(r.host,{type:'input',epoch:1,frame:0,mask:0});
  assert.equal(r.last(r.host).type,'pause');
  r.store.handle(r.host,{type:'pause',paused:false});
  r.store.handle(r.guest,{type:'input',epoch:1,frame:0,mask:0});
  r.store.handle(r.host,{type:'input',epoch:1,frame:0,mask:0});
  assert.equal(r.last(r.host).type,'frame');
});

test('desync triggers shared pause and fresh reset reinitializes state',()=>{
  const r=setup();join(r);
  r.store.rooms.get('ABC234').nextFrame=300;
  r.store.handle(r.host,{type:'checksum',epoch:1,frame:300,hash:'11111111'});
  r.store.handle(r.guest,{type:'checksum',epoch:1,frame:300,hash:'22222222'});
  assert.equal(r.last(r.host).type,'desync');
  r.store.handle(r.guest,{type:'reset'});
  assert.deepEqual(r.last(r.host),{type:'start',epoch:2,frame:0});
});

test('guest disconnection lets host reuse same room; host departure closes it',()=>{
  const r=setup();join(r);
  r.store.leave(r.guest);
  assert.equal(r.last(r.host).type,'peer_left');
  r.store.handle(r.third,{type:'join',code:'ABC234'});
  assert.equal(r.last(r.host).epoch,2);
  r.store.leave(r.host);
  assert.equal(r.last(r.third).type,'room_closed');
  assert.equal(r.store.rooms.size,0);
});

test('inactive rooms are pruned',()=>{
  const r=setup();r.store.handle(r.host,{type:'create'});
  r.store.prune(-1);
  assert.equal(r.store.rooms.size,0);
  assert.equal(r.last(r.host).type,'room_closed');
});
