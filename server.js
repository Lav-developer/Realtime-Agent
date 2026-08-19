const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');
const store = require('./lib/store');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_TEXT = 4000;
const MAX_NAME = 32;
const MAX_ROOM = 40;
const HISTORY_SEND = 250;
const HISTORY_KEEP = 800;
const FILE_MAX = 8 * 1024 * 1024;

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/json',
]);

const PALETTE = ['#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f43f5e', '#06b6d4'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 2e6,
});

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', fallthrough: false }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: FILE_MAX, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, users: online.size, rooms: rooms.size, uptime: process.uptime() });
});

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

const sockets = new Map(); // socket.id -> user
const online = new Map(); // userId -> { user, socketIds: Set }
const rooms = new Map(); // room -> messages[]
const roomsMeta = new Map();
const messages = new Map();
const disconnectTimers = new Map();

function hydrate() {
  const persisted = store.loadRooms();
  Object.entries(persisted.rooms || {}).forEach(([name, list]) => {
    const arr = Array.isArray(list) ? list : [];
    rooms.set(name, arr);
    arr.forEach((m) => {
      if (m && m.id) messages.set(m.id, m);
    });
  });
  Object.entries(persisted.meta || {}).forEach(([name, meta]) => {
    roomsMeta.set(name, meta || {});
  });
  ensurePublicRoom('Lobby', null, 'General conversation');
}

function snapshot() {
  return { rooms: Object.fromEntries(rooms), meta: Object.fromEntries(roomsMeta) };
}

let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => store.saveRooms(snapshot()), 400);
}

function ensurePublicRoom(name, createdBy, description) {
  if (!rooms.has(name)) rooms.set(name, []);
  const prev = roomsMeta.get(name) || {};
  if (prev.type === 'dm') return prev;
  const meta = {
    type: 'public',
    lastSeen: prev.lastSeen || {},
    createdAt: prev.createdAt || Date.now(),
    createdBy: prev.createdBy || createdBy || null,
    description: prev.description || description || '',
  };
  roomsMeta.set(name, meta);
  return meta;
}

function colorFromId(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(id);
}

function sanitizeName(n) {
  const name = String(n || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return name || 'Anonymous';
}

function sanitizeRoom(n) {
  return String(n || '')
    .replace(/[^\w\s\-.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ROOM);
}

function sanitizeText(t) {
  return String(t || '').slice(0, MAX_TEXT);
}

function dmRoomName(a, b) {
  return `dm-${[String(a), String(b)].sort().join('--')}`;
}

function rateLimit(socket, key, max, windowMs) {
  if (!socket.data.rl) socket.data.rl = {};
  const now = Date.now();
  const bucket = socket.data.rl[key] || { n: 0, t: now };
  if (now - bucket.t > windowMs) {
    bucket.n = 0;
    bucket.t = now;
  }
  bucket.n += 1;
  socket.data.rl[key] = bucket;
  return bucket.n <= max;
}

function publicUser(user, viewerId) {
  return {
    id: user.id,
    name: user.name,
    color: user.color,
    online: true,
    self: viewerId ? user.id === viewerId : false,
  };
}

function lastMessagePreview(roomName) {
  const arr = rooms.get(roomName) || [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m || m.deleted) continue;
    return {
      text: m.text || (m.attachments && m.attachments.length ? 'Attachment' : ''),
      ts: m.ts,
      userName: m.user?.name || '',
    };
  }
  return null;
}

function unreadCount(roomName, userId) {
  if (!userId) return 0;
  const meta = roomsMeta.get(roomName) || {};
  const lastSeen = (meta.lastSeen || {})[userId] || 0;
  const arr = rooms.get(roomName) || [];
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m || m.ts <= lastSeen) break;
    if (m.user?.id === userId) continue;
    n += 1;
    if (n > 99) break;
  }
  return n;
}

function listPublic(userId) {
  const out = [];
  for (const [name, meta] of roomsMeta.entries()) {
    if ((meta || {}).type === 'dm') continue;
    const last = lastMessagePreview(name);
    out.push({
      name,
      description: meta.description || '',
      unread: unreadCount(name, userId),
      lastMessage: last,
      lastTs: last?.ts || meta.createdAt || 0,
    });
  }
  out.sort((a, b) => {
    if (a.name === 'Lobby') return -1;
    if (b.name === 'Lobby') return 1;
    return (b.lastTs || 0) - (a.lastTs || 0);
  });
  return out;
}

function listDms(userId) {
  const out = [];
  if (!userId) return out;
  for (const [name, meta] of roomsMeta.entries()) {
    if ((meta || {}).type !== 'dm') continue;
    const members = meta.members || [];
    if (!members.includes(userId)) continue;
    const peerId = members.find((id) => id !== userId) || members[0];
    const peerOnline = online.get(peerId);
    const last = lastMessagePreview(name);
    out.push({
      room: name,
      peer: peerOnline
        ? publicUser(peerOnline.user, userId)
        : { id: peerId, name: meta.peerNames?.[peerId] || 'Someone', color: colorFromId(peerId), online: false, self: false },
      unread: unreadCount(name, userId),
      lastMessage: last,
      lastTs: last?.ts || meta.createdAt || 0,
    });
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out;
}

function listUsers(viewerId) {
  const seen = new Set();
  const out = [];
  for (const entry of online.values()) {
    if (!entry?.user || seen.has(entry.user.id)) continue;
    seen.add(entry.user.id);
    out.push(publicUser(entry.user, viewerId));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function emitStateTo(socket) {
  const user = sockets.get(socket.id);
  const uid = user?.id || null;
  socket.emit('workspace', {
    public: listPublic(uid),
    dms: listDms(uid),
    users: listUsers(uid),
    online: online.size,
  });
}

let stateTimer = null;
function emitStateAll() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    for (const s of io.sockets.sockets.values()) emitStateTo(s);
  }, 80);
}

function markRead(room, userId) {
  if (!room || !userId) return;
  const meta = roomsMeta.get(room);
  if (!meta) return;
  if (!meta.lastSeen) meta.lastSeen = {};
  meta.lastSeen[userId] = Date.now();
  persistSoon();
}

function pushMessage(room, payload) {
  const arr = rooms.get(room) || [];
  arr.push(payload);
  while (arr.length > HISTORY_KEEP) {
    const dropped = arr.shift();
    if (dropped?.id && messages.get(dropped.id) === dropped) messages.delete(dropped.id);
  }
  rooms.set(room, arr);
  messages.set(payload.id, payload);
  persistSoon();
}

function roomLabel(room, userId) {
  const meta = roomsMeta.get(room);
  if (meta?.type === 'dm') {
    const peerId = (meta.members || []).find((id) => id !== userId);
    const peer = peerId && online.get(peerId);
    return peer?.user?.name || meta.peerNames?.[peerId] || 'Direct message';
  }
  return room;
}

function canAccess(room, userId) {
  const meta = roomsMeta.get(room);
  if (!meta) return false;
  if (meta.type === 'dm') return (meta.members || []).includes(userId);
  return true;
}

function joinSocketToMemberships(socket, userId) {
  for (const [name, meta] of roomsMeta.entries()) {
    if (meta.type === 'dm') {
      if ((meta.members || []).includes(userId)) socket.join(name);
    } else {
      socket.join(name);
    }
  }
}

hydrate();

/* -------------------------------------------------------------------------- */
/*  Sockets                                                                    */
/* -------------------------------------------------------------------------- */

io.on('connection', (socket) => {
  emitStateTo(socket);

  socket.on('join', (incoming) => {
    try {
      if (!rateLimit(socket, 'join', 8, 10_000)) return;
      const payload = incoming && typeof incoming === 'object' ? incoming : {};
      const id = validId(payload.id) ? payload.id : `anon_${socket.id.slice(0, 12)}`;
      const name = sanitizeName(payload.name);
      const color = typeof payload.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.color)
        ? payload.color
        : colorFromId(id);
      const preferredRoom = sanitizeRoom(payload.room) || 'Lobby';

      const user = { id, name, color, socketId: socket.id };
      sockets.set(socket.id, user);

      const wasPending = disconnectTimers.has(id);
      if (wasPending) {
        clearTimeout(disconnectTimers.get(id));
        disconnectTimers.delete(id);
      }

      const existing = online.get(id);
      if (existing) {
        existing.user = user;
        existing.socketIds.add(socket.id);
      } else {
        online.set(id, { user, socketIds: new Set([socket.id]) });
      }

      ensurePublicRoom('Lobby', id, 'General conversation');
      joinSocketToMemberships(socket, id);

      let startRoom = preferredRoom;
      if (!roomsMeta.has(startRoom) || !canAccess(startRoom, id)) startRoom = 'Lobby';

      socket.emit('joined', {
        id: user.id,
        name: user.name,
        color: user.color,
        room: startRoom,
      });
      enterRoom(socket, user, startRoom);
      emitStateAll();
      if (!wasPending && !existing) {
        io.emit('presence', { type: 'join', user: publicUser(user), online: online.size });
      }
    } catch (e) {
      socket.emit('error-message', { message: 'Could not join workspace' });
    }
  });

  socket.on('profile', (incoming) => {
    const user = sockets.get(socket.id);
    if (!user) return;
    const payload = incoming && typeof incoming === 'object' ? incoming : {};
    if (payload.name) user.name = sanitizeName(payload.name);
    if (typeof payload.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.color)) user.color = payload.color;
    sockets.set(socket.id, user);
    const entry = online.get(user.id);
    if (entry) entry.user = user;
    for (const [name, meta] of roomsMeta.entries()) {
      if (meta.type === 'dm' && (meta.members || []).includes(user.id)) {
        meta.peerNames = meta.peerNames || {};
        meta.peerNames[user.id] = user.name;
      }
    }
    persistSoon();
    socket.emit('joined', { id: user.id, name: user.name, color: user.color, room: socket.data.room });
    emitStateAll();
  });

  socket.on('create-room', (incoming) => {
    const user = sockets.get(socket.id);
    if (!user) return socket.emit('error-message', { message: 'Join first' });
    if (!rateLimit(socket, 'room', 6, 15_000)) return socket.emit('error-message', { message: 'Too many rooms created' });
    const payload = incoming && typeof incoming === 'object' ? incoming : { name: incoming };
    const name = sanitizeRoom(payload.name);
    if (!name || name.toLowerCase() === 'lobby') {
      return socket.emit('error-message', { message: 'Enter a valid room name' });
    }
    const existing = roomsMeta.get(name);
    if (existing?.type === 'dm') return socket.emit('error-message', { message: 'Room not available' });
    ensurePublicRoom(name, user.id, sanitizeText(payload.description || '').slice(0, 140));
    persistSoon();
    enterRoom(socket, user, name);
    emitStateAll();
  });

  socket.on('join-room', (roomName) => {
    const user = sockets.get(socket.id);
    if (!user) return;
    const room = sanitizeRoom(roomName) || String(roomName || '');
    if (!room) return;
    const meta = roomsMeta.get(room);
    if (meta?.type === 'dm') {
      if (!canAccess(room, user.id)) {
        socket.emit('error-message', { message: 'Room not found' });
        return;
      }
      enterRoom(socket, user, room);
      emitStateAll();
      return;
    }
    if (!meta) ensurePublicRoom(sanitizeRoom(roomName) || room, user.id);
    const resolved = roomsMeta.has(room) ? room : sanitizeRoom(roomName);
    if (!resolved) return;
    socket.join(resolved);
    enterRoom(socket, user, resolved);
    emitStateAll();
  });

  socket.on('create-dm', (peerId) => {
    const user = sockets.get(socket.id);
    if (!user) return;
    const b = String(peerId || '');
    if (!validId(b) || b === user.id) return;
    if (!rateLimit(socket, 'dm', 10, 10_000)) return;

    const room = dmRoomName(user.id, b);
    if (!rooms.has(room)) rooms.set(room, []);
    const peerEntry = online.get(b);
    const peerName = peerEntry?.user?.name || 'Someone';
    const prev = roomsMeta.get(room) || {};
    roomsMeta.set(room, {
      type: 'dm',
      members: [user.id, b],
      lastSeen: prev.lastSeen || {},
      createdAt: prev.createdAt || Date.now(),
      peerNames: { ...(prev.peerNames || {}), [user.id]: user.name, [b]: peerName },
    });
    persistSoon();

    socket.join(room);
    if (peerEntry) {
      for (const sid of peerEntry.socketIds) {
        const peerSocket = io.sockets.sockets.get(sid);
        if (peerSocket) {
          peerSocket.join(room);
          peerSocket.emit('dm-invite', {
            room,
            from: publicUser(user),
          });
        }
      }
    }
    enterRoom(socket, user, room);
    emitStateAll();
  });

  socket.on('message', (incoming) => {
    const user = sockets.get(socket.id);
    if (!user) return socket.emit('error-message', { message: 'Join first' });
    if (!rateLimit(socket, 'msg', 20, 8_000)) return socket.emit('error-message', { message: 'You are sending messages too quickly' });

    let text = '';
    let room = socket.data.room || 'Lobby';
    let replyTo = null;
    let attachments = [];
    if (typeof incoming === 'string') text = incoming;
    else if (incoming && typeof incoming === 'object') {
      text = incoming.text || '';
      if (incoming.room) room = incoming.room;
      if (incoming.replyTo && incoming.replyTo.id) {
        const src = messages.get(incoming.replyTo.id);
        if (src && src.room === room) {
          replyTo = { id: src.id, text: String(src.text || '').slice(0, 160), userName: src.user?.name || 'User' };
        }
      }
      if (Array.isArray(incoming.attachments)) {
        attachments = incoming.attachments
          .slice(0, 4)
          .map(normalizeAttachment)
          .filter(Boolean);
      }
    }
    text = sanitizeText(text).trim();
    if (!text && !attachments.length) return;
    if (!canAccess(room, user.id)) return socket.emit('error-message', { message: 'Cannot send to this room' });

    const payload = {
      id: `${user.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      user: { id: user.id, name: user.name, color: user.color },
      text,
      ts: Date.now(),
      reactions: {},
      userReactions: {},
      room,
      replyTo,
      attachments,
      type: 'text',
    };
    pushMessage(room, payload);
    io.to(room).emit('message', payload);
    emitStateAll();
  });

  socket.on('reaction', ({ messageId, emoji } = {}) => {
    const user = sockets.get(socket.id);
    if (!user || !messageId || typeof emoji !== 'string') return;
    if (!rateLimit(socket, 'react', 40, 8_000)) return;
    const em = emoji.trim().slice(0, 16);
    if (!em) return;
    const msg = messages.get(messageId);
    if (!msg || msg.deleted) return;
    if (!canAccess(msg.room, user.id)) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.userReactions) msg.userReactions = {};

    const prev = msg.userReactions[user.id];
    if (prev === em) {
      const setPrev = new Set(msg.reactions[em] || []);
      setPrev.delete(user.id);
      if (setPrev.size === 0) delete msg.reactions[em];
      else msg.reactions[em] = Array.from(setPrev);
      delete msg.userReactions[user.id];
    } else {
      if (prev) {
        const setPrev = new Set(msg.reactions[prev] || []);
        setPrev.delete(user.id);
        if (setPrev.size === 0) delete msg.reactions[prev];
        else msg.reactions[prev] = Array.from(setPrev);
      }
      const setNew = new Set(msg.reactions[em] || []);
      setNew.add(user.id);
      msg.reactions[em] = Array.from(setNew);
      msg.userReactions[user.id] = em;
    }
    persistSoon();
    io.to(msg.room).emit('reaction', {
      messageId,
      reactions: msg.reactions,
      userReactions: msg.userReactions,
    });
  });

  socket.on('edit-message', ({ messageId, text } = {}) => {
    const user = sockets.get(socket.id);
    if (!user) return;
    const msg = messages.get(messageId);
    if (!msg || msg.deleted) return;
    if (!msg.user || msg.user.id !== user.id) return;
    const next = sanitizeText(text).trim();
    if (!next && !(msg.attachments && msg.attachments.length)) return;
    msg.text = next;
    msg.edited = true;
    msg.editedTs = Date.now();
    persistSoon();
    io.to(msg.room).emit('message-updated', msg);
  });

  socket.on('delete-message', ({ messageId } = {}) => {
    const user = sockets.get(socket.id);
    if (!user) return;
    const msg = messages.get(messageId);
    if (!msg) return;
    if (!msg.user || msg.user.id !== user.id) return;
    msg.deleted = true;
    msg.text = '';
    msg.attachments = [];
    const arr = rooms.get(msg.room) || [];
    const idx = arr.findIndex((m) => m.id === messageId);
    if (idx >= 0) arr[idx] = msg;
    persistSoon();
    io.to(msg.room).emit('message-deleted', { messageId });
  });

  socket.on('typing', () => {
    const user = sockets.get(socket.id);
    const room = socket.data.room;
    if (!user || !room) return;
    socket.to(room).emit('typing', { room, user: publicUser(user) });
  });

  socket.on('stop-typing', () => {
    const user = sockets.get(socket.id);
    const room = socket.data.room;
    if (!user || !room) return;
    socket.to(room).emit('stop-typing', { room, user: publicUser(user) });
  });

  socket.on('mark-read', (roomName) => {
    const user = sockets.get(socket.id);
    if (!user) return;
    const room = String(roomName || socket.data.room || '');
    if (room && canAccess(room, user.id)) markRead(room, user.id);
  });

  socket.on('disconnect', () => {
    const user = sockets.get(socket.id);
    sockets.delete(socket.id);
    if (!user) return;
    const entry = online.get(user.id);
    if (entry) {
      entry.socketIds.delete(socket.id);
      if (entry.socketIds.size > 0) return;
    }
    disconnectTimers.set(
      user.id,
      setTimeout(() => {
        disconnectTimers.delete(user.id);
        const still = online.get(user.id);
        if (still && still.socketIds.size > 0) return;
        online.delete(user.id);
        emitStateAll();
        io.emit('presence', { type: 'leave', user: { id: user.id, name: user.name, color: user.color }, online: online.size });
      }, 3500)
    );
  });
});

function publicMeta(room) {
  const meta = roomsMeta.get(room) || { type: 'public' };
  return {
    type: meta.type || 'public',
    description: meta.description || '',
    members: meta.members || null,
  };
}

function enterRoom(socket, user, room) {
  socket.data.room = room;
  socket.join(room);
  const prevSeen = ((roomsMeta.get(room) || {}).lastSeen || {})[user.id] || 0;
  markRead(room, user.id);
  const history = (rooms.get(room) || []).filter((m) => !m.deleted).slice(-HISTORY_SEND);
  socket.emit('room-joined', {
    room,
    label: roomLabel(room, user.id),
    meta: publicMeta(room),
    messages: history,
    lastSeen: prevSeen,
  });
}

function normalizeAttachment(file) {
  if (!file || typeof file !== 'object') return null;
  const url = String(file.url || '');
  if (!url.startsWith('/uploads/')) return null;
  const base = path.basename(url);
  if (!fs.existsSync(path.join(uploadsDir, base))) return null;
  return {
    url: `/uploads/${base}`,
    name: String(file.name || base).slice(0, 120),
    size: Number(file.size) || 0,
    type: String(file.type || '').slice(0, 80),
  };
}

server.listen(PORT, HOST, () => {
  console.log(`Realtime Agent listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  try { store.saveRooms(snapshot()); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
