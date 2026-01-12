const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Allow configuring the frontend origin for CORS (useful when frontend is deployed separately,
// e.g. to Vercel). Set CORS_ORIGIN to the deployed site URL (https://your-site.vercel.app).
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({ origin: CORS_ORIGIN }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads dir exists
try { if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true }); } catch(e){}

// Multer setup: limit files to 5MB by default
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Upload endpoint (single file field: `file`)
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Move/rename file to preserve original name safely if desired (keep dest filename)
    const url = `/uploads/${req.file.filename}`;
    return res.json({ url, name: req.file.originalname, size: req.file.size, type: req.file.mimetype });
  } catch (e) {
    return res.status(500).json({ error: 'Upload failed' });
  }
});

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;


// Basic in-memory storage for connected users (for demo only)
const users = new Map();
// Store recent messages and their reactions (in-memory, demo only)
const messages = new Map();

// Simple rooms store (in-memory) with optional disk persistence via `lib/store.js`
let rooms = new Map();
// room metadata (type: 'public'|'dm', members: [ids])
let roomsMeta = new Map();
try {
  const store = require(path.join(__dirname, 'lib', 'store'));
  const persisted = store.loadRooms();
  if (persisted && typeof persisted === 'object') {
    const persistedRooms = persisted.rooms || {};
    const persistedMeta = persisted.meta || {};
    Object.keys(persistedRooms).forEach(r => rooms.set(r, persistedRooms[r] || []));
    Object.keys(persistedMeta).forEach(r => roomsMeta.set(r, persistedMeta[r] || {}));
  }
} catch (e) {
  // if persistence isn't available, continue with in-memory only
}

// Ensure at least a default room exists
if (!rooms.has('Lobby')) {
  rooms.set('Lobby', []);
  roomsMeta.set('Lobby', { type: 'public' });
}

io.on('connection', (socket) => {
  console.log('a user connected', socket.id);

  // send current public rooms list to connecting client (include per-room unread counts for this socket)
  try {
    const publicRooms = Array.from(roomsMeta.keys()).filter(r => (roomsMeta.get(r) || {}).type !== 'dm');
    const list = publicRooms.map(r => {
      const msgs = rooms.get(r) || [];
      const lastTs = msgs.length ? msgs[msgs.length - 1].ts : 0;
      const lastSeen = ((roomsMeta.get(r) || {}).lastSeen || {})[socket.id] || 0;
      const unread = lastTs > lastSeen ? msgs.filter(m => m.ts > lastSeen).length : 0;
      return { name: r, unread };
    });
    socket.emit('rooms-list', list);
  } catch(e){}

  socket.on('join', (user) => {
    // Normalize user shape and store using socket.id as source of truth
    const u = Object.assign({ id: socket.id, name: 'Anonymous' }, user || {});
    users.set(socket.id, u);

    // Notify other clients a user joined
    socket.broadcast.emit('user-joined', u);

    // Emit updated users list to ALL clients so everyone has a consistent view
    io.emit('users-list', Array.from(users.values()));

    // Acknowledge the joining socket with its assigned id and full user object
    io.to(socket.id).emit('joined', u);

    // Auto-join the default room (Lobby) for compatibility/demo convenience
    const defaultRoom = 'Lobby';
    socket.join(defaultRoom);
    socket.currentRoom = defaultRoom;
    // send room-joined ack with recent history
    const history = (rooms.get(defaultRoom) || []).slice(-200);
    socket.emit('room-joined', { room: defaultRoom, messages: history });
  });

  // Accept messages as either a string (backwards compatible) or an object { text, room }
  socket.on('message', (incoming) => {
    const user = users.get(socket.id) || { id: socket.id, name: 'Anonymous' };
    let text = '';
    let room = socket.currentRoom || 'Lobby';
    if (typeof incoming === 'string') text = incoming;
    else if (incoming && typeof incoming === 'object') {
      text = String(incoming.text || '');
      if (incoming.room) room = incoming.room;
    }
    const id = `${socket.id}-${Date.now()}`;
    const payload = { id, user, text, ts: Date.now(), reactions: {}, userReactions: {}, room };
    // store message for reaction updates
    messages.set(id, payload);
    // persist into room history (keep last 1000 per room)
    try {
      const arr = rooms.get(room) || [];
      arr.push(payload);
      while (arr.length > 1000) arr.shift();
      rooms.set(room, arr);
      // attempt to persist via lib/store.js when available (persist both rooms and meta)
      const store = require(path.join(__dirname, 'lib', 'store'));
      if (store && store.saveRooms) store.saveRooms({ rooms: Object.fromEntries(rooms), meta: Object.fromEntries(roomsMeta) });
    } catch (e) {
      // ignore persistence errors
    }

    // emit message only to sockets in the room
    io.to(room).emit('message', payload);
  });

  // join a named room (create if missing) — respects DM privacy
  socket.on('join-room', (roomName) => {
    try {
      const room = String(roomName || 'Lobby');
      const prev = socket.currentRoom;
      // If the room exists and is a DM, deny join unless this socket is a member
      const meta = roomsMeta.get(room) || { type: 'public' };
      if (meta.type === 'dm') {
        const members = meta.members || [];
        if (!members.includes(socket.id)) {
          // Deny join — do not reveal existence
          socket.emit('error', { message: 'Room not found' });
          return;
        }
      }
      if (prev && prev !== room) socket.leave(prev);
      socket.join(room);
      socket.currentRoom = room;
      if (!rooms.has(room)) rooms.set(room, []);
      // notify this socket with recent messages
      const history = (rooms.get(room) || []).slice(-200);
      socket.emit('room-joined', { room, messages: history });
      // notify others in the room that a user joined (room-scoped)
      const u = users.get(socket.id) || { id: socket.id, name: 'Anonymous' };
      socket.to(room).emit('user-joined', u);
      // broadcast updated public rooms list
      const publicRooms = Array.from(roomsMeta.keys()).filter(r => (roomsMeta.get(r) || {}).type !== 'dm');
      io.emit('rooms-list', publicRooms);
    } catch (e) {}
  });

  // create a direct-message room between this socket and peerId; server enforces membership
  socket.on('create-dm', (peerId) => {
    try {
      const a = String(socket.id);
      const b = String(peerId || '');
      if (!b) return;
      // deterministic name
      const ids = [a, b].sort();
      const room = `dm-${ids.join('-')}`;

      // create room storage and meta
      if (!rooms.has(room)) rooms.set(room, []);
      roomsMeta.set(room, { type: 'dm', members: [a, b] });

      // persist meta
      try {
        const store = require(path.join(__dirname, 'lib', 'store'));
        if (store && store.saveRooms) store.saveRooms({ rooms: Object.fromEntries(rooms), meta: Object.fromEntries(roomsMeta) });
      } catch (e) {}

      // add this socket to room
      const prev = socket.currentRoom;
      if (prev && prev !== room) socket.leave(prev);
      socket.join(room);
      socket.currentRoom = room;
      const history = (rooms.get(room) || []).slice(-200);
      socket.emit('room-joined', { room, messages: history });

      // If peer is connected, add them to room and notify
      const peerSocket = io.sockets.sockets.get(b);
      if (peerSocket) {
        peerSocket.join(room);
        peerSocket.currentRoom = room;
        peerSocket.emit('room-joined', { room, messages: history });
        // notify peer that they were invited to a DM
        peerSocket.emit('dm-invite', { room, from: users.get(socket.id) || { id: socket.id } });
      }
      // do not include DM rooms in global rooms-list; instead we could emit a dm-list if desired
    } catch (e) {}
  });

  // Reactions: toggle user's reaction on a message for a given emoji
  socket.on('reaction', ({ messageId, emoji }) => {
    try {
      const msg = messages.get(messageId);
      if (!msg) return;
      if (!msg.reactions) msg.reactions = {};
      if (!msg.userReactions) msg.userReactions = {};

      const prev = msg.userReactions[socket.id];
      // If the user clicked the same emoji, toggle off
      if (prev === emoji) {
        // remove from that emoji list
        const setPrev = new Set(msg.reactions[emoji] || []);
        setPrev.delete(socket.id);
        if (setPrev.size === 0) delete msg.reactions[emoji]; else msg.reactions[emoji] = Array.from(setPrev);
        delete msg.userReactions[socket.id];
      } else {
        // remove from previous reaction (if any)
        if (prev) {
          const setPrev = new Set(msg.reactions[prev] || []);
          setPrev.delete(socket.id);
          if (setPrev.size === 0) delete msg.reactions[prev]; else msg.reactions[prev] = Array.from(setPrev);
        }
        // add to new emoji list
        if (emoji) {
          const setNew = new Set(msg.reactions[emoji] || []);
          setNew.add(socket.id);
          msg.reactions[emoji] = Array.from(setNew);
          msg.userReactions[socket.id] = emoji;
        }
      }

      // broadcast updated reactions for the message (full map)
      io.emit('reaction', { messageId, reactions: msg.reactions || {}, userReactions: msg.userReactions || {} });
    } catch (e) {
      // ignore malformed reaction payloads
    }
  });

  // Edit a message (only owner may edit)
  socket.on('edit-message', ({ messageId, text }) => {
    try {
      const msg = messages.get(messageId);
      if (!msg) return;
      // only the original author may edit
      if (!msg.user || String(msg.user.id) !== String(socket.id)) return;
      msg.text = String(text || '');
      msg.edited = true;
      msg.editedTs = Date.now();
      // update room history
      try {
        const arr = rooms.get(msg.room) || [];
        for (let i = 0; i < arr.length; i++) if (arr[i].id === messageId) { arr[i] = msg; break; }
        rooms.set(msg.room, arr);
        const store = require(path.join(__dirname, 'lib', 'store'));
        if (store && store.saveRooms) store.saveRooms({ rooms: Object.fromEntries(rooms), meta: Object.fromEntries(roomsMeta) });
      } catch (e) {}
      // broadcast updated message to room
      io.to(msg.room).emit('message-updated', msg);
    } catch (e) {}
  });

  // Delete a message (only owner may delete)
  socket.on('delete-message', ({ messageId }) => {
    try {
      const msg = messages.get(messageId);
      if (!msg) return;
      if (!msg.user || String(msg.user.id) !== String(socket.id)) return;
      messages.delete(messageId);
      // remove from room history
      try {
        const arr = (rooms.get(msg.room) || []).filter(m => m.id !== messageId);
        rooms.set(msg.room, arr);
        const store = require(path.join(__dirname, 'lib', 'store'));
        if (store && store.saveRooms) store.saveRooms({ rooms: Object.fromEntries(rooms), meta: Object.fromEntries(roomsMeta) });
      } catch (e) {}
      // broadcast deletion
      io.to(msg.room).emit('message-deleted', { messageId });
    } catch (e) {}
  });

  // Typing indicators (transient)
  socket.on('typing', () => {
    const user = users.get(socket.id) || { id: socket.id, name: 'Anonymous' };
    socket.broadcast.emit('typing', user);
  });

  socket.on('stop-typing', () => {
    socket.broadcast.emit('stop-typing');
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    users.delete(socket.id);
    socket.broadcast.emit('user-left', user);
    console.log('user disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
