const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const env = require('./config/env');
const { redis } = require('./config/redis');
const errorHandler = require('./middleware/errorHandler');
const createRateLimiter = require('./middleware/rateLimiter');

const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/users.routes');
const channelRoutes = require('./routes/channels.routes');
const messageRoutes = require('./routes/messages.routes');
const fileRoutes = require('./routes/files.routes');
const notificationRoutes = require('./routes/notifications.routes');

const app = express();

// crossOriginResourcePolicy is relaxed because the frontend is served from
// a different origin/port and needs to load images from /uploads directly.
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: env.clientOrigin }));
app.use(express.json());
app.use(`/${env.uploadDir}`, express.static(path.join(process.cwd(), env.uploadDir)));

// `ok`/`uptime` reflect only whether this Node process is alive. `redis` is
// read from the client's own connection-state property (no active PING) so
// a slow/down Redis can't add latency to a health check - see
// ARCHITECTURE.md, "Redis outage behaviour" for why `ok` deliberately
// doesn't flip to false just because Redis is down.
app.get('/health', (req, res) => res.json({
  ok: true,
  uptime: process.uptime(),
  redis: redis.status === 'ready' ? 'up' : 'down',
}));

// Coarse, IP-keyed baseline on top of the more specific per-user limiters
// applied inside individual routers (login, uploads, socket messages).
const generalLimiter = createRateLimiter({ keyPrefix: 'rl:general', points: 300, duration: 15 * 60 });
app.use('/api', generalLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/notifications', notificationRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
