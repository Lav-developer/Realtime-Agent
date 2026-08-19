(() => {
  const PALETTE = ['#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f43f5e', '#06b6d4'];
  const EMOJIS = ['😀','😁','😂','😊','😍','🤩','😉','😎','🤔','🙌','👍','👎','❤️','🔥','🎉','😮','😢','😡','✨','✅','🚀','👀','💯','🤝'];
  const QUICK_REACT = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

  const $ = (id) => document.getElementById(id);
  const gate = $('gate');
  const app = $('app');
  const roomsEl = $('rooms');
  const dmsEl = $('dms');
  const usersEl = $('users');
  const messagesEl = $('messages');
  const typingEl = $('typing');
  const toastRoot = $('toast-container');
  const unreadBadge = $('unreadBadge');
  const roomTitle = $('roomTitle');
  const roomSub = $('roomSub');
  const roomHash = $('roomHash');
  const onlineLabel = $('onlineLabel');
  const msgInput = $('msgInput');
  const sendBtn = $('sendBtn');
  const composer = $('composer');
  const navSearch = $('navSearch');
  const searchBar = $('searchBar');
  const msgSearch = $('msgSearch');
  const searchMeta = $('searchMeta');
  const jumpLatest = $('jumpLatest');
  const replyBar = $('replyBar');
  const attachPreview = $('attachPreview');
  const fileInput = $('fileInput');
  const emojiPopover = $('emojiPopover');
  const connBanner = $('connBanner');
  const sidebar = $('sidebar');
  const sidebarBackdrop = $('sidebarBackdrop');

  const socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 600 });

  const state = {
    me: null,
    joined: false,
    room: null,
    roomMeta: null,
    roomLabel: '',
    public: [],
    dms: [],
    users: [],
    messages: [],
    replyTo: null,
    attachments: [],
    hiddenUnread: 0,
    filter: '',
    query: '',
    typers: new Map(),
    prefs: loadPrefs(),
    stickBottom: true,
    lastSeen: 0,
    newDividerId: null,
    session: { live: false, hostOnline: false, hosts: 0 },
    canCreateRoom: false,
    rtt: null,
    conn: 'connecting',
    left: false,
  };

  function loadPrefs() {
    const defaults = { notif: true, sound: true, presence: true, theme: 'dark', color: null };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem('agent.prefs') || '{}') };
    } catch {
      return defaults;
    }
  }

  function savePrefs() {
    try { localStorage.setItem('agent.prefs', JSON.stringify(state.prefs)); } catch {}
  }

  function uid() {
    try {
      let id = localStorage.getItem('agent.uid');
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || `u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem('agent.uid', id);
      }
      return id;
    } catch {
      return `u_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  function savedName() {
    try { return localStorage.getItem('agent.name') || ''; } catch { return ''; }
  }

  function colorFromId(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function initials(name) {
    const parts = String(name || 'U').trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0] || '').join('').toUpperCase() || 'U';
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function toast(text, ms = 2800) {
    if (!toastRoot) return;
    const t = el('div', { class: 'toast', text });
    toastRoot.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#eef1f6' : '#07080b');
    state.prefs.theme = theme === 'light' ? 'light' : 'dark';
    savePrefs();
  }

  applyTheme(state.prefs.theme);

  function beep() {
    if (!state.prefs.sound) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.04;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.07);
      setTimeout(() => ctx.close(), 200);
    } catch {}
  }

  function notify(title, body) {
    if (!state.prefs.notif || document.visibilityState === 'visible') return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, icon: 'favicon.svg' }); } catch {}
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yday = new Date();
    yday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function sameDay(a, b) {
    const da = new Date(a);
    const db = new Date(b);
    return da.toDateString() === db.toDateString();
  }

  function prettySize(n) {
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderInline(parent, line) {
    const names = state.users.map((u) => u.name).filter(Boolean).sort((a, b) => b.length - a.length);
    const mention = names.length ? names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : '';
    const rx = new RegExp(`(\`[^\`]+\`|\\*\\*[^*]+\\*\\*|https?:\\/\\/[^\\s<]+${mention ? `|@(?:${mention})` : ''})`, 'g');
    String(line).split(rx).forEach((part) => {
      if (!part) return;
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        parent.appendChild(el('code', { class: 'inline-code', text: part.slice(1, -1) }));
      } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
        parent.appendChild(el('strong', { text: part.slice(2, -2) }));
      } else if (/^https?:\/\//.test(part)) {
        parent.appendChild(el('a', { href: part, target: '_blank', rel: 'noopener noreferrer', text: part }));
      } else if (part.startsWith('@') && names.includes(part.slice(1))) {
        parent.appendChild(el('span', { class: 'mention', text: part }));
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    });
  }

  function renderRich(text) {
    const wrap = el('div', { class: 'body' });
    const chunks = String(text || '').split(/```([\s\S]*?)```/g);
    chunks.forEach((chunk, i) => {
      if (i % 2 === 1) {
        wrap.appendChild(el('pre', { class: 'pre-block' }, el('code', { text: chunk.replace(/^\n/, '') })));
        return;
      }
      chunk.split('\n').forEach((line, li) => {
        if (li) wrap.appendChild(el('br'));
        renderInline(wrap, line);
      });
    });
    return wrap;
  }

  function highlight(node, q) {
    if (!q) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walker.nextNode()) hits.push(walker.currentNode);
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    hits.forEach((textNode) => {
      const src = textNode.nodeValue;
      if (!rx.test(src)) return;
      rx.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      src.replace(rx, (m, offset) => {
        if (offset > last) frag.appendChild(document.createTextNode(src.slice(last, offset)));
        frag.appendChild(el('mark', { class: 'hit', text: m }));
        last = offset + m.length;
        return m;
      });
      if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
  });
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; });
  });

  function setSidebar(open) {
    sidebar.classList.toggle('open', open);
    sidebarBackdrop.hidden = !open;
  }

  $('menuBtn').addEventListener('click', () => setSidebar(true));
  $('sidebarClose').addEventListener('click', () => setSidebar(false));
  sidebarBackdrop.addEventListener('click', () => setSidebar(false));

  function avatar(name, color, size) {
    return el('span', {
      class: `avatar${size ? ` ${size}` : ''}`,
      text: initials(name),
      style: { background: color || colorFromId(name) },
    });
  }

  function matchesFilter(text) {
    const q = state.filter.trim().toLowerCase();
    if (!q) return true;
    return String(text || '').toLowerCase().includes(q);
  }

  function renderNav() {
    roomsEl.innerHTML = '';
    dmsEl.innerHTML = '';
    usersEl.innerHTML = '';

    const rooms = state.public.filter((r) => matchesFilter(r.name + ' ' + (r.description || '')));
    rooms.forEach((r) => {
      const active = state.room === r.name;
      const last = r.lastMessage ? `${r.lastMessage.userName}: ${r.lastMessage.text}` : r.description || 'No messages yet';
      const li = el(
        'li',
        { class: active ? 'active' : '', role: 'button', tabindex: '0', onclick: () => joinRoom(r.name), onkeydown: navKey(() => joinRoom(r.name)) },
        el('span', { class: 'hash', text: '#' }),
        el('span', { class: 'name' }, el('span', { text: r.name }), el('span', { class: 'preview', text: last })),
        el('span', { class: 'nav-meta' }, r.unread ? el('span', { class: 'unread-pill', text: String(r.unread) }) : null)
      );
      roomsEl.appendChild(li);
    });
    if (!rooms.length) roomsEl.appendChild(el('li', { style: { cursor: 'default', color: 'var(--faint)' }, text: 'No channels' }));

    const dms = state.dms.filter((d) => matchesFilter(d.peer?.name));
    dms.forEach((d) => {
      const active = state.room === d.room;
      const last = d.lastMessage ? d.lastMessage.text : 'Start a conversation';
      const li = el(
        'li',
        { class: active ? 'active' : '', role: 'button', tabindex: '0', onclick: () => joinRoom(d.room), onkeydown: navKey(() => joinRoom(d.room)) },
        avatar(d.peer.name, d.peer.color, 'sm'),
        el('span', { class: 'name' },
          el('span', { text: d.peer.name }),
          d.peer.role === 'host' ? el('span', { class: 'role-pill host', text: 'HOST' }) : null,
          el('span', { class: 'preview', text: d.help ? `Help · ${last}` : last })
        ),
        el('span', { class: 'nav-meta' }, d.unread ? el('span', { class: 'unread-pill', text: String(d.unread) }) : null)
      );
      dmsEl.appendChild(li);
    });
    if (!dms.length) dmsEl.appendChild(el('li', { style: { cursor: 'default', color: 'var(--faint)' }, text: 'Message someone online' }));

    state.users.filter((u) => matchesFilter(u.name)).forEach((u) => {
      const self = u.id === state.me?.id;
      const li = el(
        'li',
        {
          role: 'button',
          tabindex: '0',
          onclick: () => { if (!self) startDm(u.id); },
          onkeydown: navKey(() => { if (!self) startDm(u.id); }),
        },
        avatar(u.name, u.color, 'sm'),
        el('span', { class: 'name' },
          self ? `${u.name} (you)` : u.name,
          el('span', { class: `role-pill ${u.role === 'host' ? 'host' : 'user'}`, text: u.role === 'host' ? 'HOST' : 'USER' })
        )
      );
      usersEl.appendChild(li);
    });
  }

  function navKey(fn) {
    return (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
  }

  function updateHeader() {
    const isDm = state.roomMeta?.type === 'dm' || String(state.room || '').startsWith('dm-');
    roomHash.textContent = isDm ? '✉' : '#';
    roomTitle.textContent = (state.roomLabel || state.room || 'lobby').replace(/^#/, '');
    if (isDm) roomSub.textContent = 'Private conversation';
    else roomSub.textContent = state.roomMeta?.description || `${state.users.length} online`;
    msgInput.placeholder = isDm ? `Message ${state.roomLabel || 'direct'}` : `Message #${(state.room || 'lobby').toLowerCase()}`;
    const unread = [...state.public, ...state.dms.map((d) => ({ unread: d.unread }))].reduce((n, r) => n + (r.unread || 0), 0) + state.hiddenUnread;
    if (unread > 0 && document.hidden) {
      unreadBadge.hidden = false;
      unreadBadge.textContent = String(unread);
    } else if (!document.hidden) {
      unreadBadge.hidden = true;
    }
    document.title = unread && document.hidden ? `(${unread}) Agent` : 'Agent · Live support';
    const createBtn = $('newRoomBtn');
    if (createBtn) createBtn.hidden = !state.canCreateRoom;
  }

  function updateMeCard() {
    if (!state.me) return;
    $('meName').textContent = state.me.name;
    const av = $('meAvatar');
    av.textContent = initials(state.me.name);
    av.style.background = state.me.color || colorFromId(state.me.id);
    const roleEl = $('meRole');
    if (roleEl) {
      roleEl.innerHTML = '';
      roleEl.append(el('i', { class: 'dot' }), state.me.role === 'host' ? ' Host' : ' User');
    }
  }

  function setConn(kind, rtt) {
    state.conn = kind;
    if (rtt != null) state.rtt = rtt;
    const elStatus = $('connStatus');
    const banner = connBanner;
    if (!elStatus) return;
    if (kind === 'connected') {
      const ms = state.rtt;
      let quality = '';
      if (ms != null) {
        if (ms < 100) quality = 'Excellent';
        else if (ms < 200) quality = 'Good';
        else if (ms < 400) quality = 'Slow';
        else quality = 'Poor';
        elStatus.textContent = `🟢 Connected · ${ms}ms`;
        elStatus.title = `${quality} (${ms}ms)`;
      } else {
        elStatus.textContent = '🟢 Connected';
      }
      if (banner) banner.hidden = true;
    } else if (kind === 'reconnecting') {
      elStatus.textContent = '🟡 Reconnecting…';
      if (banner) { banner.hidden = false; banner.textContent = 'Reconnecting to the live session…'; }
    } else {
      elStatus.textContent = '🔴 Disconnected';
      if (banner) { banner.hidden = false; banner.textContent = 'Disconnected. We usually come online Saturday & Sunday.'; }
    }
  }

  function setSession(session, fromSocket) {
    state.session = { live: !!(fromSocket || session?.live), hostOnline: !!session?.hostOnline, hosts: session?.hosts || 0 };
    const live = state.conn === 'connected' || state.conn === 'connecting' && state.session.live;
    const gateLive = $('gateLive');
    const pill = $('sessionPill');
    const onlineNow = state.conn === 'connected';
    const text = !onlineNow
      ? '⚫ Offline · We usually come online Saturday & Sunday'
      : state.session.hostOnline
        ? '🟢 Live now · Support is currently online'
        : '🟡 Live · Waiting for a host';
    const cls = !onlineNow ? 'offline' : state.session.hostOnline ? 'live' : 'wait';
    if (gateLive) {
      gateLive.className = `live-pill ${cls}`;
      gateLive.textContent = text;
    }
    if (pill) {
      pill.className = `live-pill compact ${cls}`;
      pill.textContent = !onlineNow ? '⚫ Offline' : state.session.hostOnline ? '🟢 Live now' : '🟡 Waiting for host';
    }
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 96;
  }

  function scrollToBottom(force) {
    if (force || state.stickBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  messagesEl.addEventListener('scroll', () => {
    state.stickBottom = nearBottom();
    if (state.stickBottom) jumpLatest.hidden = true;
  });

  jumpLatest.addEventListener('click', () => {
    state.stickBottom = true;
    jumpLatest.hidden = true;
    scrollToBottom(true);
  });

  function shouldGroup(prev, curr) {
    if (!prev || !curr) return false;
    if (curr.replyTo) return false;
    if (prev.user?.id !== curr.user?.id) return false;
    return curr.ts - prev.ts < 5 * 60 * 1000;
  }

  function renderMessages() {
    const q = state.query.trim().toLowerCase();
    const list = q
      ? state.messages.filter((m) => `${m.text} ${m.user?.name || ''}`.toLowerCase().includes(q))
      : state.messages;

    messagesEl.innerHTML = '';
    if (!list.length) {
      messagesEl.appendChild(
        el(
          'div',
          { class: 'empty-state' },
          el('div', { class: 'mark', 'aria-hidden': 'true' }, el('span', { class: 'mark-ring' }), el('span', { class: 'mark-core' })),
          el('h3', { text: q ? 'No matching messages' : 'This room is quiet' }),
          el('p', { text: q ? 'Try a different search.' : 'Ask a question, drop a screenshot, or tap Help to reach the host.' }),
          !q && el(
            'div',
            { class: 'prompt-row' },
            ['I need help with an error', 'Can someone review this?', 'How should I start?'].map((p) => el('button', {
              type: 'button',
              class: 'prompt-chip',
              onclick: () => { msgInput.value = p; msgInput.focus(); resizeComposer(); },
            }, p))
          )
        )
      );
      if (searchMeta) searchMeta.textContent = q ? '0 results' : '';
      return;
    }

    if (searchMeta) searchMeta.textContent = q ? `${list.length} result${list.length === 1 ? '' : 's'}` : '';

    let dividerDrawn = false;
    list.forEach((msg, i) => {
      const prev = list[i - 1];
      if (!prev || !sameDay(prev.ts, msg.ts)) {
        messagesEl.appendChild(el('div', { class: 'date-chip', text: formatDay(msg.ts) }));
      }
      if (
        !dividerDrawn &&
        state.lastSeen &&
        msg.ts > state.lastSeen &&
        msg.user?.id !== state.me?.id
      ) {
        messagesEl.appendChild(el('div', { class: 'new-divider', text: 'New' }));
        dividerDrawn = true;
      }
      messagesEl.appendChild(messageRow(msg, shouldGroup(prev, msg)));
    });
    scrollToBottom();
  }

  function messageRow(msg, grouped) {
    const mine = msg.user?.id && state.me?.id && msg.user.id === state.me.id;
    const row = el('div', {
      class: `msg-row${mine ? ' own' : ''}${grouped ? ' grouped' : ''}`,
      dataset: { messageId: msg.id },
    });
    row.appendChild(avatar(msg.user?.name, msg.user?.color || colorFromId(msg.user?.id), 'lg'));

    const bubble = el('div', { class: 'bubble' });
    const meta = el(
      'div',
      { class: 'meta' },
      el('span', { class: 'who', text: msg.user?.name || 'Someone' }),
      msg.user?.role === 'host' ? el('span', { class: 'role-pill host', text: 'HOST' }) : null,
      el('span', { class: 'when', text: formatTime(msg.ts), title: new Date(msg.ts).toLocaleString() }),
      msg.edited ? el('span', { class: 'edited', text: 'edited' }) : null
    );
    bubble.appendChild(meta);

    if (msg.replyTo) {
      bubble.appendChild(
        el(
          'div',
          { class: 'quote' },
          el('div', { class: 'qn', text: msg.replyTo.userName || 'Reply' }),
          el('div', { text: msg.replyTo.text || '' })
        )
      );
    }

    const body = renderRich(msg.text);
    if (state.query) highlight(body, state.query);
    bubble.appendChild(body);

    if (msg.attachments?.length) {
      const grid = el('div', { class: 'attach-grid' });
      msg.attachments.forEach((f) => {
        if ((f.type || '').startsWith('image/')) {
          const img = el('img', { class: 'attach-img', src: f.url, alt: f.name || 'image' });
          img.addEventListener('click', () => openLightbox(f.url, f.name));
          grid.appendChild(img);
        } else {
          grid.appendChild(el('a', { class: 'file-chip', href: f.url, target: '_blank', rel: 'noopener' }, `${f.name || 'File'} · ${prettySize(f.size)}`));
        }
      });
      bubble.appendChild(grid);
    }

    bubble.appendChild(renderReactions(msg));
    if (mine && (state.roomMeta?.type === 'dm' || String(state.room || '').startsWith('dm-'))) {
      const read = (msg.readBy || []).some((id) => id !== state.me?.id);
      const label = read ? '✓✓ Read' : msg.delivered ? '✓✓ Delivered' : '✓ Sent';
      bubble.appendChild(el('div', { class: `receipts${read ? ' read' : ''}`, text: label }));
    }
    row.appendChild(bubble);
    row.appendChild(toolbar(msg, mine));
    return row;
  }

  function renderReactions(msg) {
    const wrap = el('div', { class: 'reactions' });
    Object.entries(msg.reactions || {}).forEach(([emoji, users]) => {
      const you = (users || []).includes(state.me?.id);
      wrap.appendChild(
        el('button', {
          class: `reaction${you ? ' you' : ''}`,
          type: 'button',
          onclick: () => socket.emit('reaction', { messageId: msg.id, emoji }),
        }, `${emoji} `, el('span', { text: String((users || []).length) }))
      );
    });
    if (!wrap.childElementCount) wrap.style.display = 'none';
    return wrap;
  }

  function toolbar(msg, mine) {
    const bar = el('div', { class: 'toolbar', onclick: (e) => e.stopPropagation() });
    QUICK_REACT.slice(0, 3).forEach((e) => {
      bar.appendChild(el('button', { type: 'button', title: `React ${e}`, onclick: () => socket.emit('reaction', { messageId: msg.id, emoji: e }) }, e));
    });
    bar.appendChild(el('button', { type: 'button', title: 'Reply', onclick: () => setReply(msg) }, '↩'));
    if (mine) {
      bar.appendChild(el('button', { type: 'button', title: 'Edit', onclick: () => beginEdit(msg) }, 'Edit'));
    }
    if (mine || state.me?.role === 'host') {
      bar.appendChild(el('button', { type: 'button', class: 'danger', title: 'Delete', onclick: () => askDelete(msg) }, 'Del'));
    }
    bar.appendChild(el('button', {
      type: 'button',
      title: 'Copy',
      onclick: async () => {
        try { await navigator.clipboard.writeText(msg.text || ''); toast('Copied'); } catch { toast('Could not copy'); }
      },
    }, 'Copy'));
    return bar;
  }

  function setReply(msg) {
    state.replyTo = { id: msg.id, text: msg.text, userName: msg.user?.name };
    replyBar.hidden = false;
    $('replyName').textContent = msg.user?.name || 'message';
    $('replyText').textContent = msg.text || 'Attachment';
    msgInput.focus();
  }

  $('replyCancel').addEventListener('click', () => {
    state.replyTo = null;
    replyBar.hidden = true;
  });

  function beginEdit(msg) {
    const row = messagesEl.querySelector(`[data-message-id="${msg.id}"]`);
    if (!row) return;
    const body = row.querySelector('.body');
    if (!body) return;
    const input = el('textarea', { class: 'edit-input' });
    input.value = msg.text || '';
    input.style.width = '100%';
    input.style.minHeight = '64px';
    input.style.marginTop = '6px';
    body.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) socket.emit('edit-message', { messageId: msg.id, text: input.value.trim() });
      else renderMessages();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function askDelete(msg) {
    openModal('confirmModal');
    const yes = $('confirmYes');
    const no = $('confirmNo');
    const onYes = () => { socket.emit('delete-message', { messageId: msg.id }); cleanup(); };
    const onNo = () => cleanup();
    function cleanup() {
      closeModal('confirmModal');
      yes.removeEventListener('click', onYes);
      no.removeEventListener('click', onNo);
    }
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
  }

  function openLightbox(src, alt) {
    $('lightboxImg').src = src;
    $('lightboxImg').alt = alt || '';
    $('lightbox').hidden = false;
  }
  $('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });

  function joinRoom(name) {
    if (!name) return;
    socket.emit('join-room', name);
    try { localStorage.setItem('agent.room', name); } catch {}
    setSidebar(false);
  }

  function startDm(userId) {
    socket.emit('create-dm', userId);
    setSidebar(false);
  }

  function showGate() {
    document.body.classList.remove('in-session');
    if (app) app.hidden = true;
    if (gate) gate.hidden = false;
  }

  function showApp() {
    document.body.classList.add('in-session');
    if (gate) gate.hidden = true;
    if (app) app.hidden = false;
  }

  function logout(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    state.left = true;
    state.joined = false;
    try { sessionStorage.setItem('agent.left', '1'); } catch {}
    try { localStorage.removeItem('agent.room'); } catch {}
    try { socket.emit('stop-typing'); } catch {}
    try { socket.emit('leave'); } catch {}
    state.me = null;
    state.room = null;
    state.roomMeta = null;
    state.roomLabel = '';
    state.public = [];
    state.dms = [];
    state.users = [];
    state.messages = [];
    state.replyTo = null;
    state.attachments = [];
    state.canCreateRoom = false;
    state.typers.clear();
    state.hiddenUnread = 0;
    if (msgInput) {
      msgInput.value = '';
      msgInput.disabled = true;
    }
    if (sendBtn) sendBtn.disabled = true;
    if (replyBar) replyBar.hidden = true;
    if (attachPreview) {
      attachPreview.hidden = true;
      attachPreview.innerHTML = '';
    }
    if (searchBar) searchBar.hidden = true;
    if (jumpLatest) jumpLatest.hidden = true;
    if (typingEl) typingEl.textContent = '';
    if (messagesEl) messagesEl.innerHTML = '';
    if (roomsEl) roomsEl.innerHTML = '';
    if (dmsEl) dmsEl.innerHTML = '';
    if (usersEl) usersEl.innerHTML = '';
    document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
    setSidebar(false);
    showGate();
    const remembered = savedName();
    if (remembered && $('gateName')) $('gateName').value = remembered;
    document.title = 'Agent · Live support';
    toast('You left the session');
  }

  function enterWorkspace(name) {
    const clean = String(name || '').trim().slice(0, 32);
    if (!clean) return;
    try { localStorage.setItem('agent.name', clean); } catch {}
    const codeEl = $('gateCode');
    const hostCode = codeEl && codeEl.value ? codeEl.value : '';
    if (codeEl) codeEl.value = '';
    const me = {
      id: uid(),
      name: clean,
      color: state.prefs.color || colorFromId(uid()),
      room: (() => { try { return localStorage.getItem('agent.room') || 'General'; } catch { return 'General'; } })(),
    };
    state.left = false;
    try { sessionStorage.removeItem('agent.left'); } catch {}
    state.me = me;
    socket.emit('join', hostCode ? { ...me, hostCode } : me);
    showApp();
    msgInput.disabled = false;
    sendBtn.disabled = false;
    msgInput.focus();
    if (state.prefs.notif && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  $('gateForm').addEventListener('submit', (e) => {
    e.preventDefault();
    enterWorkspace($('gateName').value);
  });

  const remembered = savedName();
  if (remembered) $('gateName').value = remembered;
  $('gateName').focus();
  try {
    const left = sessionStorage.getItem('agent.left') === '1';
    if (!left && remembered && localStorage.getItem('agent.room')) enterWorkspace(remembered);
  } catch {}

  navSearch.addEventListener('input', () => {
    state.filter = navSearch.value;
    renderNav();
  });

  $('searchToggle').addEventListener('click', () => {
    searchBar.hidden = !searchBar.hidden;
    if (!searchBar.hidden) msgSearch.focus();
    else {
      state.query = '';
      msgSearch.value = '';
      renderMessages();
    }
  });
  $('searchClose').addEventListener('click', () => {
    searchBar.hidden = true;
    state.query = '';
    msgSearch.value = '';
    renderMessages();
  });
  msgSearch.addEventListener('input', () => {
    state.query = msgSearch.value;
    renderMessages();
  });

  $('themeBtn').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  $('newRoomBtn').addEventListener('click', () => {
    openModal('newRoomModal');
    $('newRoomName').focus();
  });
  $('newRoomForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('newRoomName').value.trim();
    const description = $('newRoomDesc').value.trim();
    if (!name) return;
    socket.emit('create-room', { name, description });
    $('newRoomForm').reset();
    closeModal('newRoomModal');
  });

  function paintColors(active) {
    const box = $('colorChoices');
    box.innerHTML = '';
    PALETTE.forEach((c) => {
      box.appendChild(el('button', {
        type: 'button',
        class: `swatch${c === active ? ' active' : ''}`,
        style: { background: c },
        onclick: () => {
          state.prefs.color = c;
          paintColors(c);
        },
      }));
    });
  }

  function openSettings() {
    if (state.me) $('setName').value = state.me.name;
    $('setNotif').checked = !!state.prefs.notif;
    $('setSound').checked = !!state.prefs.sound;
    $('setPresence').checked = !!state.prefs.presence;
    paintColors(state.prefs.color || state.me?.color || PALETTE[0]);
    openModal('settingsModal');
  }
  $('settingsBtn').addEventListener('click', openSettings);
  $('meCard').addEventListener('click', openSettings);
  const logoutBtn = $('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  const leaveBtn = $('leaveBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', logout);
  $('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.prefs.notif = $('setNotif').checked;
    state.prefs.sound = $('setSound').checked;
    state.prefs.presence = $('setPresence').checked;
    savePrefs();
    const name = $('setName').value.trim();
    if (name) {
      try { localStorage.setItem('agent.name', name); } catch {}
      socket.emit('profile', { name, color: state.prefs.color });
    }
    if (state.prefs.notif && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    closeModal('settingsModal');
    toast('Settings saved');
  });

  function resizeComposer() {
    msgInput.style.height = 'auto';
    msgInput.style.height = `${Math.min(msgInput.scrollHeight, 160)}px`;
  }
  msgInput.addEventListener('input', () => {
    resizeComposer();
    socket.emit('typing');
    clearTimeout(msgInput._t);
    msgInput._t = setTimeout(() => socket.emit('stop-typing'), 1100);
  });

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendCurrent();
  });
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });

  function sendCurrent() {
    const text = msgInput.value.trim();
    if (!text && !state.attachments.length) return;
    if (!state.joined) return toast('Join the workspace first');
    socket.emit('message', {
      text,
      room: state.room,
      replyTo: state.replyTo,
      attachments: state.attachments,
    });
    msgInput.value = '';
    resizeComposer();
    state.replyTo = null;
    replyBar.hidden = true;
    state.attachments = [];
    attachPreview.hidden = true;
    attachPreview.innerHTML = '';
    socket.emit('stop-typing');
    state.stickBottom = true;
  }

  async function uploadFile(file) {
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    try {
      const res = await fetch('/upload', { method: 'POST', body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      state.attachments = [data];
      attachPreview.hidden = false;
      attachPreview.innerHTML = '';
      const label = el('div', {}, el('div', { class: 'chip-kicker', text: 'Attachment' }), el('div', { class: 'chip-text', text: `${data.name} · ${prettySize(data.size)}` }));
      const rm = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove attachment', onclick: () => { state.attachments = []; attachPreview.hidden = true; } }, '✕');
      attachPreview.append(label, rm);
      msgInput.focus();
    } catch (err) {
      toast(err.message || 'Upload failed');
    }
  }

  $('attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    uploadFile(file);
  });

  const dropOverlay = $('dropOverlay');
  document.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    if (dropOverlay && !app.hidden) dropOverlay.hidden = false;
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) {
      if (dropOverlay) dropOverlay.hidden = true;
    }
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dropOverlay) dropOverlay.hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (file && !app.hidden) uploadFile(file);
  });
  document.addEventListener('paste', (e) => {
    if (app.hidden) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      uploadFile(item.getAsFile());
    }
  });

  function placePopover() {
    const btn = $('emojiToggle');
    const r = btn.getBoundingClientRect();
    emojiPopover.style.left = `${Math.max(12, r.right - 280)}px`;
    emojiPopover.style.top = `${r.top - 220}px`;
  }

  emojiPopover.innerHTML = '';
  EMOJIS.forEach((e) => {
    emojiPopover.appendChild(el('button', {
      type: 'button',
      onclick: () => {
        const start = msgInput.selectionStart || msgInput.value.length;
        msgInput.value = msgInput.value.slice(0, start) + e + msgInput.value.slice(msgInput.selectionEnd || start);
        msgInput.focus();
        emojiPopover.hidden = true;
        resizeComposer();
      },
    }, e));
  });
  $('emojiToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPopover.hidden = !emojiPopover.hidden;
    if (!emojiPopover.hidden) placePopover();
  });
  document.addEventListener('click', () => { emojiPopover.hidden = true; });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
      emojiPopover.hidden = true;
      $('lightbox').hidden = true;
      setSidebar(false);
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      navSearch.focus();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) {
      if (app.hidden) return;
      e.preventDefault();
      searchBar.hidden = false;
      msgSearch.focus();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.hiddenUnread = 0;
      unreadBadge.hidden = true;
      document.title = 'Agent · Live support';
      if (state.room) socket.emit('mark-read', state.room);
    }
  });

  /* ----------------------------- Socket ----------------------------- */

  socket.on('connect', () => {
    setConn('connected');
    setSession(state.session, true);
    if (!state.left && state.me && state.joined) {
      socket.emit('join', { id: state.me.id, name: state.me.name, color: state.me.color, room: state.room || 'General' });
    }
    pingOnce();
  });
  socket.on('disconnect', (reason) => {
    if (reason === 'io client disconnect') setConn('disconnected');
    else setConn('reconnecting');
    setSession({ live: false, hostOnline: false, hosts: 0 });
  });
  socket.on('connect_error', () => {
    setConn(state.joined ? 'reconnecting' : 'disconnected');
    setSession({ live: false, hostOnline: false, hosts: 0 });
  });
  socket.io.on('reconnect_attempt', () => setConn('reconnecting'));

  function pingOnce() {
    socket.emit('ping-rtt', Date.now());
  }
  setInterval(() => { if (socket.connected) pingOnce(); }, 12000);
  socket.on('pong-rtt', (sentAt) => {
    if (typeof sentAt === 'number') setConn('connected', Math.max(0, Date.now() - sentAt));
  });
  socket.on('session', (session) => setSession(session, true));

  socket.on('joined', (user) => {
    if (state.left) return;
    state.me = { ...(state.me || {}), ...user };
    state.joined = true;
    updateMeCard();
  });

  socket.on('workspace', (payload) => {
    if (payload.session) setSession(payload.session, true);
    if (state.left || !state.joined) return;
    state.public = payload.public || [];
    state.dms = payload.dms || [];
    state.users = payload.users || [];
    state.canCreateRoom = !!payload.canCreateRoom;
    onlineLabel.textContent = `${payload.online || state.users.length} online`;
    renderNav();
    updateHeader();
    updateMeCard();
  });

  socket.on('room-joined', ({ room, label, meta, messages, lastSeen }) => {
    if (state.left || !state.joined) return;
    state.room = room;
    state.roomLabel = label || room;
    state.roomMeta = meta || { type: 'public' };
    state.messages = Array.isArray(messages) ? messages : [];
    state.lastSeen = Number(lastSeen) || 0;
    state.stickBottom = true;
    jumpLatest.hidden = true;
    renderMessages();
    renderNav();
    updateHeader();
    socket.emit('mark-read', room);
    try { localStorage.setItem('agent.room', room); } catch {}
  });

  socket.on('message', (msg) => {
    if (state.left || !state.joined) return;
    if (!msg || !msg.id) return;
    if (state.messages.some((m) => m.id === msg.id)) return;
    if (msg.room === state.room) {
      state.messages.push(msg);
      if (state.query) {
        renderMessages();
      } else {
        const last = messagesEl.querySelector('.empty-state') ? null : state.messages[state.messages.length - 2];
        if (!last || !sameDay(last.ts, msg.ts)) {
          if (messagesEl.querySelector('.empty-state')) messagesEl.innerHTML = '';
          messagesEl.appendChild(el('div', { class: 'date-chip', text: formatDay(msg.ts) }));
        }
        if (messagesEl.querySelector('.empty-state')) messagesEl.innerHTML = '';
        const row = messageRow(msg, shouldGroup(last, msg));
        row.classList.add('fresh');
        messagesEl.appendChild(row);
        if (nearBottom() || msg.user?.id === state.me?.id) scrollToBottom(true);
        else {
          jumpLatest.hidden = false;
          state.stickBottom = false;
        }
      }
    }
    if (msg.user?.id !== state.me?.id) {
      if (document.hidden) {
        state.hiddenUnread += 1;
        updateHeader();
        notify(msg.user?.name || 'New message', msg.text || 'Sent an attachment');
      }
      if (msg.room === state.room || document.hidden) beep();
    }
  });

  socket.on('reaction', ({ messageId, reactions, userReactions }) => {
    const msg = state.messages.find((m) => m.id === messageId);
    if (msg) {
      msg.reactions = reactions || {};
      msg.userReactions = userReactions || {};
    }
    const row = messagesEl.querySelector(`[data-message-id="${messageId}"]`);
    if (!row || !msg) return;
    const prev = row.querySelector('.reactions');
    if (prev) prev.replaceWith(renderReactions(msg));
  });

  socket.on('message-updated', (msg) => {
    const idx = state.messages.findIndex((m) => m.id === msg.id);
    if (idx >= 0) state.messages[idx] = msg;
    renderMessages();
  });

  socket.on('message-deleted', ({ messageId }) => {
    state.messages = state.messages.filter((m) => m.id !== messageId);
    const row = messagesEl.querySelector(`[data-message-id="${messageId}"]`);
    if (row) row.remove();
    if (!state.messages.length) renderMessages();
  });

  socket.on('typing', ({ room, user }) => {
    if (room !== state.room || user?.id === state.me?.id) return;
    state.typers.set(user.id, user.name);
    renderTyping();
    clearTimeout(state.typers._t);
    state.typers._t = setTimeout(() => { state.typers.delete(user.id); renderTyping(); }, 2000);
  });

  socket.on('stop-typing', ({ room, user }) => {
    if (room !== state.room) return;
    state.typers.delete(user?.id);
    renderTyping();
  });

  function renderTyping() {
    const names = [...state.typers.values()];
    if (!names.length) typingEl.textContent = '';
    else if (names.length === 1) typingEl.textContent = `${names[0]} is typing…`;
    else if (names.length === 2) typingEl.textContent = `${names[0]} and ${names[1]} are typing…`;
    else typingEl.textContent = 'Several people are typing…';
  }

  socket.on('presence', ({ type, user, online }) => {
    if (state.left) return;
    if (online != null && onlineLabel) onlineLabel.textContent = `${online} online`;
    if (!state.prefs.presence || !user || user.id === state.me?.id) return;
    toast(`${user.name} ${type === 'leave' ? 'left' : 'joined'}`);
  });

  socket.on('dm-invite', ({ from }) => {
    toast(`${from?.name || 'Someone'} started a direct message`);
  });

  socket.on('receipt', ({ messageId, read, readBy, delivered }) => {
    const msg = state.messages.find((m) => m.id === messageId);
    if (!msg) return;
    if (delivered) msg.delivered = true;
    if (readBy) msg.readBy = readBy;
    else if (read) msg.readBy = msg.readBy || ['1'];
    const row = messagesEl.querySelector(`[data-message-id="${messageId}"] .receipts`);
    if (row) {
      const isRead = (msg.readBy || []).some((id) => id !== state.me?.id);
      row.textContent = isRead ? '✓✓ Read' : msg.delivered ? '✓✓ Delivered' : '✓ Sent';
      row.classList.toggle('read', isRead);
    }
  });

  socket.on('help-queued', ({ message }) => toast(message || 'Help request queued'));

  socket.on('error-message', ({ message }) => toast(message || 'Something went wrong'));

  const helpBtn = $('helpBtn');
  if (helpBtn) helpBtn.addEventListener('click', () => {
    openModal('helpModal');
    $('helpTitle')?.focus();
  });
  const helpForm = $('helpForm');
  if (helpForm) {
    helpForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!state.joined) return toast('Join the session first');
      socket.emit('request-help', {
        title: $('helpTitle').value.trim(),
        category: $('helpCat').value,
        description: $('helpDesc').value.trim(),
        attachments: state.attachments,
      });
      helpForm.reset();
      closeModal('helpModal');
      toast(state.session.hostOnline ? 'Sent to the host' : 'Queued until a host is online');
    });
  }

  async function refreshGateHealth() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const data = await res.json();
      if (socket.connected) setSession(data, true);
    } catch {
      if (!socket.connected) setSession({ live: false, hostOnline: false }, false);
    }
  }
  refreshGateHealth();
  setInterval(refreshGateHealth, 15000);
})();
