const { verifyAccessToken } = require('../services/token.service');

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing access token' });

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Same token check, but a missing or bad token is not an error - it just
// leaves req.user unset. Used in front of the app-wide rate limiter, which
// runs before any router (and therefore before `authenticate`) and would
// otherwise never see a user: every authenticated request fell back to
// being keyed by IP, so everyone behind one office NAT or VPN shared a
// single quota. Anything that actually requires auth still mounts
// `authenticate` itself, so this never weakens a route.
function optionalAuthenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, username: payload.username };
  } catch (err) {
    // Deliberately ignored - an invalid token just means this request stays
    // IP-keyed. Rejecting here would turn the rate limiter into a second,
    // surprising auth gate on routes that are meant to be public.
  }
  next();
}

module.exports = authenticate;
module.exports.optional = optionalAuthenticate;
