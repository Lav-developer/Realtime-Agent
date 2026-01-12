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
const roomsEl = document.getElementById('rooms');
const roomInput = document.getElementById('roomInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const currentRoomEl = document.getElementById('currentRoom');

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
let currentRoom = null;
// track recent touch interactions to avoid mouse emulation triggering hover
let isTouchInteraction = false;

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
    li.dataset.userid = u.id;
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

    // Direct message button
    if (u.id !== me?.id) {
      const btn = document.createElement('button');
      btn.className = 'dm-btn';
      btn.title = `Message ${u.name || u.id}`;
      btn.textContent = 'Msg';
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        startDirectMessage(u.id, u.name || u.id);
      });
      li.appendChild(btn);
      // also make clicking the row start DM for convenience
      li.addEventListener('click', () => startDirectMessage(u.id, u.name || u.id));
    }

    usersEl.appendChild(li);
  });
}

// Compute deterministic DM room name for two user ids
function dmRoomName(a, b){
  try {
    const ids = [String(a || ''), String(b || '')].sort();
    return `dm-${ids.join('-')}`;
  } catch (e) { return `dm-${String(a)}-${String(b)}`; }
}

function startDirectMessage(userId, userName){
  if (!userId) return;
  // ensure we have a local id for me
  const myId = me?.id || socket.id;
  // request server to create a private DM and invite the peer
  socket.emit('create-dm', userId);
  if (currentRoomEl) {
    currentRoomEl.textContent = `DM with ${userName || userId}`;
    currentRoomEl.hidden = false;
  }
}

function renderRooms(list){
  if (!roomsEl) return;
  roomsEl.innerHTML = '';
  (list || []).forEach(r => {
    const li = document.createElement('li');
    li.textContent = r;
    li.tabIndex = 0;
    if (r === currentRoom) li.classList.add('active');
    li.addEventListener('click', () => joinRoom(r));
    li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') joinRoom(r); });
    roomsEl.appendChild(li);
  });
}

function joinRoom(roomName){
  if (!roomName) return;
  socket.emit('join-room', String(roomName));
}

function addMessage({user, text, ts}){
  const isSystem = (user && user.name === 'System') || !user?.id;
  // messageId and reactions may be passed in payload; default to null
  const messageId = arguments[0].id || null;
  const reactions = arguments[0].reactions || {};
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

    // attach message id to row for later reaction updates
    if (messageId) row.dataset.messageId = messageId;

    // reactions container
    const reactionsWrap = document.createElement('div');
    reactionsWrap.className = 'reactions-wrap';
    // render initial reactions
    const reactionsEl = renderReactions(messageId, reactions);
    reactionsWrap.appendChild(reactionsEl);

    // reaction picker button (simple: hearts, thumbs up, laugh, and any emoji present in text)
    const picker = document.createElement('div');
    picker.className = 'reactions-picker';
    const btn = document.createElement('button');
    btn.className = 'reaction-btn';
    // use a non-emoji affordance (avoid static emoji shown on every message)
    btn.textContent = '⋯';
    btn.title = 'React';
    picker.appendChild(btn);

    const pickerMenu = document.createElement('div');
    pickerMenu.className = 'picker-menu';

    // default emojis
    const emojiList = ['👍','❤️','😂','👎','😮','😢'];
    // include any emoji found in message text
    const extraEmojis = extractEmojis(text);
    extraEmojis.forEach(e => { if (!emojiList.includes(e)) emojiList.push(e); });

    emojiList.forEach(e => {
      const ebtn = document.createElement('button');
      ebtn.className = 'reaction-emoji';
      ebtn.style.fontSize = '18px';
      ebtn.style.border = '0';
      ebtn.style.background = 'transparent';
      ebtn.style.cursor = 'pointer';
      ebtn.textContent = e;
      ebtn.addEventListener('click', () => {
        // send reaction to server
        socket.emit('reaction', { messageId, emoji: e });
        // close picker
        try { picker.classList.remove('show'); btn.setAttribute('aria-expanded', 'false'); } catch(e){}
      });
      pickerMenu.appendChild(ebtn);
    });

    // Accessibility attrs
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('type', 'button');
    btn.tabIndex = 0;

    // Interaction behavior:
    // - hover (desktop) shows picker
    // - long-press (touch) opens picker
    // - short tap toggles picker
    let longPressTimer = null;
    const longPressMs = 500;

    // show picker when hovering the entire message row on desktop
    row.addEventListener('mouseenter', () => {
      if (isTouchInteraction) return;
      picker.classList.add('show');
      btn.setAttribute('aria-expanded', 'true');
    });
    row.addEventListener('mouseleave', () => {
      if (isTouchInteraction) return;
      picker.classList.remove('show');
      btn.setAttribute('aria-expanded', 'false');
    });

    // Touch: long-press to open, short tap toggles
    // long-press on the message row for touch devices
    row.addEventListener('touchstart', (ev) => {
      isTouchInteraction = true;
      longPressTimer = setTimeout(() => {
        picker.classList.add('show');
        btn.setAttribute('aria-expanded', 'true');
        longPressTimer = null;
      }, longPressMs);
    }, { passive: true });

    row.addEventListener('touchend', (ev) => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        // treat as tap -> toggle
        if (picker.classList.contains('show')) {
          picker.classList.remove('show');
          btn.setAttribute('aria-expanded', 'false');
        } else {
          picker.classList.add('show');
          btn.setAttribute('aria-expanded', 'true');
        }
      }
      // avoid immediate mouse emulation
      setTimeout(() => { isTouchInteraction = false; }, 700);
    }, { passive: true });

    row.addEventListener('touchmove', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }, { passive: true });
    row.addEventListener('touchcancel', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } });

    // Click fallback for mouse/keyboard (ignore if touch just happened)
    btn.addEventListener('click', (ev) => {
      if (isTouchInteraction) return;
      ev.stopPropagation();
      if (picker.classList.contains('show')) {
        picker.classList.remove('show');
        btn.setAttribute('aria-expanded', 'false');
      } else {
        picker.classList.add('show');
        btn.setAttribute('aria-expanded', 'true');
      }
    });

    // keyboard support
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        if (picker.classList.contains('show')) {
          picker.classList.remove('show');
          btn.setAttribute('aria-expanded', 'false');
        } else {
          picker.classList.add('show');
          btn.setAttribute('aria-expanded', 'true');
        }
      }
    });

    picker.appendChild(pickerMenu);

    div.appendChild(reactionsWrap);
    div.appendChild(picker);

    // message controls (edit/delete) for message owner
    if (messageId && user?.id && me?.id && user.id === me.id) {
      const controls = document.createElement('div');
      controls.className = 'msg-controls';
      const editBtn = document.createElement('button');
      editBtn.className = 'edit-btn';
      editBtn.textContent = 'Edit';
      const delBtn = document.createElement('button');
      delBtn.className = 'del-btn';
      delBtn.textContent = 'Delete';

      editBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // replace body with an input for editing
        const input = document.createElement('input');
        input.type = 'text';
        input.value = body.textContent || '';
        input.className = 'edit-input';
        body.innerHTML = '';
        body.appendChild(input);
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            const newText = input.value.trim();
            socket.emit('edit-message', { messageId, text: newText });
          } else if (e.key === 'Escape') {
            // cancel: restore original text
            body.textContent = input.value;
          }
        });
        // blur -> submit edit
        input.addEventListener('blur', () => {
          const newText = input.value.trim();
          socket.emit('edit-message', { messageId, text: newText });
        });
      });

      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirm('Delete this message?')) return;
        socket.emit('delete-message', { messageId });
      });

      controls.appendChild(editBtn);
      controls.appendChild(delBtn);
      div.appendChild(controls);
    }
  }

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

  // Global click handler to close any open picker menus (added once)
  document.addEventListener('click', () => {
    // close any open pickers by removing the 'show' class
    const open = document.querySelectorAll('.reactions-picker.show');
    open.forEach(p => { try { p.classList.remove('show'); const b = p.querySelector('.reaction-btn'); if (b) b.setAttribute('aria-expanded', 'false'); } catch(e){} });
  });

// Render reactions element for a message id and reaction map
function renderReactions(messageId, reactions){
  const wrap = document.createElement('div');
  wrap.className = 'reactions';
  Object.keys(reactions || {}).forEach(emoji => {
    const users = reactions[emoji] || [];
    const el = document.createElement('div');
    el.className = 'reaction';
    if (users.includes(me?.id)) el.classList.add('you');
    const spanEmoji = document.createElement('span');
    spanEmoji.textContent = emoji;
    const spanCount = document.createElement('span');
    spanCount.className = 'count';
    spanCount.textContent = users.length || 0;
    el.appendChild(spanEmoji);
    el.appendChild(spanCount);
    // clicking reaction toggles for this user
    el.addEventListener('click', () => socket.emit('reaction', { messageId, emoji }));
    wrap.appendChild(el);
  });
  return wrap;
}

// Utility: extract distinct emoji characters from text
function extractEmojis(text){
  if (!text) return [];
  // simple emoji regex to capture most emojis (covers multibyte sequences)
  const emojiRegex = /(?: -|\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;
  // fallback: match common emoji ranges
  const fallback = /[\u231A-\u3299\uD83C-\uDBFF\uDC00-\uDFFF]/g;
  const matches = (text.match(fallback) || []).filter(Boolean);
  // dedupe
  return Array.from(new Set(matches)).slice(0,6);
}

joinBtn.addEventListener('click', () => {
  if (joined) return;
  // set local id immediately from socket.id so messages are rendered as 'own'
  me = { id: socket.id || null, name: nameInput.value || 'Anonymous' };
  socket.emit('join', me);
  joined = true;
  joinBtn.disabled = true;
  // mark UI as joined so CSS can hide join inputs and show compact name
  try { document.body.classList.add('joined'); } catch (e) {}
});

if (createRoomBtn) {
  createRoomBtn.addEventListener('click', () => {
    const r = (roomInput && roomInput.value || '').trim();
    if (!r) return;
    joinRoom(r);
    if (roomInput) roomInput.value = '';
  });
}
if (roomInput) {
  roomInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); createRoomBtn && createRoomBtn.click(); } });
}

msgForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('message', { text, room: currentRoom || 'Lobby' });
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

socket.on('rooms-list', (list) => {
  renderRooms(list || []);
  // auto-join first room if none selected
  if (!currentRoom && Array.isArray(list) && list.length) joinRoom(list[0]);
});

socket.on('dm-invite', ({ room, from }) => {
  // simple notification UI for incoming DM invite
  showSystemToast(`${from?.name || 'Someone'} started a DM`);
  // optionally auto-join the DM (server already joined peer if they were online)
  // we request join-room which will check membership
  joinRoom(room);
});

socket.on('room-joined', ({ room, messages }) => {
  try { currentRoom = room; } catch(e){}
  if (currentRoomEl) {
    currentRoomEl.textContent = `Room: ${room}`;
    currentRoomEl.hidden = false;
  }
  // mark active room in rooms list
  const items = document.querySelectorAll('#rooms li');
  items.forEach(i => i.classList.toggle('active', i.textContent === room));
  // clear current messages and render room history
  if (messages && Array.isArray(messages)) {
    messagesEl.innerHTML = '';
    messages.forEach(m => addMessage(m));
  }
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
    try { document.body.classList.add('joined'); } catch(e){}
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

// handle reaction broadcasts from server
socket.on('reaction', (payload) => {
  // payload now contains full reactions map for the message
  if (!payload || !payload.messageId) return;
  const { messageId, reactions = {} } = payload;
  const row = messagesEl.querySelector(`[data-message-id="${messageId}"]`);
  if (!row) return;
  const reactionsWrap = row.querySelector('.reactions');
  if (!reactionsWrap) return;
  // clear existing reactions and re-render horizontally
  reactionsWrap.innerHTML = '';
  Object.keys(reactions).forEach(emojiKey => {
    const usersList = reactions[emojiKey] || [];
    const el = document.createElement('div');
    el.className = 'reaction';
    if (usersList.includes(me?.id)) el.classList.add('you');
    const spanEmoji = document.createElement('span');
    spanEmoji.textContent = emojiKey;
    const spanCount = document.createElement('span');
    spanCount.className = 'count';
    spanCount.textContent = usersList.length || 0;
    el.appendChild(spanEmoji);
    el.appendChild(spanCount);
    el.addEventListener('click', () => socket.emit('reaction', { messageId, emoji: emojiKey }));
    reactionsWrap.appendChild(el);
  });
});

// handle message updates (edit)
socket.on('message-updated', (msg) => {
  if (!msg || !msg.id) return;
  const row = messagesEl.querySelector(`[data-message-id="${msg.id}"]`);
  if (!row) return;
  const body = row.querySelector('.msg > div:nth-child(2)');
  if (body) {
    body.textContent = msg.text || '';
    // append edited marker
    let meta = row.querySelector('.meta');
    if (meta && !meta.querySelector('.edited')) {
      const s = document.createElement('span');
      s.className = 'edited';
      s.textContent = ' (edited)';
      s.style.marginLeft = '8px';
      s.style.fontSize = '11px';
      meta.appendChild(s);
    }
  }
});

// handle message deletions
socket.on('message-deleted', ({ messageId }) => {
  if (!messageId) return;
  const row = messagesEl.querySelector(`[data-message-id="${messageId}"]`);
  if (!row) return;
  const body = row.querySelector('.msg > div:nth-child(2)');
  if (body) {
    body.textContent = '[message deleted]';
    row.classList.add('deleted');
    // remove controls if present
    const controls = row.querySelector('.msg-controls'); if (controls) controls.remove();
  }
});
