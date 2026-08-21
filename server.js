const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');
const store = require('./lib/store');
const { verifyHostCode } = require('./lib/hostAuth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_TEXT = 4000;
const MAX_NAME = 32;
const MAX_ROOM = 40;
const HISTORY_SEND = 250;
const HISTORY_KEEP = 400;
const FILE_MAX = 8 * 1024 * 1024;

const MIME_EXT = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  'application/zip': ['.zip'],
  'application/json': ['.json'],
};

const PALETTE = ['#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f43f5e', '#06b6d4'];

const DEFAULT_ROOMS = [
  { name: 'General', description: 'Ask anything — everyone is welcome' },
];

const HELP_CATEGORIES = new Set(['Coding', 'College', 'Career', 'Projects', 'General', 'Other']);

function createRuntime(options = {}) {
  const corsOrigin = options.corsOrigin || CORS_ORIGIN;
  const uploadsDir = options.uploadsDir || path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 2e6,
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  const sockets = new Map();
  const online = new Map();
  const rooms = new Map();
  const roomsMeta = new Map();
  const messages = new Map();
  const disconnectTimers = new Map();
  const hostIds = new Set();
  const pendingHelp = [];
  const uploadHits = new Map();

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
  app.use('/uploads', express.static(uploadsDir, { maxAge: '1h', fallthrough: false }));

  app.get('/download/:name', (req, res) => {
    const name = path.basename(String(req.params.name || ''));
    if (!name || name.includes('..')) return res.status(400).json({ error: 'Invalid file' });
    const filePath = path.join(uploadsDir, name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    const downloadName = String(req.query.name || name).replace(/[/\\]/g, '').slice(0, 120) || name;
    res.download(filePath, downloadName);
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const ext = safeExt(file.originalname, file.mimetype);
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: FILE_MAX, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (!MIME_EXT[file.mimetype]) return cb(new Error('File type not allowed'));
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (ext && !MIME_EXT[file.mimetype].includes(ext)) return cb(new Error('File extension does not match type'));
      cb(null, true);
    },
  });

  function sessionInfo() {
    let hosts = 0;
    for (const entry of online.values()) {
      if (entry?.user?.role === 'host') hosts += 1;
    }
    return { live: true, hosts, hostOnline: hosts > 0, users: online.size };
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      live: true,
      users: online.size,
      hosts: sessionInfo().hosts,
      hostOnline: sessionInfo().hostOnline,
      rooms: rooms.size,
      uptime: process.uptime(),
    });
  });

  app.post('/upload', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!hitOk(uploadHits, ip, 12, 60_000)) {
      return res.status(429).json({ error: 'Too many uploads. Please wait a moment.' });
    }
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (req.file && req.file.path) {
          try { fs.unlinkSync(req.file.path); } catch {}
        }
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      res.json({
        url: `/uploads/${req.file.filename}`,
        name: String(req.file.originalname || 'file').replace(/[/\\]/g, '').slice(0, 120),
        size: req.file.size,
        type: req.file.mimetype,
      });
    });
  });

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
    DEFAULT_ROOMS.forEach((r) => ensurePublicRoom(r.name, null, r.description));
  }

  function snapshot() {
    return { rooms: Object.fromEntries(rooms), meta: Object.fromEntries(roomsMeta) };
  }

  let persistTimer = null;
  function persistSoon() {
    if (!store.persistenceEnabled()) return;
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

  function isHost(user) {
    return !!(user && user.role === 'host' && hostIds.has(user.id));
  }

  function publicUser(user, viewerId) {
    return {
      id: user.id,
      name: user.name,
      color: user.color,
      role: user.role === 'host' ? 'host' : 'user',
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
    const rank = (n) => DEFAULT_ROOMS.findIndex((r) => r.name === n);
    out.sort((a, b) => {
      const ra = rank(a.name);
      const rb = rank(b.name);
      if (ra >= 0 || rb >= 0) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
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
          : {
            id: peerId,
            name: meta.peerNames?.[peerId] || 'Someone',
            color: colorFromId(peerId),
            role: hostIds.has(peerId) ? 'host' : 'user',
            online: false,
            self: false,
          },
        unread: unreadCount(name, userId),
        lastMessage: last,
        lastTs: last?.ts || meta.createdAt || 0,
        help: !!meta.help,
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
    out.sort((a, b) => {
      if (a.role === 'host' && b.role !== 'host') return -1;
      if (b.role === 'host' && a.role !== 'host') return 1;
      return a.name.localeCompare(b.name);
    });
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
      session: sessionInfo(),
      canCreateRoom: isHost(user),
    });
  }

  let stateTimer = null;
  function emitStateAll() {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      const session = sessionInfo();
      io.emit('session', session);
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
    if (meta.type === 'dm') emitReadReceipts(room, userId, meta.lastSeen[userId]);
  }

  function emitReadReceipts(room, readerId, ts) {
    const arr = rooms.get(room) || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (!m || m.ts > ts) continue;
      if (m.user?.id === readerId) continue;
      if (m.readBy && m.readBy.includes(readerId)) continue;
      m.readBy = [...(m.readBy || []), readerId];
      io.to(room).emit('receipt', { messageId: m.id, room, read: true, readBy: m.readBy });
    }
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
      if (meta.help && meta.helpTitle) return meta.helpTitle;
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

  function publicMeta(room) {
    const meta = roomsMeta.get(room) || { type: 'public' };
    return {
      type: meta.type || 'public',
      description: meta.description || '',
      members: meta.members || null,
      help: !!meta.help,
    };
  }

  function emitToViewers(room, event, payload, exceptId) {
    for (const s of io.sockets.sockets.values()) {
      if (s.id === exceptId) continue;
      if (s.data.room === room) s.emit(event, payload);
    }
  }

  function enterRoom(socket, user, room) {
    const prev = socket.data.room;
    if (prev && prev !== room) {
      emitToViewers(prev, 'stop-typing', { room: prev, user: publicUser(user) }, socket.id);
    }
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
    if (base.includes('..') || !fs.existsSync(path.join(uploadsDir, base))) return null;
    return {
      url: `/uploads/${base}`,
      name: String(file.name || base).replace(/[/\\]/g, '').slice(0, 120),
      size: Number(file.size) || 0,
      type: String(file.type || '').slice(0, 80),
    };
  }

  function firstHost() {
    for (const entry of online.values()) {
      if (entry?.user?.role === 'host') return entry.user;
    }
    return null;
  }

  function openDm(user, peerId, extraMeta = {}) {
    const room = extraMeta.room || dmRoomName(user.id, peerId);
    if (!rooms.has(room)) rooms.set(room, []);
    const peerEntry = online.get(peerId);
    const peerName = peerEntry?.user?.name || extraMeta.peerName || 'Someone';
    const prev = roomsMeta.get(room) || {};
    roomsMeta.set(room, {
      type: 'dm',
      members: prev.members || [user.id, peerId],
      lastSeen: prev.lastSeen || {},
      createdAt: prev.createdAt || Date.now(),
      peerNames: { ...(prev.peerNames || {}), [user.id]: user.name, [peerId]: peerName },
      help: extraMeta.help || prev.help || false,
      helpTitle: extraMeta.helpTitle || prev.helpTitle || '',
    });
    persistSoon();
    const userEntry = online.get(user.id);
    if (userEntry) {
      for (const sid of userEntry.socketIds) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.join(room);
      }
    }
    if (peerEntry) {
      for (const sid of peerEntry.socketIds) {
        const peerSocket = io.sockets.sockets.get(sid);
        if (peerSocket) {
          peerSocket.join(room);
          peerSocket.emit('dm-invite', { room, from: publicUser(user), help: !!extraMeta.help });
        }
      }
    }
    return room;
  }

  function flushPendingHelp(hostUser) {
    if (!pendingHelp.length) return;
    const queued = pendingHelp.splice(0, pendingHelp.length);
    queued.forEach((item) => {
      const asker = online.get(item.userId);
      const asUser = asker?.user || { id: item.userId, name: item.name, color: colorFromId(item.userId), role: 'user' };
      const room = openDm(asUser, hostUser.id, { help: true, helpTitle: item.title, peerName: hostUser.name });
      const payload = helpMessage(asUser, room, item);
      pushMessage(room, payload);
      io.to(room).emit('message', payload);
    });
    emitStateAll();
  }

  function helpMessage(user, room, item) {
    const cat = HELP_CATEGORIES.has(item.category) ? item.category : 'General';
    const title = sanitizeText(item.title || 'Help request').slice(0, 80);
    const body = sanitizeText(item.description || '').trim();
    return {
      id: `${user.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      user: { id: user.id, name: user.name, color: user.color, role: user.role || 'user' },
      text: `🆘 ${title}\nCategory: ${cat}${body ? `\n\n${body}` : ''}`,
      ts: Date.now(),
      reactions: {},
      userReactions: {},
      room,
      replyTo: null,
      attachments: Array.isArray(item.attachments) ? item.attachments.map(normalizeAttachment).filter(Boolean).slice(0, 2) : [],
      type: 'help',
      help: { title, category: cat, body },
      delivered: true,
      readBy: [],
    };
  }

  hydrate();

  io.on('connection', (socket) => {
    socket.emit('session', sessionInfo());
    emitStateTo(socket);

    socket.on('ping-rtt', (sentAt) => {
      socket.emit('pong-rtt', typeof sentAt === 'number' ? sentAt : Date.now());
    });

    socket.on('join', (incoming) => {
      try {
        if (!rateLimit(socket, 'join', 8, 10_000)) return;
        const payload = incoming && typeof incoming === 'object' ? incoming : {};
        const id = validId(payload.id) ? payload.id : `anon_${String(socket.id).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
        const name = sanitizeName(payload.name);
        const color = typeof payload.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.color)
          ? payload.color
          : colorFromId(id);
        // A persisted/current DM name may be longer than a public channel name.
        // Preserve an exact known room for reconnects; only sanitize a prospective
        // public-channel label.
        const requestedRoom = typeof payload.room === 'string' ? payload.room : '';
        const preferredRoom = roomsMeta.has(requestedRoom)
          ? requestedRoom
          : (sanitizeRoom(requestedRoom) || 'General');

        let role = 'user';
        if (hostIds.has(id)) role = 'host';
        else if (payload.hostCode) {
          if (!rateLimit(socket, 'hostcode', 5, 10 * 60_000)) {
            socket.emit('error-message', { message: 'Too many access attempts' });
          } else if (verifyHostCode(payload.hostCode)) {
            role = 'host';
            hostIds.add(id);
          } else {
            socket.emit('error-message', { message: 'Access code not recognized. Joining as a guest.' });
          }
        }

        const user = { id, name, color, socketId: socket.id, role };
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

        joinSocketToMemberships(socket, id);

        let startRoom = preferredRoom;
        if (!roomsMeta.has(startRoom) || !canAccess(startRoom, id)) startRoom = 'General';

        socket.emit('joined', {
          id: user.id,
          name: user.name,
          color: user.color,
          role: user.role,
          room: startRoom,
        });
        enterRoom(socket, user, startRoom);
        emitStateAll();
        if (!wasPending && !existing) {
          io.emit('presence', { type: 'join', user: publicUser(user), online: online.size, session: sessionInfo() });
        }
        if (role === 'host') flushPendingHelp(user);
      } catch (e) {
        socket.emit('error-message', { message: 'Could not join the live session' });
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
      socket.emit('joined', { id: user.id, name: user.name, color: user.color, role: user.role, room: socket.data.room });
      emitStateAll();
    });

    socket.on('create-room', (incoming) => {
      const user = sockets.get(socket.id);
      if (!user) return socket.emit('error-message', { message: 'Join first' });
      if (!isHost(user)) return socket.emit('error-message', { message: 'Only the host can create rooms' });
      if (!rateLimit(socket, 'room', 6, 15_000)) return socket.emit('error-message', { message: 'Too many rooms created' });
      const payload = incoming && typeof incoming === 'object' ? incoming : { name: incoming };
      const name = sanitizeRoom(payload.name);
      if (!name || name.toLowerCase() === 'general') {
        return socket.emit('error-message', { message: 'Enter a valid room name' });
      }
      const existing = roomsMeta.get(name);
      if (existing?.type === 'dm') return socket.emit('error-message', { message: 'Room not available' });
      ensurePublicRoom(name, user.id, sanitizeText(payload.description || '').slice(0, 140));
      persistSoon();
      for (const s of io.sockets.sockets.values()) s.join(name);
      enterRoom(socket, user, name);
      emitStateAll();
    });

    socket.on('join-room', (roomName) => {
      const user = sockets.get(socket.id);
      if (!user) return;
      // DM names are derived from two opaque user IDs and are deliberately longer
      // than public channel names. Sanitizing them with MAX_ROOM truncated valid
      // help DMs (and made the advertised room impossible to rejoin).
      const room = typeof roomName === 'string' ? roomName : '';
      if (!room || room.length > 200) return;
      const meta = roomsMeta.get(room);
      if (!meta) {
        socket.emit('error-message', { message: 'Room not found' });
        return;
      }
      if (!canAccess(room, user.id)) {
        socket.emit('error-message', { message: 'Room not found' });
        return;
      }
      enterRoom(socket, user, room);
      emitStateAll();
    });

    socket.on('create-dm', (peerId) => {
      const user = sockets.get(socket.id);
      if (!user) return;
      const b = String(peerId || '');
      if (!validId(b) || b === user.id) return;
      if (!rateLimit(socket, 'dm', 10, 10_000)) return;
      const room = openDm(user, b);
      enterRoom(socket, user, room);
      emitStateAll();
    });

    socket.on('request-help', (incoming) => {
      const user = sockets.get(socket.id);
      if (!user) return socket.emit('error-message', { message: 'Join first' });
      if (!rateLimit(socket, 'help', 6, 60_000)) return socket.emit('error-message', { message: 'Please wait before sending another help request' });
      const payload = incoming && typeof incoming === 'object' ? incoming : {};
      const item = {
        userId: user.id,
        name: user.name,
        title: sanitizeText(payload.title || 'Help request').slice(0, 80) || 'Help request',
        description: sanitizeText(payload.description || '').slice(0, 1500),
        category: HELP_CATEGORIES.has(payload.category) ? payload.category : 'General',
        attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
      };
      const host = firstHost();
      if (!host) {
        pendingHelp.push(item);
        socket.emit('help-queued', { message: 'No host is online yet. Your request is waiting.' });
        return;
      }
      const room = openDm(user, host.id, { help: true, helpTitle: item.title, peerName: host.name });
      const msg = helpMessage(user, room, item);
      pushMessage(room, msg);
      io.to(room).emit('message', msg);
      enterRoom(socket, user, room);
      emitStateAll();
    });

    socket.on('message', (incoming) => {
      const user = sockets.get(socket.id);
      if (!user) return socket.emit('error-message', { message: 'Join first' });
      if (!rateLimit(socket, 'msg', 20, 8_000)) return socket.emit('error-message', { message: 'You are sending messages too quickly' });

      let text = '';
      let room = socket.data.room || 'General';
      let replyTo = null;
      let attachments = [];
      if (typeof incoming === 'string') text = incoming;
      else if (incoming && typeof incoming === 'object') {
        text = incoming.text || '';
        if (incoming.room) room = String(incoming.room);
        if (incoming.replyTo && incoming.replyTo.id) {
          const src = messages.get(incoming.replyTo.id);
          if (src && src.room === room) {
            replyTo = { id: src.id, text: String(src.text || '').slice(0, 160), userName: src.user?.name || 'User' };
          }
        }
        if (Array.isArray(incoming.attachments)) {
          attachments = incoming.attachments.slice(0, 4).map(normalizeAttachment).filter(Boolean);
        }
      }
      text = sanitizeText(text).trim();
      if (!text && !attachments.length) return;
      if (!canAccess(room, user.id)) return socket.emit('error-message', { message: 'Cannot send to this room' });

      const meta = roomsMeta.get(room) || {};
      const payload = {
        id: `${user.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        user: { id: user.id, name: user.name, color: user.color, role: user.role || 'user' },
        text,
        ts: Date.now(),
        reactions: {},
        userReactions: {},
        room,
        replyTo,
        attachments,
        type: 'text',
        delivered: meta.type === 'dm' ? !!(meta.members || []).some((id) => id !== user.id && online.has(id)) : true,
        readBy: [],
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
      const owner = !!(msg.user && String(msg.user.id) === String(user.id));
      if (!owner && !isHost(user)) {
        socket.emit('error-message', { message: 'Only the host can delete other people’s messages' });
        return;
      }
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
      if (!rateLimit(socket, 'typing', 20, 4_000)) return;
      emitToViewers(room, 'typing', { room, user: publicUser(user) }, socket.id);
    });

    socket.on('stop-typing', () => {
      const user = sockets.get(socket.id);
      const room = socket.data.room;
      if (!user || !room) return;
      emitToViewers(room, 'stop-typing', { room, user: publicUser(user) }, socket.id);
    });

    socket.on('mark-read', (roomName) => {
      const user = sockets.get(socket.id);
      if (!user) return;
      const room = String(roomName || socket.data.room || '');
      if (room && canAccess(room, user.id)) markRead(room, user.id);
    });

    function dropSocket(sock, immediate) {
      const user = sockets.get(sock.id);
      sockets.delete(sock.id);
      if (!user) return;
      if (sock.data.room) {
        emitToViewers(sock.data.room, 'stop-typing', { room: sock.data.room, user: publicUser(user) }, sock.id);
      }
      sock.data.room = null;
      const entry = online.get(user.id);
      if (entry) {
        entry.socketIds.delete(sock.id);
        if (entry.socketIds.size > 0) return;
      }
      const finish = () => {
        online.delete(user.id);
        emitStateAll();
        io.emit('presence', {
          type: 'leave',
          user: { id: user.id, name: user.name, color: user.color, role: user.role },
          online: online.size,
          session: sessionInfo(),
        });
      };
      if (disconnectTimers.has(user.id)) {
        clearTimeout(disconnectTimers.get(user.id));
        disconnectTimers.delete(user.id);
      }
      if (immediate) finish();
      else {
        disconnectTimers.set(
          user.id,
          setTimeout(() => {
            disconnectTimers.delete(user.id);
            const still = online.get(user.id);
            if (still && still.socketIds.size > 0) return;
            finish();
          }, 3500)
        );
      }
    }

    socket.on('leave', () => {
      dropSocket(socket, true);
      socket.emit('left');
    });

    socket.on('disconnect', () => {
      dropSocket(socket, false);
    });
  });

  function close() {
    clearTimeout(stateTimer);
    clearTimeout(persistTimer);
    for (const t of disconnectTimers.values()) clearTimeout(t);
    disconnectTimers.clear();
    return new Promise((resolve) => {
      io.close(() => {
        server.close(() => resolve());
      });
    });
  }

  return {
    app,
    server,
    io,
    close,
    internals: { rooms, roomsMeta, online, hostIds, pendingHelp, messages },
  };
}

function safeExt(original, mime) {
  const allowed = MIME_EXT[mime] || [];
  const ext = path.extname(original || '').toLowerCase();
  if (allowed.includes(ext)) return ext;
  return allowed[0] || '';
}

function hitOk(map, key, max, windowMs) {
  const now = Date.now();
  const bucket = map.get(key) || { n: 0, t: now };
  if (now - bucket.t > windowMs) {
    bucket.n = 0;
    bucket.t = now;
  }
  bucket.n += 1;
  map.set(key, bucket);
  return bucket.n <= max;
}

function start(opts = {}) {
  const runtime = createRuntime(opts);
  const port = opts.port != null ? opts.port : PORT;
  const host = opts.host || HOST;
  return new Promise((resolve) => {
    runtime.server.listen(port, host, () => {
      const addr = runtime.server.address();
      runtime.port = addr && addr.port;
      resolve(runtime);
    });
  });
}

if (require.main === module) {
  start().then((runtime) => {
    console.log(`Realtime Agent listening on http://${HOST}:${runtime.port}`);
  });
  const shutdown = () => process.exit(0);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createRuntime, start };
