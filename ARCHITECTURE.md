# Architecture

## Overview

A single Node.js/Express process serves both a REST API and a Socket.IO realtime layer. PostgreSQL is the system of record (users, channels, messages, files, notifications). Redis has three separate jobs: it is the Socket.IO adapter's pub/sub backbone (so broadcasts reach every server instance, not just the one that received the event), it stores presence state (who is online right now), and it backs the rate limiters. No message body or file ever lives only in Redis: Redis can be flushed and the app loses nothing durable.

![Architecture diagram](docs/architecture.svg)

Why one process instead of separate "chat service" / "api service" services: at this scale a split adds deployment complexity without a real benefit. REST and realtime share the same auth, the same database pool, and mostly the same business logic (sending a message touches Postgres either way). The Redis adapter is what lets this scale horizontally later without a rewrite; see [Scaling notes](#scaling-notes).

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| HTTP framework | Express | Minimal, well understood, easy to read |
| Realtime | Socket.IO | WebSocket with automatic fallback, rooms, and acknowledgement callbacks out of the box |
| Durable storage | PostgreSQL (`pg`) | Relational data (users/channels/messages) with real foreign keys |
| Ephemeral state | Redis (`ioredis`) | Presence, pub/sub fan-out, rate-limit counters: things that should not survive a restart as "truth" |
| Auth | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`) | Stateless access tokens; refresh tokens are DB-backed so logout can actually revoke a session |
| Rate limiting | `rate-limiter-flexible` (Redis store) | Same limiter implementation works for REST middleware and socket event handlers |
| File uploads | `multer` | Streams multipart uploads to disk without loading the whole file into memory |

The backend is plain JavaScript (no build step), so `node src/server.js` is always enough to run it. The frontend is plain HTML/CSS/JS with no bundler, loading the Socket.IO client from the backend (`/socket.io/socket.io.js`); open `index.html` through any static file server and it works.

## Data model

```
users ──< channel_members >── channels ──< messages >── attachments
  │                                              │
  └──────────────────< notifications >───────────┘
```

- `channels.type`: `public` (anyone can self-join), `private` (invite only, no self-join endpoint), `dm` (exactly two members, created via `POST /api/channels/dm`, reused if one already exists between the pair).
- Every new user is auto-joined to a shared `general` public channel on registration, so two freshly registered accounts always have somewhere to talk immediately.
- `messages.deleted_at` / `edited_at` exist in the schema for soft-delete and edit history, but no route uses them yet (see [Known limitations](#known-limitations)).
- All IDs are UUIDs generated in the application (`uuid` package), not left to Postgres defaults, so every row's ID is known before the INSERT runs.

Full schema: `backend/src/db/schema.sql`.

## Real-time message flow

1. Client emits `message:send` with `{ channelId, content, attachment? }`.
2. Server checks the per-user Redis rate limit, then verifies channel membership against Postgres (never trusting the socket's room list alone).
3. The message is inserted into Postgres. If an attachment was included, the server claims the matching row in `uploads` (must be owned by this user and not already attached to another message) and inserts the `attachments` row, all in one transaction, so a rejected attachment never leaves a stray message behind. See [File sharing](#file-sharing).
4. Server broadcasts `message:new` to the `channel:{id}` room. With the Redis adapter this reaches members connected to any server instance.
5. Server acks the sender directly with the persisted message (so the UI can reconcile an optimistic send).
6. Notification creation runs after the broadcast and is fire-and-forget (errors are logged, never block the send): a slow notification insert never delays delivery to people already watching the channel.

REST (`GET /api/messages/:channelId`) is used only for the initial history load and pagination; Socket.IO is used only for live push. Mixing the two on one endpoint makes both harder to reason about.

**Handler registration order matters and is deliberate.** In `sockets/index.js`, `message:send` and the other event listeners are attached *before* the awaits that join rooms and register presence, not after, even though "set the socket up, then register its handlers" reads more naturally. The client's `connect` event fires as soon as the transport handshake completes, not once this server-side setup finishes. Registering handlers after those awaits leaves a window where a message sent immediately on connect has no listener yet and is silently dropped: no error, the ack callback just never fires. This was found by testing against two real socket connections, not by code review, which is why `backend/test/integration.test.js` exists as more than a formality.

## Presence

Presence is tracked in Redis, not in memory on the Node process, so a server restart is invisible to users (sockets just reconnect and re-register) and so it works correctly with multiple server instances.

- Key: `presence:sockets:{userId}` → a Redis SET of socket IDs. A user is "online" while this set is non-empty. Using a set instead of a boolean means opening the app in two tabs, or on a phone and a laptop at once, doesn't flicker the status as one tab closes.
- `addSocket` / `removeSocket` use small Lua scripts so the "was this the transition from 0→1 (or 1→0) sockets" check is atomic: two tabs connecting in the same millisecond can't both fire a duplicate "online" event.
- On a real online/offline transition, the change is published once to a `presence:events` Redis channel. Every server process subscribes to that channel and is the only place presence broadcasts happen; `addSocket`/`removeSocket` never emit to sockets directly. Behavior is identical whether there is one server instance or ten behind a load balancer.
- That fan-out uses `io.local.to(...)`, not `io.to(...)`, and the difference is not cosmetic. Redis pub/sub already delivers each `presence:events` message to every process, so every process runs the handler. A plain `io.to(...)` would hand the emit to the Socket.IO Redis adapter, which re-broadcasts it cluster-wide, so with N instances each client would receive N copies of the same `presence:update`, and the "who shares a channel with this user" SQL join would run N times per event. `io.local` keeps each process emitting only to its own sockets.
- A user's presence is only broadcast to people who share a channel with them (a SQL join, not "everyone"), and on connect a client gets a `presence:snapshot` with the current status of everyone relevant, so the UI never starts from a blank slate.
- **Going offline is debounced, going online isn't.** When the last socket closes, the actual publish is delayed by `PRESENCE_OFFLINE_GRACE_MS` (default 5s) and only happens if the socket set is still empty when the timer fires, re-checked against the live set rather than a flag captured when the timer was scheduled, so a reconnect landing on a different server instance is still caught. Coming back online publishes immediately: a spurious early "online" costs nothing, while a spurious early "offline" is exactly the flicker this exists to prevent.

## Notifications

A notification row is written per recipient whenever a message lands in a channel they belong to, except for members who are currently looking at that exact channel (tracked client-side via a `channel:active` event, stored server-side as `socket.data.activeChannelId`, checked with `io.in(room).fetchSockets()` so it works across server instances too). If the recipient has a live connection, the notification is also pushed instantly over `notification:new`; if not, they'll see it in `GET /api/notifications` next time they connect.

## Rate limiting

Four independently configured limiters, all backed by the same Redis instance, keyed by user ID where the user is known and by IP otherwise:

| Limiter | Default | Applies to |
|---|---|---|
| Login | 10 / 15 min | `POST /api/auth/login`, slows brute-force guessing |
| Messages | 30 / min | the `message:send` socket event |
| Uploads | 20 / min | `POST /api/files/upload` |
| General | 300 / 15 min | every `/api/*` route, as a coarse baseline |

All four are configurable via environment variables (see `.env.example`).

The general limiter is mounted before any router, which is also before the `authenticate` middleware each router applies, so on its own it could only ever see an IP, and every request from one office NAT or VPN exit would share a single 300-request quota. It therefore runs behind `authenticate.optional`, which populates `req.user` from a valid bearer token and does nothing at all without one. A missing or invalid token is not an error there: routes that genuinely require auth still mount the strict `authenticate` themselves, so this can't weaken one.

## Redis outage behaviour

Redis backs three things in this app (the Socket.IO adapter, presence, and rate limiting) and holds nothing that isn't reconstructible elsewhere, so the guiding rule for all three is: **degrade, don't block.** A Redis outage should never stop someone from sending or receiving a message.

- **Rate limiting fails open.** `rate-limiter-flexible` rejects `.consume()` with a plain `RateLimiterRes` object when a limit is genuinely exceeded, and with a real `Error` when it can't reach its Redis store. Both `middleware/rateLimiter.js` (REST) and `sockets/message.handler.js` (the `message:send` limiter) check `instanceof Error` to tell these apart, log a warning, and let the request or message through on the latter. Failing closed would mean a Redis blip stops all chat traffic over something that isn't even chat's source of truth.
- **Presence degrades independently of messaging.** In `sockets/index.js`, joining a socket's channel rooms and setting up presence (`addSocket`/`getStatuses`/`presence:snapshot`) are two separate try/catch blocks, so an outage during the presence step can never prevent the channel joins that let messaging work. A socket that connects mid-outage still gets exactly one `presence:snapshot`, just an empty one, since the frontend expects one per connection and treats its absence as still-loading rather than nobody's-online.
- **Presence self-heals via `reconcile()`.** An `addSocket`/`removeSocket` call that throws partway through an outage can leave a `presence:sockets:{userId}` set out of sync with who's actually connected. `services/presence.service.js` exports `reconcile(io)`, which treats Socket.IO's own connected-socket list as ground truth and corrects Redis to match, including re-publishing an online event for any user it finds connected but missing from Redis. `sockets/index.js` calls it three times: once at startup, once every time the main Redis client emits `'ready'` (which fires on every reconnect, not just the first connect), and once every `PRESENCE_RECONCILE_INTERVAL_MS` (default 30s) as a catch-all.
- **Health endpoint.** `GET /health` reports Redis's connection state (`"redis": "up"` or `"down"`) alongside the existing ok/uptime fields, read from the ioredis client's own `.status` property rather than an active PING, since a round-trip to a possibly-down Redis has no business on a health check's response path. `ok` reflects only whether the Node process is alive; it deliberately doesn't flip to false when Redis is down, since the app is still doing useful work (messaging, history, auth) in that state, and a healthcheck-triggered restart wouldn't fix an external Redis outage anyway.

**Open items** (documented rather than glossed over):

- A user who connects mid-outage receives an empty `presence:snapshot`, and nothing re-sends a corrected one once Redis recovers. They pick up everyone else's real status as each person's status next changes. Closing this fully would need either a Postgres-querying dependency in `reconcile()` or per-socket retry listeners with their own cleanup, judged not worth the complexity for a narrow, self-resolving edge case.
- The Redis adapter's same-instance behaviour during an outage is the working assumption (delivery to sockets on the same instance doesn't depend on the publish succeeding, which matters since the project runs one instance via Docker Compose). It is queued for direct verification in [CHECKLIST.md](CHECKLIST.md), step 6, and should be confirmed the moment more than one instance is in play.

## File sharing

Upload is a plain REST call (`POST /api/files/upload`, multipart). Splitting it from message send keeps large, slow uploads off the realtime path entirely: the socket event only ever carries a small JSON payload, never file bytes. The extension is checked against an allow-list before the file touches disk (images, PDFs, common office/text formats, zip; notably not `.svg`, since unlike a raster image an SVG can carry embedded JS that would execute in this server's origin if a recipient opened the attachment link directly).

A successful upload writes an ownership row to `uploads` (`id`, `owner_id`, plus the file metadata) and returns that `id` to the client alongside the display metadata. `message:send` trusts only that id: it atomically claims the row (`UPDATE uploads SET message_id = ... WHERE id = $1 AND owner_id = $2 AND message_id IS NULL`) rather than trusting whatever `fileName`/`fileUrl`/`mimeType` the client sends alongside it. Without this, any authenticated user could fabricate an attachment object in the socket payload and have it broadcast as if it were a real, owned upload, including pointing `fileUrl` at a file they never uploaded. The `owner_id` check stops a cross-user claim; the `message_id IS NULL` check stops the same upload being attached to two messages (a race two near-simultaneous sends could otherwise hit).

Files are stored on local disk under `backend/uploads/`, served statically at `/uploads/...` with no per-request authorization. Access control is the file's UUID-based path being unguessable (122 bits of randomness), not membership of the channel it was shared in. This is a deliberate trade-off: the frontend loads attachments as plain `<img src>`/`<a href>`, which can't carry an `Authorization` header, so real per-request auth would mean moving to signed, expiring URLs, a bigger change than this project's scope justifies. Worth knowing if this code is reused somewhere the channel structure itself must stay confidential. See [Known limitations](#known-limitations) for what else changes at multi-instance scale.

## REST API reference

All routes except `/health` and `/api/auth/*` require `Authorization: Bearer <accessToken>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create account, auto-join #general |
| POST | `/api/auth/login` | Rate-limited login |
| POST | `/api/auth/refresh` | Exchange a refresh token for a new access token |
| POST | `/api/auth/logout` | Revoke a refresh token |
| GET | `/api/users/me` | Current user profile |
| GET | `/api/users?q=` | Search users, includes live presence status |
| GET | `/api/channels` | Channels the caller belongs to |
| GET | `/api/channels/discover` | Public channels the caller hasn't joined |
| POST | `/api/channels` | Create a public/private channel |
| POST | `/api/channels/dm` | Start or reuse a DM with another user |
| POST | `/api/channels/:id/join` | Self-join a public channel |
| GET | `/api/channels/:id/members` | List members of a channel |
| GET | `/api/messages/:channelId` | Paginated history (`?before=&limit=`) |
| POST | `/api/messages/:channelId/read` | Mark a channel read |
| POST | `/api/files/upload` | Upload an attachment |
| GET | `/api/notifications` | List recent notifications |
| POST | `/api/notifications/:id/read` | Mark one read |
| POST | `/api/notifications/read-all` | Mark all read |

## Socket.IO event reference

Connect with `io(url, { auth: { token: accessToken } })`.

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `channel:join` | client → server | `channelId`, ack | Join the room for a channel added after connecting |
| `channel:active` | client → server | `channelId` | Tell the server which channel is currently open (drives notification suppression) |
| `message:send` | client → server | `{ channelId, content?, attachment? }`, ack | Send a message |
| `typing:start/stop` | client → server | `channelId` | Typing indicator |
| `presence:query` | client → server | `userId[]`, ack | One-off presence lookup |
| `auth:refresh` | client → server | `{ accessToken }`, ack | Re-authenticate before the current access token expires; see [Socket auth lifecycle](#socket-auth-lifecycle) |
| `message:new` | server → client | message object | New message in a joined channel |
| `presence:snapshot` | server → client | `{ userId: status }` | Sent once right after connecting |
| `presence:update` | server → client | `{ userId, status, lastSeen? }` | Live presence change |
| `typing:update` | server → client | `{ userId, username, channelId, isTyping }` | Typing indicator update |
| `notification:new` | server → client | notification object | Pushed live if the recipient is connected |
| `user:new` | server → client | `{ id, username }` | A new account registered |
| `channel:added` | server → client | channel object | Added to a channel by someone else's action (e.g. a new DM) |
| `auth:expired` | server → client | `{ reason }` | Sent just before the server disconnects the socket for a token/reauth failure |

## Socket auth lifecycle

An access token is normally checked only once, at handshake (`io.use(socketAuth)` verifies it and the connection stays open from there). Left alone, a socket would stay fully privileged for as long as the connection stays up, including past the access token's own 15-minute expiry, and past a logout that revoked the user's refresh token (which a still-live stateless access token doesn't check against).

`sockets/reauth.handler.js` bounds that instead of leaving it open-ended:

1. At handshake, the token's `exp` is stored on `socket.data.tokenExp` and a timer is scheduled for that moment.
2. The client schedules its own refresh from that same `exp`, reading the claim out of the JWT it already holds (no signature check; it only decides *when* to refresh, and the server still verifies for real). It fires once 60% of the remaining lifetime has elapsed. Deriving the delay from the token, instead of a hardcoded interval, means the mechanism holds at any `JWT_ACCESS_EXPIRES_IN`: a 15-minute token refreshes at 9 minutes and a 20-second one at 12 seconds.
3. The client calls `auth:refresh` with a freshly issued access token before the timer fires. On success the timer is rescheduled against the new token's `exp`.
4. The refreshed token must decode to the same user this socket already authenticated as. A different (even genuinely valid) user's token is rejected, since accepting it would let a socket already joined to the first user's rooms silently become someone else.
5. If the timer fires, or `auth:refresh` is called with an invalid, expired or wrong-user token, the server emits `auth:expired` and disconnects.

This is a bound on the problem, not a full fix. Since access tokens are stateless JWTs, there's no way to revoke one individually mid-lifetime, so a logged-out user's socket can still outlive the logout by up to one access-token lifetime (≤15 minutes) if they don't reconnect. Closing that last gap would mean either checking a Redis revocation list on every socket event (turning access tokens back into something closer to session tokens) or shortening `JWT_ACCESS_EXPIRES_IN`. Neither is implemented, since 15 minutes is already a fairly tight bound for a project this size.

## Deployment topology (as verified)

The stack was deployed on a real VPS (2026-09-29) to confirm it runs outside a development machine. It was a verification deployment, not a maintained production service.

```
Browser -HTTPS-> Cloudflare (proxied) -> Cloudflare Tunnel (cloudflared on the VPS)
  -> nginx :80 --+-- /                        static files from frontend/
                 +-- /api /uploads /health -> 127.0.0.1:4100 --+
                 +-- /socket.io/ (upgrade) -> 127.0.0.1:4100 --+-> backend container :4000
                                                 backend -> postgres, redis (compose network)
```

**Checked on the server:** all three containers start healthy under Docker Compose; `GET /health` returns `"ok":true` with `"redis":"up"`; the site opens over HTTPS in a browser; two accounts register and land in `#general`; messages flow between them.

**Design of the deployment**

- **Why a tunnel.** The VPS only accepts inbound connections on its SSH port, so ports 80/443 are not reachable from the internet. The tunnel connects outward from the server; its ingress rule hands the hostname to nginx on port 80, which serves the frontend and proxies the API and WebSocket paths.
- **Same-origin frontend.** nginx serves the frontend and the API from one origin. Two frontend lines were changed on the server only and are not in this repository: `API_BASE` in `frontend/js/api.js` became `window.location.origin`, and the Socket.IO `<script>` in `frontend/index.html` became the relative path `/socket.io/socket.io.js`. The repository keeps `http://localhost:4000` in both places so local development works unchanged.
- **Ports.** The backend is published on `127.0.0.1:4100` only (host port 4000 was already used by another service on that machine); Postgres and Redis are bound to loopback as well.
- **Production settings.** `NODE_ENV=production`, newly generated JWT secrets and database password, `CLIENT_ORIGIN` set to the site's own origin instead of `*`, and `restart: unless-stopped` on all three services. Docker, nginx and cloudflared are enabled at boot.

**Queued for the server environment:** the 49-check integration suite, the typing / presence / DM / file-upload / rate-limit browser checks, the Redis-outage check, and a real reboot test (boot-time services are enabled but a reboot has not been exercised). Also open: confirming how client IPs are seen behind nginx and the tunnel, i.e. whether the backend trusts the proxy's forwarded address. Until that is confirmed, the IP-keyed limiters (login, and any request without a valid token) may see every client as one address.

## Scaling notes

The Redis adapter solves cross-instance broadcast (an emit on server A reaching a socket connected to server B). It does not solve routing a client's own HTTP requests to a consistent instance: Socket.IO's underlying transport can fall back to HTTP long-polling, whose successive requests must land on the same server process. Running more than one instance behind a load balancer therefore still wants either sticky sessions (session affinity by cookie or IP hash) or `transports: ['websocket']` forced on both client and server to skip polling entirely.

## Known limitations

Written down deliberately: these are reasonable scope decisions for a project of this size.

- **"Actively viewing" is per open channel, not per tab focus.** A user with the tab open but not focused still counts as viewing and won't get a notification for that channel.
- **CORS defaults to any origin** (`CLIENT_ORIGIN=*`) so the Quick Start works out of the box. It is environment-driven (see `.env.example`), so it's a deployment-time setting rather than a code change; the test deployment set it to the site's own origin.
- **Socket re-authentication has one remaining edge**: a logged-out socket can outlive the logout by up to one access-token lifetime. See [Socket auth lifecycle](#socket-auth-lifecycle).
- **Refresh tokens don't rotate.** The same refresh token stays valid (DB-checked, hash-compared, revocable via logout) until its own 7-day expiry. This is a standard, secure pattern as long as revocation-on-logout is honored, which it is, but it lacks the stronger guarantee of rotating tokens with reuse detection.
- **No message edit/delete endpoints**, even though the schema has `edited_at`/`deleted_at` columns ready for them.
- **File storage is local disk**, fine for one instance (or the bundled Docker Compose setup, via a shared volume) but would need to move to S3-compatible object storage for a multi-instance deployment where any instance might serve any request.
- **Graceful shutdown closes sockets explicitly.** `httpServer.close()` alone waits for open connections to end, and a live WebSocket never does, so SIGTERM used to hang until Docker's kill timeout SIGKILLed the process and skipped Redis cleanup. `io.close()` now runs first, followed by the Redis clients and the Postgres pool, with a 10-second backstop.
- **Automated coverage is integration-level**, not unit-level. `backend/test/integration.test.js` runs against the real stack end to end (real Postgres, real Redis, two real JWT-authenticated socket connections, no mocks), which is what caught the handler-ordering bug described above. There is no unit-test layer isolating individual functions, and purely visual correctness is still a manual pass; see [CHECKLIST.md](CHECKLIST.md).
