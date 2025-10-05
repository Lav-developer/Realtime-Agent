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
    users.set(socket.id, user || { id: socket.id, name: 'Anonymous' });
    socket.broadcast.emit('user-joined', users.get(socket.id));
    io.to(socket.id).emit('users-list', Array.from(users.values()));
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
