const socket = io();

const usersEl = document.getElementById('users');
const messagesEl = document.getElementById('messages');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const msgForm = document.getElementById('msgForm');
const msgInput = document.getElementById('msgInput');

let joined = false;
let me = null;

// Request Notification permission early (graceful if blocked)
if ('Notification' in window) {
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function renderUsers(list){
  usersEl.innerHTML = '';
  list.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u.name || u.id;
    usersEl.appendChild(li);
  });
}

function addMessage({user, text, ts}){
  const div = document.createElement('div');
  div.className = 'msg';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${user.name || 'Anonymous'} • ${new Date(ts).toLocaleTimeString()}`;
  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(meta);
  div.appendChild(body);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

joinBtn.addEventListener('click', () => {
  if (joined) return;
  me = { id: null, name: nameInput.value || 'Anonymous' };
  socket.emit('join', me);
  joined = true;
  joinBtn.disabled = true;
});

msgForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('message', text);
  msgInput.value = '';
});

socket.on('users-list', (list) => {
  // list is an array of user objects
  renderUsers(list);
});

socket.on('user-joined', (user) => {
  // Show system message and desktop notification
  const systemMsg = { user: { name: 'System' }, text: `${user.name || 'A user'} joined` , ts: Date.now() };
  addMessage(systemMsg);
  try {
    if (Notification && Notification.permission === 'granted') {
      new Notification('User joined', { body: `${user.name || 'A user'} joined the chat` });
    }
  } catch (e) {
    // ignore notification errors in older browsers
  }
});

socket.on('user-left', (user) => {
  const systemMsg = { user: { name: 'System' }, text: `${user?.name || 'A user'} left`, ts: Date.now() };
  addMessage(systemMsg);
  try {
    if (Notification && Notification.permission === 'granted') {
      new Notification('User left', { body: `${user?.name || 'A user'} left the chat` });
    }
  } catch (e) {
    // ignore
  }
});

// Ack from server with full user object (includes assigned id)
socket.on('joined', (user) => {
  if (me) {
    me.id = user.id;
  }
});

socket.on('message', (payload) => {
  addMessage(payload);
});
