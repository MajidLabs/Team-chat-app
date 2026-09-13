const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const app = require('./app');
const env = require('./config/env');
const { adapterPubClient, adapterSubClient } = require('./config/redis');
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

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down');
  httpServer.close(() => process.exit(0));
});
