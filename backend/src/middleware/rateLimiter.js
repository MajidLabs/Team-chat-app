const { RateLimiterRedis } = require('rate-limiter-flexible');
const { redis } = require('../config/redis');

// Factory: each call site gets its own limiter (own keyPrefix, own quota).
// Keyed by authenticated user id when available, falling back to IP for
// anonymous endpoints like login.
function createRateLimiter({ keyPrefix, points, duration }) {
  const limiter = new RateLimiterRedis({ storeClient: redis, keyPrefix, points, duration });

  return async function rateLimitMiddleware(req, res, next) {
    const key = req.user ? req.user.id : req.ip;

    if (redis.status !== 'ready') {
      return next();
    }

    try {
      await limiter.consume(key);
      next();
    } catch (rejRes) {
      if (rejRes instanceof Error) {
        console.error(`[rateLimiter:${keyPrefix}] Redis unavailable, failing open:`, rejRes.message);
        return next();
      }
      const retryAfterSec = Math.ceil((rejRes.msBeforeNext || 1000) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: 'Too many requests, slow down.' });
    }
  };
}

module.exports = createRateLimiter;