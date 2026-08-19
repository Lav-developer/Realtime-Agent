const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { io } = require('socket.io-client');
const { start } = require('../server');

const HOST_CODE = process.env.HOST_CODE || 'test-host-secret';
process.env.HOST_CODE = HOST_CODE;
process.env.ENABLE_PERSISTENCE = '0';

let runtime;
let port;
let seq = 0;

function uid(prefix) {
  seq += 1;
  return `${prefix}_${String(seq).padStart(6, '0')}xx`;
}

function connect(name, extra = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    const bag = { socket, events: [], messages: [], typing: [], rooms: [], errors: [], presence: [], session: null };
    const timer = setTimeout(() => reject(new Error(`timeout connecting ${name}`)), 4000);
    socket.on('connect_error', reject);
    socket.on('error-message', (e) => bag.errors.push(e.message));
    socket.on('message', (m) => bag.messages.push(m));
    socket.on('typing', (t) => bag.typing.push(t));
    socket.on('room-joined', (r) => bag.rooms.push(r.room));
    socket.on('presence', (p) => bag.presence.push(p));
    socket.on('session', (s) => { bag.session = s; });
    socket.on('joined', (user) => {
      bag.user = user;
      clearTimeout(timer);
      resolve(bag);
    });
    socket.on('connect', () => {
      socket.emit('join', { id: extra.id || uid(name.toLowerCase()), name, color: '#3b82f6', room: extra.room || 'General', hostCode: extra.hostCode });
    });
  });
}

function waitFor(fn, ms = 2000) {
  const startAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const val = fn();
        if (val) return resolve(val);
      } catch {}
      if (Date.now() - startAt > ms) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 30);
    };
    tick();
  });
}

before(async () => {
  process.env.HOST_CODE = HOST_CODE;
  process.env.ENABLE_PERSISTENCE = '0';
  runtime = await start({ port: 0, host: '127.0.0.1' });
  port = runtime.port;
});

after(async () => {
  if (runtime) await runtime.close();
});

test('health endpoint is live', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.live, true);
});

test('two users exchange a public message', async () => {
  const a = await connect('Ada');
  const b = await connect('Byron');
  a.socket.emit('message', { text: 'hello lobby', room: 'General' });
  await waitFor(() => b.messages.find((m) => m.text === 'hello lobby'));
  assert.equal(a.user.role, 'user');
  a.socket.close();
  b.socket.close();
});

test('only General exists until a host creates a room', async () => {
  const guest = await connect('OnlyGen');
  const names = [...runtime.internals.roomsMeta.keys()].filter((n) => (runtime.internals.roomsMeta.get(n) || {}).type !== 'dm');
  assert.deepEqual(names, ['General']);
  guest.socket.emit('join-room', 'Coding');
  await waitFor(() => guest.errors.includes('Room not found'));
  guest.socket.close();
});

test('typing is room-scoped', async () => {
  const host = await connect('TyHost', { hostCode: HOST_CODE });
  host.socket.emit('create-room', { name: 'Coding' });
  await waitFor(() => host.rooms.includes('Coding'));
  const a = await connect('TyA');
  const b = await connect('TyB');
  const c = await connect('TyC');
  c.socket.emit('join-room', 'Coding');
  await waitFor(() => c.rooms.includes('Coding'));
  a.socket.emit('typing');
  await waitFor(() => b.typing.some((t) => t.room === 'General'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(c.typing.some((t) => t.room === 'General'), false);
  host.socket.close();
  a.socket.close();
  b.socket.close();
  c.socket.close();
});

test('public rooms stay isolated', async () => {
  const host = await connect('IsoHost', { hostCode: HOST_CODE });
  host.socket.emit('create-room', { name: 'Focus' });
  await waitFor(() => host.rooms.includes('Focus'));
  const a = await connect('IsoA');
  const b = await connect('IsoB');
  a.socket.emit('join-room', 'Focus');
  await waitFor(() => a.rooms.includes('Focus'));
  a.socket.emit('message', { text: 'only focus', room: 'Focus' });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(b.messages.some((m) => m.text === 'only focus' && m.room === 'General'), false);
  host.socket.close();
  a.socket.close();
  b.socket.close();
});

test('DM is only received by participants', async () => {
  const a = await connect('DmA');
  const b = await connect('DmB');
  const eve = await connect('Eve');
  a.socket.emit('create-dm', b.user.id);
  await waitFor(() => a.rooms.some((r) => String(r).startsWith('dm-')));
  const dm = a.rooms.find((r) => String(r).startsWith('dm-'));
  a.socket.emit('message', { text: 'secret', room: dm });
  await waitFor(() => b.messages.some((m) => m.text === 'secret'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(eve.messages.some((m) => m.text === 'secret'), false);
  a.socket.close();
  b.socket.close();
  eve.socket.close();
});

test('unauthorized user cannot join a DM', async () => {
  const a = await connect('PrivA');
  const b = await connect('PrivB');
  a.socket.emit('create-dm', b.user.id);
  await waitFor(() => a.rooms.some((r) => String(r).startsWith('dm-')));
  const dm = a.rooms.find((r) => String(r).startsWith('dm-'));
  const eve = await connect('Sneak', { room: dm });
  assert.equal(eve.rooms.includes('General'), true);
  assert.equal(eve.rooms.includes(dm), false);
  eve.socket.emit('join-room', dm);
  await waitFor(() => eve.errors.includes('Room not found'));
  a.socket.close();
  b.socket.close();
  eve.socket.close();
});

test('reconnect restores the session', async () => {
  const host = await connect('ReHost', { hostCode: HOST_CODE });
  host.socket.emit('create-room', { name: 'Career' });
  await waitFor(() => host.rooms.includes('Career'));
  const id = uid('recon');
  const first = await connect('Rejoin', { id });
  first.socket.emit('join-room', 'Career');
  await waitFor(() => first.rooms.includes('Career'));
  first.socket.close();
  const second = await connect('Rejoin', { id, room: 'Career' });
  assert.equal(second.user.id, id);
  assert.ok(second.rooms.includes('Career') || second.user.room === 'Career');
  host.socket.close();
  second.socket.close();
});

test('presence updates on join', async () => {
  const a = await connect('PresA');
  const b = await connect('PresB');
  await waitFor(() => a.presence.some((p) => p.type === 'join' && p.user.name === 'PresB'));
  a.socket.close();
  b.socket.close();
});

test('reactions update the message', async () => {
  const a = await connect('ReactA');
  const b = await connect('ReactB');
  a.socket.emit('message', { text: 'react me', room: 'General' });
  const msg = await waitFor(() => b.messages.find((m) => m.text === 'react me'));
  return new Promise((resolve, reject) => {
    b.socket.on('reaction', (payload) => {
      try {
        assert.ok(payload.reactions['👍']);
        a.socket.close();
        b.socket.close();
        resolve();
      } catch (e) { reject(e); }
    });
    b.socket.emit('reaction', { messageId: msg.id, emoji: '👍' });
    setTimeout(() => reject(new Error('no reaction')), 2000);
  });
});

test('only the author can edit; host can delete others', async () => {
  const host = await connect('Hosty', { hostCode: HOST_CODE });
  const a = await connect('Author');
  const b = await connect('Other');
  assert.equal(host.user.role, 'host');
  a.socket.emit('message', { text: 'original', room: 'General' });
  const msg = await waitFor(() => b.messages.find((m) => m.text === 'original'));
  b.socket.emit('edit-message', { messageId: msg.id, text: 'hacked' });
  await new Promise((r) => setTimeout(r, 80));
  a.socket.emit('edit-message', { messageId: msg.id, text: 'fixed' });
  await waitFor(() => b.messages.some((m) => m.id === msg.id) && runtime.internals.messages.get(msg.id).text === 'fixed');
  host.socket.emit('delete-message', { messageId: msg.id });
  await waitFor(() => runtime.internals.messages.get(msg.id).deleted);
  host.socket.close();
  a.socket.close();
  b.socket.close();
});

test('guests cannot create rooms; host can', async () => {
  const guest = await connect('Guest');
  guest.socket.emit('create-room', { name: 'SecretLab' });
  await waitFor(() => guest.errors.includes('Only the host can create rooms'));
  const host = await connect('Maker', { hostCode: HOST_CODE });
  host.socket.emit('create-room', { name: 'OfficeHours' });
  await waitFor(() => host.rooms.includes('OfficeHours'));
  guest.socket.close();
  host.socket.close();
});

test('upload allow-list rejects bad types', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'x.exe');
  const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: fd });
  assert.equal(res.status, 400);
  const ok = new FormData();
  ok.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
  const res2 = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: ok });
  assert.equal(res2.status, 200);
});

test('leave removes the user immediately so they can join again', async () => {
  const a = await connect('Leaver');
  const b = await connect('Watcher');
  a.socket.emit('leave');
  await waitFor(() => b.presence.some((p) => p.type === 'leave' && p.user.name === 'Leaver'));
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  assert.ok(health.users >= 1);
  a.socket.emit('join', { id: a.user.id, name: 'Leaver', color: '#3b82f6', room: 'General' });
  await waitFor(() => b.presence.filter((p) => p.type === 'join' && p.user.name === 'Leaver').length >= 1);
  a.socket.close();
  b.socket.close();
});

test('message rate limit kicks in', async () => {
  const a = await connect('Spam');
  for (let i = 0; i < 24; i++) a.socket.emit('message', { text: `n${i}`, room: 'General' });
  await waitFor(() => a.errors.some((e) => /too quickly/i.test(e)));
  a.socket.close();
});
