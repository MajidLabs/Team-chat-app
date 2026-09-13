const { verifyAccessToken } = require('../services/token.service');

// Access tokens are stateless JWTs verified only once, at handshake - so
// without this, a connected socket would stay fully privileged for the
// entire connection, including past the access token's own 15-minute
// expiry, and past a logout that revoked the user's refresh token (which
// a still-live access token doesn't check against). This bounds that
// window instead of leaving it open indefinitely: the socket is
// disconnected unless the client proactively re-authenticates with a
// fresh access token before the current one expires. It's a bound, not a
// full fix - a logged-out user's socket can still outlive the logout by up
// to one access-token lifetime, since access tokens aren't individually
// revocable. See ARCHITECTURE.md.
module.exports = function registerReauthHandlers(io, socket) {
  let timer = null;

  function expireNow(reason) {
    socket.emit('auth:expired', { reason });
    socket.disconnect(true);
  }

  function scheduleExpiry(expSeconds) {
    if (timer) clearTimeout(timer);
    const msUntilExpiry = expSeconds * 1000 - Date.now();
    // A negative delay fires on the next tick, which is exactly right for
    // a token that was already expired the moment this got scheduled.
    timer = setTimeout(() => expireNow('Access token expired without re-authentication'), Math.max(msUntilExpiry, 0));
  }

  scheduleExpiry(socket.data.tokenExp);

  socket.on('auth:refresh', (payload, callback) => {
    const token = typeof payload === 'string' ? payload : payload?.accessToken;
    if (!token) return callback?.({ ok: false, error: 'accessToken is required' });

    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch {
      callback?.({ ok: false, error: 'Invalid or expired token' });
      return expireNow('Re-authentication token is invalid or expired');
    }

    // Must be the same user this socket already authenticated as at
    // handshake - otherwise this would be a way to swap an already-
    // room-joined socket's identity out from under it.
    if (decoded.sub !== socket.data.userId) {
      callback?.({ ok: false, error: 'Token does not match this connection' });
      return expireNow('Re-authentication token does not match this connection');
    }

    socket.data.tokenExp = decoded.exp;
    scheduleExpiry(decoded.exp);
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => {
    if (timer) clearTimeout(timer);
  });
};
