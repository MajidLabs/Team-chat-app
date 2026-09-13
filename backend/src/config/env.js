require('dotenv').config();

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://chatuser:chatpass@localhost:5432/teamchat',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  clientOrigin: process.env.CLIENT_ORIGIN || '*',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10),
  rateLimit: {
    messagesPerMin: parseInt(process.env.RATE_LIMIT_MESSAGES_PER_MIN || '30', 10),
    loginPer15Min: parseInt(process.env.RATE_LIMIT_LOGIN_PER_15MIN || '10', 10),
  },
  presenceOfflineGraceMs: parseInt(process.env.PRESENCE_OFFLINE_GRACE_MS || '5000', 10),
  presenceReconcileIntervalMs: parseInt(process.env.PRESENCE_RECONCILE_INTERVAL_MS || '30000', 10),
};
