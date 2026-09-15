const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const app = require('./app');
const env = require('./config/env');
const pool = require('./config/db');
const {
  redis,
  adapterPubClient,
  adapterSubClient,
  presencePubClient,
  presenceSubClient,
} = require('./config/redis');
const initSockets = require('./sockets');

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: env.clientOrigin },
});

// Distributes broadcasts (io.to(room).emit(...)) across every server
// instance subscribed to Redis, so horizontal scaling is a config change,
// not a rewrite.
io.adapter(createAdapter(adapterPubClient, adapterSubClient));

// REST routes need to reach into Socket.IO occasionally (e.g. to push a
// 'user:new' event on registration), so it's exposed via app locals.
app.set('io', io);

initSockets(io);

httpServer.listen(env.port, () => {
  console.log(`[server] listening on port ${env.port} (${env.nodeEnv})`);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;

// `httpServer.close()` on its own is not enough and the failure is quiet:
// it stops accepting *new* connections but waits for existing ones to end,
// and a live WebSocket never ends on its own. Every `docker compose down`
// therefore sat until Docker's 10-second kill timeout and then SIGKILLed
// the process - which also meant Redis clients were never closed and the
// disconnect handlers never got to clear presence. `io.close()` closes the
// open sockets first, which lets the HTTP server actually finish.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);

  // Backstop: if any step below hangs, don't trade a 10s SIGKILL for an
  // indefinite one. unref() so this timer can't hold the process open by
  // itself once everything has closed cleanly.
  const forceExit = setTimeout(() => {
    console.error('[server] graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  try {
    await new Promise((resolve) => io.close(resolve));
    // io.close() closes the attached HTTP server too, so this is normally a
    // no-op; the callback's error is ignored deliberately rather than being
    // logged as a failure on a path that already succeeded.
    await new Promise((resolve) => httpServer.close(() => resolve()));

    // Each socket's 'disconnect' handler calls presenceService.removeSocket,
    // which is async and may still be in flight when io.close() returns.
    // A short grace period lets those Redis writes land instead of failing
    // against a client we're about to quit. Anything still missed is
    // corrected by presence reconcile() on the next boot.
    await sleep(250);

    await Promise.allSettled([
      redis.quit(),
      adapterPubClient.quit(),
      adapterSubClient.quit(),
      presencePubClient.quit(),
      presenceSubClient.quit(),
    ]);
    await pool.end();

    clearTimeout(forceExit);
    console.log('[server] shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[server] error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
