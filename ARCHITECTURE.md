# Architecture

## Overview

A single Node.js/Express process serves both a REST API and a Socket.IO realtime
layer. PostgreSQL is the system of record (users, channels, messages, files,
notifications). Redis has three separate jobs: it is the Socket.IO adapter's
pub/sub backbone (so broadcasts reach every server instance, not just the one
that received the event), it stores presence state (who is online right now),
and it backs the rate limiters. No message body or file ever lives only in
Redis - Redis can be flushed and the app loses nothing durable.

![Architecture diagram: two browsers connect over REST and WebSocket to a Node.js/Express server, which splits into a REST API and a Socket.IO layer, backed by PostgreSQL for durable storage and Redis for the Socket.IO adapter, presence, and rate limiting](docs/architecture.svg)

Why one process instead of separate "chat service" / "api service" services:
at this scale a split adds deployment complexity without a real benefit -
REST and realtime share the same auth, the same database pool, and mostly
the same business logic (e.g. sending a message touches Postgres either
way). The Redis adapter is what makes this able to scale horizontally later
without a rewrite - see "Scaling" below.

## Tech stack

| Concern         | Choice                                   | Why |
|------------------|-------------------------------------------|-----|
| HTTP framework   | Express                                    | Minimal, well understood, easy to read |
| Realtime         | Socket.IO                                  | WebSocket with automatic fallback, rooms, and acknowledgement callbacks out of the box |
| Durable storage  | PostgreSQL (`pg`)                          | Relational data (users/channels/messages) with real foreign keys |
| Ephemeral state  | Redis (`ioredis`)                          | Presence, pub/sub fan-out, rate-limit counters - all things that should *not* survive a restart as "truth" |
| Auth             | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`) | Stateless access tokens; refresh tokens are DB-backed so logout can actually revoke a session |
| Rate limiting    | `rate-limiter-flexible` (Redis store)      | Same limiter implementation works for REST middleware and socket event handlers |
| File uploads     | `multer`                                   | Streams multipart uploads to disk without loading the whole file into memory |

The backend is plain JavaScript (no build step) so `node src/server.js` is
always enough to run it. The frontend is plain HTML/CSS/JS with no bundler,
loading `socket.io-client` from a CDN - open `index.html` through any static
file server and it works.

## Data model

```
users ──< channel_members >── channels ──< messages >── attachments
  │                                              │
  └──────────────────< notifications >───────────┘
```

- **channels.type**: `public` (anyone can self-join), `private` (invite
  only - no self-join endpoint), `dm` (exactly two members, created via
  `POST /api/channels/dm`, reused if one already exists between the pair).
- Every new user is auto-joined to a shared `general` public channel on
  registration, so two freshly registered accounts always have somewhere to
  talk immediately - no setup steps needed to test realtime messaging.
- `messages.deleted_at` / `edited_at` exist in the schema for soft-delete and
  edit history, but no route uses them yet (see "Known limitations").
- All IDs are UUIDs generated in the application (`uuid` package), not left
  to Postgres defaults, so every row's ID is known before the `INSERT` runs.

Full schema: [`backend/src/db/schema.sql`](backend/src/db/schema.sql).

## Real-time message flow

1. Client emits `message:send` with `{ channelId, content, attachment? }`.
2. Server checks the per-user Redis rate limit, then verifies channel
   membership against Postgres (never trust the socket's room list alone).
3. Message is inserted into Postgres. If an `attachment` was included, the
   server claims the matching row in `uploads` (must be owned by this user
   and not already attached to another message) and inserts the
   `attachments` row - all three in one transaction, so a rejected
   attachment never leaves a stray message behind. See "File sharing" below
   for why the attachment is looked up server-side rather than trusted from
   the client payload.
4. Server broadcasts `message:new` to the `channel:{id}` room. With the Redis
   adapter this reaches members connected to *any* server instance.
5. Server acks the sender directly with the persisted message (so the UI can
   reconcile an optimistic send).
6. Notification creation runs *after* the broadcast and is fire-and-forget
   (errors are logged, never block the send) - a slow notification insert
   should never delay message delivery to people already watching the
   channel.

REST (`GET /api/messages/:channelId`) is used only for the initial history
load and pagination; Socket.IO is used only for live push. Mixing the two on
one endpoint makes both harder to reason about.

**Handler registration order matters and is deliberate.** In
`sockets/index.js`, `message:send` and the other event listeners are
attached *before* the `await`s that join rooms and register presence -
not after, even though "set the socket up, then register its handlers"
reads more naturally. The client's `connect` event fires as soon as the
transport handshake completes, not once this server-side setup finishes;
registering handlers after those `await`s leaves a window where a message
sent immediately on connect has no listener yet and is silently dropped -
no error, the ack callback just never fires. This was found by testing
against two real socket connections, not by code review, which is part of
why [`backend/test/integration.test.js`](backend/test/integration.test.js)
exists as more than a formality.

## Presence

Presence is tracked in Redis, not in memory on the Node process, so it
survives a server restart being invisible to users (a restart just means
sockets reconnect and re-register) and so it works correctly with multiple
server instances.

- Key: `presence:sockets:{userId}` → a Redis **SET** of socket IDs.
- A user is "online" while this set is non-empty. Using a set instead of a
  boolean means opening the app in two tabs, or on a phone and a laptop at
  once, doesn't flicker the status between online/offline as one tab closes.
- `addSocket` / `removeSocket` use small Lua scripts so the
  "was this the transition from 0→1 (or 1→0) sockets" check is atomic - two
  tabs connecting in the same millisecond can't both fire a duplicate
  "online" event.
- On a real online/offline transition, the change is published once to a
  `presence:events` Redis channel. Every server process subscribes to that
  channel and is the *only* place presence broadcasts happen - `addSocket`/
  `removeSocket` never emit to sockets directly. This means behavior is
  identical whether there is one server instance or ten behind a load
  balancer.
- A user's presence is only broadcast to people who share a channel with
  them (a SQL join, not "everyone"), and on connect a client gets a
  `presence:snapshot` with the current status of everyone relevant, so the
  UI never starts from a blank slate.
- **Going offline is debounced, going online isn't.** When the last socket
  closes, the actual publish is delayed by `PRESENCE_OFFLINE_GRACE_MS`
  (default 5s) and only happens if the socket set is *still* empty when
  the timer fires - re-checked against the live set, not a flag captured
  when the timer was scheduled, so a reconnect landing on a different
  server instance is still caught correctly. Coming back online publishes
  immediately: there's no symmetric reason to delay it, since a spurious
  early "online" costs nothing (the observer's UI was already showing
  online or is about to), while a spurious early "offline" is exactly the
  flicker this exists to prevent.

## Notifications

A notification row is written per recipient whenever a message lands in a
channel they belong to, *except* for members who are currently looking at
that exact channel (tracked client-side via a `channel:active` event, stored
server-side as `socket.data.activeChannelId`, checked with
`io.in(room).fetchSockets()` so it works across server instances too). If the
recipient has a live connection, the notification is also pushed instantly
over `notification:new`; if not, they'll see it in `GET /api/notifications`
next time they connect.

## Rate limiting

Four independently configured limiters, all backed by the same Redis
instance, keyed by user ID where the user is known and by IP otherwise:

| Limiter    | Default          | Applies to |
|------------|-------------------|------------|
| Login      | 10 / 15 min       | `POST /api/auth/login` - slows brute-force guessing |
| Messages   | 30 / min          | the `message:send` socket event |
| Uploads    | 20 / min          | `POST /api/files/upload` |
| General    | 300 / 15 min      | every `/api/*` route, as a coarse baseline |

All four are configurable via environment variables (see `.env.example`).

## Redis outage behaviour

Redis backs three things in this app (the Socket.IO adapter, presence, and
rate limiting - see "Overview") and holds nothing that isn't reconstructible
elsewhere, so the guiding rule for all three is: degrade, don't block. A
Redis outage should never stop someone from sending or receiving a message.

- **Rate limiting fails open.** `rate-limiter-flexible` rejects a call to
  `.consume()` with a plain `RateLimiterRes` object when a limit is
  genuinely exceeded, and with a real `Error` when it can't reach its
  Redis store. Both `middleware/rateLimiter.js` (REST) and
  `sockets/message.handler.js` (the `message:send` limiter) check
  `instanceof Error` to tell these apart, log a warning, and let the
  request or message through on the latter. Failing closed instead would
  mean a Redis blip stops all chat traffic over something that isn't even
  chat's source of truth.
- **Presence degrades independently of messaging.** In `sockets/index.js`,
  joining a socket's channel rooms and setting up presence
  (`addSocket`/`getStatuses`/`presence:snapshot`) are two separate
  `try`/`catch` blocks, specifically so an outage during the presence step
  can never prevent the channel joins that actually let messaging work. A
  socket that connects mid-outage still gets exactly one
  `presence:snapshot` - just an empty one, since the frontend expects one
  per connection and treats its absence as still-loading rather than
  nobody's-online.
- **Presence self-heals via `reconcile()`.** An `addSocket`/`removeSocket`
  call that throws partway through an outage can leave a
  `presence:sockets:{userId}` Redis set out of sync with who's actually
  connected. `services/presence.service.js` exports `reconcile(io)`, which
  treats Socket.IO's own connected-socket list as ground truth and
  corrects Redis to match it - including re-publishing an online event for
  any user it finds connected but missing from Redis, so everyone who
  shares a channel with them picks it up live. `sockets/index.js` calls it
  three times: once at startup, once every time the main Redis client
  emits `'ready'` (which fires on every reconnect, not just the first
  connect), and once every `PRESENCE_RECONCILE_INTERVAL_MS` (default 30s)
  as a catch-all.
  - **Known gap:** this fixes what *other* users see about someone who
    connected mid-outage, but not the reverse - that user's own
    `presence:snapshot` was already sent (empty) by the time Redis
    recovers, and nothing re-sends them a corrected one. They'll pick up
    everyone else's real status only once each person's status next
    actually changes. Closing this fully would mean either giving
    `reconcile()` a Postgres-querying dependency it otherwise doesn't
    need (to rebuild a snapshot per affected user), or per-socket retry
    listeners with their own cleanup - judged not worth the added
    complexity for a narrow, self-resolving edge case.
- **`GET /health` reports Redis's connection state** (`"redis": "up"` or
  `"down"`) alongside the existing `ok`/`uptime` fields, read from the
  `ioredis` client's own `.status` property rather than an active `PING` -
  a round-trip to a possibly-down Redis has no business sitting on a
  health check's response path. `ok` itself reflects only whether the
  Node process is alive; it deliberately doesn't flip to `false` when
  Redis is down, since the app is still doing useful work (messaging,
  history, auth) in that state, and a healthcheck-triggered restart
  wouldn't fix an external Redis outage anyway.
- **The Redis adapter's same-instance behaviour is expected, not yet
  verified against a real outage** - see `CHECKLIST.md`, step 6.
  `@socket.io/redis-adapter` publishes to Redis so *other* server
  instances receive a broadcast; the working assumption is that delivery
  to sockets on the *same* instance doesn't depend on that publish
  succeeding, since this project only ever runs one instance via Docker
  Compose. Worth confirming directly the moment more than one instance is
  ever in play, rather than taken on faith.

## File sharing

Upload is a plain REST call (`POST /api/files/upload`, multipart). Splitting
it from message send keeps large, slow uploads off the realtime path
entirely - the socket event only ever carries a small JSON payload, never
file bytes. Extension is checked against an allow-list before the file
touches disk (images, PDFs, common office/text formats, zip; notably not
`.svg` - unlike a raster image, an SVG can carry embedded JS that would
execute in this server's origin if a recipient opened the attachment link
directly).

A successful upload writes an ownership row to `uploads` (`id`, `owner_id`,
plus the file metadata) and returns that `id` to the client alongside the
display metadata. `message:send` trusts only that `id`: it atomically
claims the row (`UPDATE uploads SET message_id = ... WHERE id = $1 AND
owner_id = $2 AND message_id IS NULL`) rather than trusting whatever
`fileName`/`fileUrl`/`mimeType` the client sends alongside it. Without this,
any authenticated user could fabricate an `attachment` object in the
socket payload and have it broadcast as if it were a real, owned upload -
including pointing `fileUrl` at a file they never uploaded. The `owner_id`
check and the `message_id IS NULL` check both matter: the first stops a
cross-user claim, the second stops the same upload being attached to two
messages (a race two near-simultaneous sends could otherwise hit).

Files are stored on local disk under `backend/uploads/`, served statically
at `/uploads/...` with **no per-request authorization** - access control is
the file's UUID-based path being unguessable (122 bits of randomness),
not membership of the channel it was shared in. This is a deliberate
trade-off, not an oversight: the frontend loads attachments as plain
`<img src>`/`<a href>`, which can't carry an `Authorization` header, so
real per-request auth would mean moving to signed, expiring URLs - a
bigger change than this project's scope justifies. Worth knowing if this
code is reused somewhere the channel structure itself needs to stay
confidential, not just casually undiscoverable. See "Known limitations"
for what else changes at multi-instance scale.

## REST API reference

All routes except `/health` and `/api/auth/*` require
`Authorization: Bearer <accessToken>`.

| Method | Path                          | Purpose |
|--------|-------------------------------|---------|
| POST   | `/api/auth/register`          | Create account, auto-join `#general` |
| POST   | `/api/auth/login`              | Rate-limited login |
| POST   | `/api/auth/refresh`            | Exchange a refresh token for a new access token |
| POST   | `/api/auth/logout`             | Revoke a refresh token |
| GET    | `/api/users/me`                 | Current user profile |
| GET    | `/api/users?q=`                 | Search users, includes live presence status |
| GET    | `/api/channels`                 | Channels the caller belongs to |
| GET    | `/api/channels/discover`        | Public channels the caller hasn't joined |
| POST   | `/api/channels`                 | Create a public/private channel |
| POST   | `/api/channels/dm`              | Start or reuse a DM with another user |
| POST   | `/api/channels/:id/join`        | Self-join a public channel |
| GET    | `/api/channels/:id/members`     | List members of a channel |
| GET    | `/api/messages/:channelId`      | Paginated history (`?before=&limit=`) |
| POST   | `/api/messages/:channelId/read` | Mark a channel read |
| POST   | `/api/files/upload`             | Upload an attachment |
| GET    | `/api/notifications`            | List recent notifications |
| POST   | `/api/notifications/:id/read`   | Mark one read |
| POST   | `/api/notifications/read-all`   | Mark all read |

## Socket.IO event reference

Connect with `io(url, { auth: { token: accessToken } })`.

| Event               | Direction       | Payload | Purpose |
|----------------------|-----------------|---------|---------|
| `channel:join`       | client → server | `channelId`, ack | Join the room for a channel added after connecting |
| `channel:active`     | client → server | `channelId`       | Tell the server which channel is currently open (drives notification suppression) |
| `message:send`       | client → server | `{ channelId, content?, attachment? }`, ack | Send a message |
| `typing:start/stop`  | client → server | `channelId`       | Typing indicator |
| `presence:query`     | client → server | `userId[]`, ack   | One-off presence lookup |
| `auth:refresh`       | client → server | `{ accessToken }`, ack | Re-authenticate before the current access token expires - see "Socket auth lifecycle" below |
| `message:new`        | server → client | message object    | New message in a joined channel |
| `presence:snapshot`  | server → client | `{ userId: status }` | Sent once right after connecting |
| `presence:update`    | server → client | `{ userId, status, lastSeen? }` | Live presence change |
| `typing:update`      | server → client | `{ userId, username, channelId, isTyping }` | |
| `notification:new`   | server → client | notification object | Pushed live if the recipient is connected |
| `user:new`           | server → client | `{ id, username }` | A new account registered |
| `channel:added`      | server → client | channel object     | Added to a channel by someone else's action (e.g. a new DM) |
| `auth:expired`       | server → client | `{ reason }`       | Sent just before the server disconnects the socket for a token/reauth failure |

## Socket auth lifecycle

An access token is only checked once, at handshake - `io.use(socketAuth)`
verifies it and the connection stays open from there. Left alone, that
means a socket would stay fully privileged for as long as the connection
stays up, including past the access token's own 15-minute expiry, and past
a logout that revoked the user's refresh token (which a still-live access
token doesn't check against, being a stateless JWT).

`sockets/reauth.handler.js` bounds that instead of leaving it open-ended:

- At handshake, the token's `exp` is stored on `socket.data.tokenExp` and a
  timer is scheduled for that moment.
- The client is expected to call `auth:refresh` with a freshly-issued
  access token before the timer fires. On success the timer is
  rescheduled against the new token's `exp`.
- The refreshed token must decode to the *same* user this socket already
  authenticated as - a different (even genuinely valid) user's token is
  rejected, since accepting it would let a socket already joined to that
  first user's rooms silently become someone else.
- If the timer fires, or `auth:refresh` is called with an invalid/expired/
  wrong-user token, the server emits `auth:expired` and disconnects.

This is a bound on the problem, not a full fix: since access tokens are
stateless JWTs, there's no way to revoke one individually mid-lifetime, so
a logged-out user's socket can still outlive the logout by up to one
access-token lifetime (≤15 minutes) if they don't reconnect. Closing that
last gap would mean either short-circuiting access tokens through a Redis
revocation check on every socket event (turning them back into something
closer to session tokens) or shortening `JWT_ACCESS_EXPIRES_IN` - both
real options, neither implemented here since 15 minutes is already a fairly
tight bound for a project this size.

## Scaling notes

The Redis adapter solves cross-instance **broadcast** (an `emit` on server A
reaching a socket connected to server B). It does *not* solve routing a
client's own HTTP requests to a consistent instance - Socket.IO's underlying
transport can fall back to HTTP long-polling, whose successive requests must
land on the same server process. Running more than one instance behind a
load balancer therefore still wants either sticky sessions (session affinity
by cookie or IP hash) or `transports: ['websocket']` forced on both client
and server to skip polling entirely.

## Known limitations

Written down honestly rather than glossed over - these are reasonable
simplifications for a project of this scope, not oversights hidden from the
reader:

- **"Actively viewing" only checks the currently open channel**, not browser
  tab focus/blur. A user with the tab open but not focused still counts as
  "viewing" and won't get a notification.
- **CORS defaults to allowing any origin** (`CLIENT_ORIGIN=*`), which is
  fine for local dev and is exactly what the Quick Start needs to work out
  of the box, but should be set to the real frontend origin for any
  production deployment. This is already environment-driven (see
  `.env.example`), so it's a deployment-time setting to change, not a code
  fix - flagged here so it isn't missed.
- **The frontend's backend URL is hardcoded**, unlike CORS above:
  `frontend/js/api.js` sets `API_BASE = 'http://localhost:4000'` directly in
  the source rather than reading it from anything environment-driven (the
  frontend is static files with no build step). Deploying anywhere other
  than local dev means editing that line by hand first.
- **Sockets now require periodic re-authentication** rather than staying
  privileged for the life of the connection - see "Socket auth lifecycle"
  above for the mechanism and its one remaining edge (a logged-out socket
  can still outlive the logout by up to one access-token lifetime).
- **Refresh tokens don't rotate.** The same refresh token stays valid
  (DB-checked, hash-compared, revocable via logout) until its own 7-day
  expiry rather than being replaced on every use. This is a standard,
  secure pattern as long as revocation-on-logout is honored, which it is -
  but it doesn't give the stronger guarantee that rotating refresh tokens
  with reuse-detection would (catching a stolen-but-not-yet-used token the
  moment both the attacker and the legitimate user try to use it).
- **No message edit/delete endpoints**, even though the schema has
  `edited_at`/`deleted_at` columns ready for them.
- **File storage is local disk**, which is fine for one instance (or the
  bundled Docker Compose setup, via a shared volume) but would need to move
  to S3-compatible object storage for a multi-instance deployment where any
  instance might serve any request.
- **Automated coverage is integration-level, not unit-level.**
  [`backend/test/integration.test.js`](backend/test/integration.test.js) runs
  against the real stack end to end (real Postgres, real Redis, two real
  JWT-authenticated socket connections, no mocks), which is what caught the
  handler-ordering bug above - but there's no unit-test layer isolating
  individual functions, and purely visual correctness (does the UI actually
  look right) is still a manual pass - see [`CHECKLIST.md`](CHECKLIST.md).
