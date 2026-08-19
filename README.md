# Realtime Agent

A lightweight realtime community support platform built with Node.js, Express and Socket.IO.

Every Saturday and Sunday the host starts the server and goes online. People visit the site, join the live session, and talk with the host and community — questions, screenshots, and files included.

This is an **ephemeral live session**, not a persistent enterprise chat product. When the process stops, in-memory history is gone unless you explicitly turn persistence on.

## Use case

User → website → live session → realtime conversation with the host/community

- Host is visually marked **HOST**
- Guests are marked **USER**
- `#General` is the only default room
- Extra rooms appear only when the host creates them
- **Request Help** opens (or queues) a private conversation with the host

## Features

- Live / offline session status
- Connection state and optional latency (`🟢 Connected · 42ms`)
- Public rooms, DMs, and a simple help request
- Replies, reactions, edit, delete (host can delete any message)
- Screenshots and files (allow-listed, size-capped)
- Typing (viewing-room only), mentions, unread divider
- Reconnect with a short grace period
- Mobile drawer navigation
- Dark / light theme

## Tech stack

- Node.js 18+
- Express
- Socket.IO
- Vanilla HTML/CSS/JS (no build step)

## Local setup

```bash
npm install
npm start
```

Open http://localhost:3000

```bash
npm test
npm run dev
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `*` | Browser origin when the UI is hosted separately |
| `HOST_CODE` | (server-held digest) | Optional override for the host access code |
| `ENABLE_PERSISTENCE` | off | If `true`, write `data/rooms.json` between restarts |

The host access code is checked only on the server. It is not shown in the UI and is not stored in the client.

## Architecture

- `server.js` — HTTP, Socket.IO, rooms, DMs, help, uploads
- `lib/hostAuth.js` — host code verification
- `lib/store.js` — optional JSON persistence
- `public/` — client
- `test/` — realtime integration tests

Identity is a device-local id. Socket ids are transport only.

## Realtime events (overview)

Client → server: `join`, `message`, `join-room`, `create-room`, `create-dm`, `request-help`, `reaction`, `edit-message`, `delete-message`, `typing`, `stop-typing`, `mark-read`, `ping-rtt`

Server → client: `joined`, `workspace`, `session`, `room-joined`, `message`, `reaction`, `receipt`, `presence`, `dm-invite`, `help-queued`, `error-message`, `pong-rtt`

## Testing

```bash
npm test
```

CI (GitHub Actions) installs dependencies, checks syntax, runs tests, and hits `/api/health`.

## Deployment

Run `npm start` on a host that can keep a single Node process online for the weekend session. Bind `0.0.0.0` and put a reverse proxy in front if you need HTTPS. One process is enough — this is not a multi-node cluster.

## Limitations

- One Node process; no database
- History is in-memory unless `ENABLE_PERSISTENCE=true`
- Host access is a shared code, not per-person accounts
- Uploads are local disk, not object storage
- Not a Slack/Discord replacement

## Roadmap

- Optional session hours banner
- Better host inbox for queued help
- Voice notes only if the weekend sessions actually need them
