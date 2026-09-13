# Health Checklist

A repeatable way to confirm the project actually works - right after cloning
it, or after you've changed something. Two parts: automated checks you run
once, then a short manual pass for the realtime behavior a script can't
easily see for you (a message actually appearing in a second browser window
with no refresh).

## What changed since the last full pass

Security/data-integrity audit + part of the auth-lifecycle/reliability pass:
attachment-ownership verification (rejects a forged, reused, or another
user's upload id), authorization on the channel-members endpoint, an
upload extension allow-list, hardened error responses, database-level
fixes for the DM-creation and registration race conditions, a socket
re-authentication lifecycle, and a presence offline debounce. All of it is
covered by step 3 below except where step 4 says otherwise. Redis-outage
behavior (fail-open rate limiting, presence degrading independently of
messaging, and a self-healing reconcile pass - see `ARCHITECTURE.md`,
"Redis outage behaviour") has since been implemented and is covered by the
new manual check in step 6, not yet run against a real outage. Still open:
a dedicated pass on notification-concurrency edge cases.

## 0. Prerequisites

- [ ] `node -v` reports 20 or higher
- [ ] PostgreSQL is running and reachable
- [ ] Redis is running and reachable (`redis-cli ping` → `PONG`)

## 1. Install and migrate

```bash
cd backend
npm install
npm run migrate
```

- [ ] `npm install` completes with no errors (`npm audit` should report 0
      vulnerabilities on a fresh install)
- [ ] `npm run migrate` prints `schema applied successfully`

If migration fails with `permission denied for schema public`, the database
user doesn't have `CREATE` rights on the `public` schema - see the exact fix
in [`README.md`](README.md#manual-setup-no-docker) (PostgreSQL 15+ stopped
granting this by default).

## 2. Boot

```bash
npm start
```

- [ ] Console prints `[server] listening on port 4000` with no stack traces
- [ ] `curl http://localhost:4000/health` returns `{"ok":true,...}`

## 3. Automated integration check

With the server still running, in a **second terminal**:

```bash
cd backend
npm run test:integration
```

- [ ] Every line prints `PASS`
- [ ] The summary line reports all checks passed, and the process exits 0

This single run exercises: registration and duplicate rejection, auto-join
to `#general`, two independent JWT-authenticated socket connections,
rejection of a bad token, the presence snapshot plus live online/offline
updates (including the offline debounce not flickering on a quick
reconnect), realtime message delivery, message persistence and history
retrieval, typing indicators, DM creation with a live `channel:added`
notification and its race-safety under concurrent requests, notification
push *and* suppression while actively viewing a channel, file upload
(including rejecting a disallowed extension) with static serving and
attachment delivery, attachment-ownership enforcement (a forged, reused, or
another user's upload id is rejected), unauthorized channel-membership
listing being rejected, socket-layer and REST-layer rate limiting, the
socket re-authentication lifecycle (a successful reauth, a bad or
cross-user token, and auto-disconnect on real token expiry), and the
refresh/logout token lifecycle. If anything regresses, this is usually the
fastest way to find out exactly what broke.

## 4. Manual two-browser check (realtime UI)

```bash
cd frontend
python3 -m http.server 5500
```

Open `http://localhost:5500` in two separate browser windows (or one normal
+ one private/incognito window, so they don't share `localStorage`).

- [ ] Registering an account in each window succeeds; both land in `#general`
- [ ] A message typed in window A appears in window B with no refresh
- [ ] Typing (without sending) in window A shows "... is typing" in window B
- [ ] Closing window A flips their status dot to offline in window B after
      roughly 5 seconds (`PRESENCE_OFFLINE_GRACE_MS`) - not instantly. This
      delay is deliberate: it absorbs brief drops (a sleeping laptop, a
      flaky wifi blip) so status doesn't flicker offline-then-online for a
      reconnect that happens within the grace window.
- [ ] Clicking a username under "People" opens a DM that appears live in
      the other window's channel list
- [ ] Attaching a file shows an inline preview/link in both windows
- [ ] Attaching a disallowed file type (rename any file to `.exe` before
      selecting it) shows a clear rejection instead of uploading
- [ ] Sending messages faster than the configured rate limit eventually
      returns a "Rate limit exceeded" error instead of sending

## 4a. Optional: socket re-authentication (longer than the rest of this pass)

The frontend re-authenticates each socket automatically every 10 minutes,
well ahead of the access token's 15-minute expiry (see `ARCHITECTURE.md`,
"Socket auth lifecycle"). Skippable for a quick pass; worth doing once to
actually see it rather than take it on faith:

- [ ] Leave a browser window open and idle for >15 minutes, then send a
      message. It should still work - the socket should never have
      silently disconnected in the meantime.
- [x] Faster version: temporarily set `JWT_ACCESS_EXPIRES_IN=20s` in
      `.env`, restart the backend, and confirm the frontend still works
      well past 20 seconds without dropping. Revert the env change
      afterward.

## 5. Docker Compose path (if you use it)

```bash
docker compose up --build
```

- [ ] All three containers start with no restart loops
- [ ] The `postgres` container's log shows the schema being applied on
      first boot
- [ ] Steps 2-4 above pass the same way against the containerized backend

## 6. Redis outage behaviour (manual)

Confirms the app degrades instead of breaking when Redis drops - see
`ARCHITECTURE.md`, "Redis outage behaviour" for what each of these is
supposed to do and why. Needs the Docker Compose stack from step 5 up and
the two browser windows from step 4 already connected.

```bash
docker compose stop redis
```

- [ ] A message typed in window A still appears in window B with no
      refresh (same-instance delivery doesn't depend on the Redis
      adapter's publish succeeding - this project only ever runs one
      instance)
- [ ] Sending well past the configured rate limit no longer returns "Rate
      limit exceeded" - messages keep sending instead (fail-open, not a
      bug)
- [ ] Opening the app in a **third**, freshly registered window still
      connects and loads its channels normally - it just shows nobody's
      online/offline status (an empty `presence:snapshot`), since Redis is
      down
- [ ] `curl http://localhost:4000/health` still returns `200`, with
      `"ok":true` and `"redis":"down"`
- [ ] The backend log shows `[redis:*] error` lines, not a crash or a
      restart loop

Bring Redis back:

```bash
docker compose start redis
```

- [ ] The backend log shows `[redis:main] reconnecting...` then
      `[redis:main] ready` within a few seconds
- [ ] `curl http://localhost:4000/health` shows `"redis":"up"` again
- [ ] Windows A and B see the third window come online within a few
      seconds, with no refresh (the background reconcile pass catches the
      socket Redis never heard about, and publishes it as a normal online
      event)

Known gap, not a bug to chase: the third window itself won't retroactively
learn that A and B were online the whole time - it only got an empty
snapshot at connect time, and nothing re-sends it a corrected one. It'll
catch up once each person's status next actually changes (e.g. one of them
reconnects). See `ARCHITECTURE.md` for why this is left as-is.
