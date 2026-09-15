# Fixes applied

Seven issues, all found by reading the code against its own documentation.
Each one is described below as: what was wrong, why it mattered, what changed.

---

## 1. Socket.IO client loaded from a public CDN

**File:** `frontend/index.html`

The page pulled `socket.io.min.js` from `cdn.socket.io`. When that request
failed - blocked, throttled, or just slow - `io` stayed undefined. The first
thing to touch it was `connectSocket()`, called immediately after
login/registration, so it threw there and the UI was left looking logged in
but with an empty channel list and nothing in the console a user would
recognise. A refresh sometimes fixed it, which made it look intermittent.

Now loaded from `http://localhost:4000/socket.io/socket.io.js` - Socket.IO
serves its own matching client. The script can now only fail if the backend
is down, which the UI already reports, and client/server versions can no
longer drift apart.

## 2. No guard for a missing Socket.IO client

**File:** `frontend/js/socket.js`

Related to #1 but separate: even with the CDN fixed, nothing checked. Added
an explicit `typeof io === 'undefined'` check in `connectSocket()` that logs
and alerts with the actual reason instead of throwing `io is not defined`.

The emit helpers (`sendMessage`, `joinChannelRoom`, etc.) also called
`socket.emit` unconditionally. They now route through one `emit()` wrapper
that fires any ack callback with `{ ok: false }` rather than leaving the
caller waiting forever.

## 3. Socket re-authentication assumed a 15-minute token

**Files:** `frontend/js/socket.js`, `ARCHITECTURE.md`, `CHECKLIST.md`

The client refreshed on a hardcoded `setInterval` of 10 minutes. That only
works if `JWT_ACCESS_EXPIRES_IN` is 15m. With anything shorter, the server's
expiry timer fired first, the socket was disconnected, and
`handleAuthExpired()` silently reconnected it - on a loop, invisibly.

This is also why `CHECKLIST.md` step 4a's "faster version" (set the token to
20s, confirm it works past 20 seconds without dropping) was ticked despite
being unpassable: from the UI it *looked* fine, because the reconnect was
silent.

The client now reads the `exp` claim out of the token it already holds and
refreshes once 60% of the remaining lifetime has elapsed - 9 minutes for a
15m token, 12 seconds for a 20s one. The JWT signature is not verified
client-side, and doesn't need to be: this only decides *when* to refresh, and
the server verifies for real on every handshake and every `auth:refresh`.

`setInterval` also became a self-rearming `setTimeout`, so each refresh is
scheduled against the new token rather than the original one.

**Checklist 4a has been un-ticked.** The fix is in, but it has not been run
in a real browser, and marking it passed on that basis would repeat the
original mistake.

## 4. Presence broadcast duplicated once per server instance

**File:** `backend/src/sockets/index.js`

Redis pub/sub delivers each `presence:events` message to every server
process, so every process ran the handler. Each then called
`io.to(user:{id}).emit(...)`, which hands the emit to the Socket.IO Redis
adapter - which re-broadcasts it cluster-wide.

So with N instances, every client received N copies of each
`presence:update`, and the "who shares a channel with this user" SQL join ran
N times per event. The comment directly above the code claimed behaviour was
"identical whether there's one server instance or several". It wasn't.

Changed to `io.local.to(...)`, which restricts the emit to sockets on this
process. The cross-instance fan-out is already handled by the
`presence:events` subscription itself.

*No visible effect on the current single-instance Docker Compose setup.* It
matters the moment a second instance exists - which is the scenario the
architecture is explicitly written for.

## 5. App-wide rate limiter could never key by user

**Files:** `backend/src/app.js`, `backend/src/middleware/auth.js`

`rateLimiter.js` keys on `req.user ? req.user.id : req.ip`. But the general
limiter is mounted on `/api` *before* any router, and `authenticate` lives
inside each router - so `req.user` was always undefined and every request
fell back to IP.

Practical effect: everyone behind a single office NAT or VPN exit shared one
300-request budget.

Added `authenticate.optional` - same token check, but a missing or invalid
token just leaves `req.user` unset instead of returning 401 - and mounted it
in front of the limiter. Routes that actually require auth still mount the
strict `authenticate` themselves, so nothing is weakened.

## 6. Two of the four rate limiters were not configurable

**Files:** `backend/src/config/env.js`, `backend/src/app.js`,
`backend/src/routes/files.routes.js`, `backend/.env.example`

`ARCHITECTURE.md` stated all four limiters were environment-driven. Only two
were. The upload limiter (`points: 20`) and the general limiter
(`points: 300`) were hardcoded, and neither appeared in `.env.example`.

Added `RATE_LIMIT_UPLOADS_PER_MIN` and `RATE_LIMIT_GENERAL_PER_15MIN`, with
the previous values as defaults so behaviour is unchanged out of the box.

Also added `PRESENCE_RECONCILE_INTERVAL_MS` to `.env.example` - `env.js` was
already reading it, but it was undocumented.

## 7. SIGTERM hung until Docker force-killed the process

**File:** `backend/src/server.js`

Shutdown called only `httpServer.close()`. That stops new connections but
waits for existing ones to finish - and a live WebSocket never finishes on
its own. So every `docker compose down` sat until the 10-second kill timeout
and then took a SIGKILL, which also meant Redis clients were never closed and
the disconnect handlers never ran.

Shutdown now closes Socket.IO first (`io.close()`), then the HTTP server, then
all five Redis clients and the Postgres pool. Additions: `SIGINT` is handled
too (Ctrl-C in local dev), a re-entry guard, a 10-second backstop that
force-exits rather than hanging indefinitely, and a 250ms grace period so
in-flight `removeSocket` writes land before Redis is closed. Anything still
missed is corrected by presence `reconcile()` on the next boot.

## 8. Rate limit charged before payload validation

**File:** `backend/src/sockets/message.handler.js`

`message:send` consumed a rate-limit token before checking that the payload
was valid. A buggy client sending malformed payloads could burn a real user's
30/min quota on requests the server did no work for. Validation now runs
first.

---

# Also corrected: my own earlier analysis

I previously reported that `presence.service.js`'s `reconcile()` was dead
code, never called. **That was wrong.** The files in the Project workspace
were an older snapshot than the repository. In the actual code, `reconcile()`
is wired in `sockets/index.js` with three triggers - at boot, on every Redis
`ready` event, and on an interval. Nothing needed fixing there.

I also flagged the upload limiter as possibly reading an undefined env value
and silently falling back to 4-requests-per-second. Also wrong - it was
hardcoded to 20/60. Still worth changing (see #6), but it was never broken.

The stale files were `sockets/index.js`, `config/redis.js`, `config/env.js`,
`app.js`, and `CHECKLIST.md`. Worth re-uploading them to the Project.

---

# Not changed

Things I noticed but left alone, since they're documented trade-offs rather
than defects:

- Uploads are served with no per-request authorization (unguessable UUID
  paths). `ARCHITECTURE.md` explains the reasoning and the limits.
- Refresh tokens don't rotate.
- `notifyChannelMembers` inserts sequentially, one round trip per recipient.
  Fine at this scale; would want batching at a larger one.
- No message edit/delete endpoints, despite the schema columns existing.

# Before you push

None of this has been run against a live stack - no Postgres or Redis here.
Syntax is checked on every file; behaviour is not. Worth doing first:

```bash
cd backend && npm run test:integration
```

Then `CHECKLIST.md` step 4, which is where fixes #1, #2 and #3 actually show
up. Step 4a is the one I un-ticked.
