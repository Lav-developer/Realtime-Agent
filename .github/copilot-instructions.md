## Copilot instructions for Realtime Agent Chat

Purpose

- Small demo: Node.js + Express (`server.js`) with Socket.IO and a static client under `public/`.
- In-memory single-process chat (no DB). These instructions show project-specific patterns an AI agent can safely change.

Quick architecture

- Server: `server.js` is the sole backend. It manages an in-memory `Map` of users keyed by `socket.id` and emits socket events.
- Client: `public/index.html`, `public/client.js`, `public/styles.css` — vanilla JS, DOM helpers like `renderUsers()` and `addMessage()`.
- Data flow: client emits `join` and `message`; server sends `joined` (ack), `users-list` (array), `user-joined`, and `user-left` events.

Key files to read

- `server.js` — socket handlers, `users` map, CORS toggles, run entrypoint.
- `public/client.js` — socket usage, setting `me.id` from `joined` ack, desktop notifications.
- `lib/store.js` — in-repo helper (if present) for shared logic/state.
- `package.json` — run scripts (`npm start`, `npm run dev`).

Socket & protocol conventions (examples)

- Event names: `join`, `joined` (ack with your socket/user info), `message`, `users-list`, `user-joined`, `user-left`.
- Always accept server `joined` ack to set local `me.id` instead of guessing socket id.
- Prefer `users-list` array payload from server rather than scraping DOM for state.

Dev workflows (PowerShell)

```powershell
cd "d:\Lav Kush\College Project\Realtime-Agent"; npm install; npm start
# For local dev with autoreload:
npm run dev
```

Project-specific conventions

- Keep UI-only changes in `public/` and avoid changing socket payload shapes without coordinating updates in `server.js` and `public/client.js`.
- Small, localized fixes are allowed (DOM bugfixes, UX tweaks, small refactors). Large changes (protocol, persistence) must be reviewed first.

Integration points & risks

- No external services by default; the app is intentionally ephemeral. Introducing a DB or external auth requires a migration plan.
- `CORS_ORIGIN` and other runtime flags may be present in `server.js` — update carefully.

Allowed autonomous edits for AI agents

- Fix clear, localized bugs (e.g., ensure `me.id` is set from `joined` ack, keep `users-list` consistent, reduce DOM scraping).
- Small UX improvements inside `public/` (keyboard shortcuts, accessibility labels, non-protocol notifications).

Stop and ask a human when

- Adding persistence (DB), authentication, or external hosting infra.
- Changing socket event names/required payload fields or adding new cross-service APIs.
- Implementing security-sensitive features (rate limiting, sanitization) without an explicit threat model.

Where to look for examples

- Join/message flows: `server.js` and `public/client.js`.
- Desktop notifications and permissions: `public/client.js`.

If you update this file

- Keep edits small and add a one-line summary of changes and affected files.

Generated guidance — review before applying to production.
