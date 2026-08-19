## Copilot instructions for Realtime Agent

Weekend live-support app: Node.js + Express + Socket.IO and a vanilla client in `public/`.

- Persistent user ids come from the client. Socket ids are transport-only.
- Host role is granted only after a server-side access-code check (`lib/hostAuth.js`). Never trust `role` from the client. Never put the code in the UI or client JS.
- Default rooms: General, Coding, Career, Projects. Only a host can create more rooms. `join-room` must not create rooms.
- Persistence (`data/rooms.json`) is opt-in via `ENABLE_PERSISTENCE`.
- Keep using `textContent` / element builders for user content.

Key events: `join` / `joined`, `workspace`, `session`, `request-help`, `create-room` (host only).
