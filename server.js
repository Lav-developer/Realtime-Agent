const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Allow configuring the frontend origin for CORS (useful when frontend is deployed separately,
// e.g. to Vercel). Set CORS_ORIGIN to the deployed site URL (https://your-site.vercel.app).
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(express.static(path.join(__dirname, 'public')));
app.use(cors({ origin: CORS_ORIGIN }));

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;


// Basic in-memory storage for connected users (for demo only)
const users = new Map();

io.on('connection', (socket) => {
  console.log('a user connected', socket.id);

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
  });

  socket.on('message', (msg) => {
    const user = users.get(socket.id) || { id: socket.id, name: 'Anonymous' };
    const payload = { user, text: msg, ts: Date.now() };
    io.emit('message', payload);
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
