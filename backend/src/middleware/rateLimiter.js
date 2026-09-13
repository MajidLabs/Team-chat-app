const { RateLimiterRedis } = require('rate-limiter-flexible');
const { redis } = require('../config/redis');

// Factory: each call site gets its own limiter (own keyPrefix, own quota).
// Keyed by authenticated user id when available, falling back to IP for
// anonymous endpoints like login.
function createRateLimiter({ keyPrefix, points, duration }) {
  const limiter = new RateLimiterRedis({ storeClient: redis, keyPrefix, points, duration });

  return async function rateLimitMiddleware(req, res, next) {
    const key = req.user ? req.user.id : req.ip;
    try {
      await limiter.consume(key);
      next();
    } catch (rejRes) {
      // rate-limiter-flexible rejects with an Error when Redis itself is
      // unreachable, and with a RateLimiterRes (plain result object, not
      // an Error) when the limit was genuinely exceeded. Fail open on the
      // former - Redis holds nothing durable in this app (ARCHITECTURE.md),
      // so losing rate-limiting during an outage beats losing the feature.
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
