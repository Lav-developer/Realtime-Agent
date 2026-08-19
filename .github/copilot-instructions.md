## Copilot instructions for Realtime Agent

Purpose

- Complete realtime chat platform: Node.js + Express + Socket.IO (`server.js`) and a vanilla client in `public/`.
- Persistent user ids come from the client. Socket ids are transport-only.

Quick architecture

- Server: `server.js` owns `online`, `rooms`, `roomsMeta`, and `messages`.
- Persistence: `lib/store.js` writes `data/rooms.json` atomically.
- Client: `public/index.html`, `public/client.js`, `public/styles.css`.
- Workspace payload: `workspace` with `{ public, dms, users, online }`.

Key files

- `server.js` — join, rooms, DMs, messages, reactions, uploads, presence
- `public/client.js` — gate, sidebar, composer, search, theme, socket handlers
- `lib/store.js` — load/save rooms
- `package.json` — `npm start`, `npm run dev`

Socket conventions

- `join` / `joined` — identity ack; always trust server `joined` for `me.id`
- `workspace` — channels, DMs, online users (per-viewer unread)
- `create-room`, `join-room`, `create-dm`, `room-joined`
- `message`, `message-updated`, `message-deleted`, `reaction`
- `typing` / `stop-typing` are room-scoped
- `error-message` for user-facing errors (do not use the `error` event)

Conventions

- Keep UI in `public/` and keep payload shapes in sync with `server.js`.
- Sanitize names, rooms, and message text on the server.
- Use `textContent` / element builders on the client; never assign raw innerHTML from user text.

Dev

```bash
npm install
npm start
```
