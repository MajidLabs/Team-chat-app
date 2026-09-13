const { verifyAccessToken } = require('../services/token.service');

module.exports = function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const payload = verifyAccessToken(token);
    // Stored under socket.data (not directly on the socket) because that's
    // the only part of a socket that survives io.fetchSockets() when the
    // socket lives on a different server instance behind the Redis adapter.
    socket.data.userId = payload.sub;
    socket.data.username = payload.username;
    socket.data.tokenExp = payload.exp;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
};
