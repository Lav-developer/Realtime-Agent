# Realtime Agent

A complete realtime chat platform: public channels, private DMs, replies, reactions, edits, file sharing, and presence — served as a single Node.js app.

## Features

- **Workspace identity** persisted on this device (no account required)
- **Public channels** with create/join, topics, and unread badges
- **Direct messages** that do not steal the other person’s current room
- **Message tools**: replies, reactions, edit, delete, copy
- **Attachments** with image lightbox and file chips
- **Live presence**, typing indicators, and desktop / sound notifications
- **Search** the current room (`Ctrl/⌘ F`) and jump rooms (`Ctrl/⌘ K`)
- **Dark / light theme**, mobile drawer navigation, keyboard-first composer
- **Drag-and-drop / paste** images and files
- **Unread divider**, typing indicators, and `@mentions`
- **Reconnect** with a grace period so a refresh does not look like a leave
- Disk persistence for rooms and history (`data/rooms.json`)

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Development with auto-reload:

```bash
npm run dev
```

## Environment

| Variable       | Default   | Purpose                                      |
| -------------- | --------- | -------------------------------------------- |
| `PORT`         | `3000`    | HTTP port                                    |
| `HOST`         | `0.0.0.0` | Bind address                                 |
| `CORS_ORIGIN`  | `*`       | Allowed browser origin when hosted separately |

## Architecture

- `server.js` — Express, Socket.IO, uploads, rooms, DMs, rate limits
- `lib/store.js` — atomic JSON persistence for rooms and metadata
- `public/` — vanilla client (no build step)

Identity uses a stable client-generated id. Socket ids are only a transport handle, so DMs and unread state survive reconnects.

## Notes

- History is stored on disk for the demo; it is not a multi-process database.
- Uploads live in `uploads/` and are capped at 8 MB with an allow-list of types.
- Health check: `GET /api/health`
