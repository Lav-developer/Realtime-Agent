const socket = io();

const usersEl = document.getElementById('users');
const messagesEl = document.getElementById('messages');
const nameInput = document.getElementById('name');
const joinBtn = document.getElementById('joinBtn');
const msgForm = document.getElementById('msgForm');
const msgInput = document.getElementById('msgInput');

const meNameEl = document.getElementById('meName');
const typingEl = document.getElementById('typing');
const toastContainer = document.getElementById('toast-container');
const unreadBadge = document.getElementById('unreadBadge');
const sysNotifToggle = document.getElementById('sysNotifToggle');

// Keep reference to current system desktop notification so we close it when a new one appears
let currentSystemNotification = null;
// Whether system desktop notifications (join/left) are enabled (persisted)
let sysNotifEnabled = true;
try {
  const saved = localStorage.getItem('sysNotifEnabled');
  if (saved !== null) sysNotifEnabled = saved === 'true';
} catch (e) {}
if (sysNotifToggle) {
  sysNotifToggle.checked = sysNotifEnabled;
  sysNotifToggle.addEventListener('change', (e) => {
    sysNotifEnabled = !!e.target.checked;
    try { localStorage.setItem('sysNotifEnabled', sysNotifEnabled ? 'true' : 'false'); } catch(e){}
    // if user disabled system notifications, close any active system notification and toast
    if (!sysNotifEnabled) {
      try { if (currentSystemNotification && currentSystemNotification.close) currentSystemNotification.close(); currentSystemNotification = null; } catch(e){}
      try { if (currentSystemToast) { currentSystemToast.remove(); currentSystemToast = null; } } catch(e){}
    } else {
      // if enabled and permission not granted, request it
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    }
  });
}

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
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = (u.name || u.id || 'U').slice(0,2).toUpperCase();
    li.appendChild(av);
    const span = document.createElement('span');
    span.textContent = u.name || u.id;
    if (u.id === me?.id) {
      span.style.fontWeight = '700';
      span.textContent += ' (you)';
    }
    li.appendChild(span);
    usersEl.appendChild(li);
  });
}

function addMessage({user, text, ts}){
  const isSystem = (user && user.name === 'System') || !user?.id;
  const row = document.createElement('div');
  row.className = 'msg-row';

  const div = document.createElement('div');
  div.className = 'msg';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${user?.name || 'System'} • ${new Date(ts).toLocaleTimeString()}`;
  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(meta);
  div.appendChild(body);

  if (isSystem) {
    // Centered compact system message: single-line 'Name joined • time'
    row.classList.add('system');
    row.style.justifyContent = 'center';
    const compact = document.createElement('div');
    compact.className = 'system-compact';
    // try to extract action text (joined/left) from provided text if possible
    const actionText = text || '';
    const time = new Date(ts).toLocaleTimeString();
    // If the system 'text' already contains the user's name and action (e.g. 'Lav joined'),
    // show it directly with timestamp. Otherwise, fall back to user.name + actionText.
    compact.textContent = `${actionText} • ${time}`.trim();
    row.appendChild(compact);
  } else {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = (user?.name || user?.id || 'U').slice(0,2).toUpperCase();

    // Mark message as 'own' only if both sides have a defined id and they match
    if (user?.id && me?.id && user.id === me.id) {
      row.classList.add('own');
      div.classList.add('own');
      meta.classList.add('own');
    }

    row.appendChild(av);
    row.appendChild(div);
  }

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

joinBtn.addEventListener('click', () => {
  if (joined) return;
  // set local id immediately from socket.id so messages are rendered as 'own'
  me = { id: socket.id || null, name: nameInput.value || 'Anonymous' };
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

// Typing indicator: emit 'typing' and 'stop-typing'
let typingTimeout = null;
msgInput.addEventListener('input', () => {
  socket.emit('typing');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('stop-typing'), 1200);
});

function showToast(text, timeout = 3000) {
  if (!toastContainer) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), timeout);
}

let currentSystemToast = null;
function showSystemToast(text, timeout = 2500) {
  if (!toastContainer) return;
  try {
    if (currentSystemToast) currentSystemToast.remove();
  } catch (e) {}
  const t = document.createElement('div');
  t.className = 'toast system-toast';
  t.textContent = text;
  toastContainer.appendChild(t);
  currentSystemToast = t;
  setTimeout(() => { try { t.remove(); if (currentSystemToast === t) currentSystemToast = null; } catch(e){} }, timeout);
}

// clear unread when returning to tab
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (unreadBadge) {
      unreadBadge.hidden = true;
      unreadBadge.textContent = '0';
    }
  }
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
    if (sysNotifEnabled && Notification && Notification.permission === 'granted') {
      // close previous system notification if present
      try { if (currentSystemNotification && currentSystemNotification.close) currentSystemNotification.close(); } catch(e){}
      currentSystemNotification = new Notification('User joined', { body: `${user.name || 'A user'} joined the chat` });
      // auto-close after a short duration to avoid lingering
      setTimeout(() => { try { currentSystemNotification && currentSystemNotification.close(); currentSystemNotification = null; } catch(e){} }, 3500);
    }
  } catch (e) {
    // ignore notification errors in older browsers
  }
  // show a short system toast replacing previous one (only if system toasts are allowed)
  if (sysNotifEnabled) showSystemToast(`${user.name || 'A user'} joined`);
});

socket.on('user-left', (user) => {
  const systemMsg = { user: { name: 'System' }, text: `${user?.name || 'A user'} left`, ts: Date.now() };
  addMessage(systemMsg);
  try {
    if (sysNotifEnabled && Notification && Notification.permission === 'granted') {
      try { if (currentSystemNotification && currentSystemNotification.close) currentSystemNotification.close(); } catch(e){}
      currentSystemNotification = new Notification('User left', { body: `${user?.name || 'A user'} left the chat` });
      setTimeout(() => { try { currentSystemNotification && currentSystemNotification.close(); currentSystemNotification = null; } catch(e){} }, 3500);
    }
  } catch (e) {
    // ignore
  }
  if (sysNotifEnabled) showSystemToast(`${user?.name || 'A user'} left`);
});

// Ack from server with full user object (includes assigned id)
socket.on('joined', (user) => {
  if (me) {
    me.id = user.id;
    if (meNameEl) {
      meNameEl.textContent = me.name;
      meNameEl.hidden = false;
    }
    if (unreadBadge) {
      unreadBadge.hidden = true;
      unreadBadge.textContent = '0';
    }
  }
});

socket.on('message', (payload) => {
  addMessage(payload);
  try {
    // Skip notification for messages sent by this client (if we know our id)
    if (Notification && Notification.permission === 'granted' && payload?.user?.id !== me?.id) {
      const title = payload.user?.name ? `${payload.user.name} says:` : 'New message';
      new Notification(title, { body: payload.text });
    }
  } catch (e) {
    // ignore notification errors
  }

  // If document not visible, increase unread badge and show small toast
  if (document.hidden && unreadBadge) {
    const current = parseInt(unreadBadge.textContent || '0', 10) || 0;
    unreadBadge.textContent = current + 1;
    unreadBadge.hidden = false;
    showToast(`${payload.user?.name || 'Someone'}: ${payload.text}`);
  }
});

socket.on('typing', (user) => {
  if (typingEl) typingEl.textContent = `${user?.name || 'Someone'} is typing...`;
});

socket.on('stop-typing', () => {
  if (typingEl) typingEl.textContent = '';
});
