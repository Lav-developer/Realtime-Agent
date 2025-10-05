const socket = io();

const usersEl = document.getElementById('users');
const messagesEl = document.getElementById('messages');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const msgForm = document.getElementById('msgForm');
const msgInput = document.getElementById('msgInput');

let joined = false;
let me = null;

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
  renderUsers(list);
});

socket.on('user-joined', (user) => {
  renderUsers(document.querySelectorAll('#users li') ? Array.from(document.querySelectorAll('#users li')).map(li => ({name:li.textContent})) : []);
  const systemMsg = { user: { name: 'System' }, text: `${user.name || 'A user'} joined` , ts: Date.now() };
  addMessage(systemMsg);
});

socket.on('user-left', (user) => {
  const systemMsg = { user: { name: 'System' }, text: `${user?.name || 'A user'} left`, ts: Date.now() };
  addMessage(systemMsg);
});

socket.on('message', (payload) => {
  addMessage(payload);
});
