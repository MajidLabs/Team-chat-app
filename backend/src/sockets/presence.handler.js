const presenceService = require('../services/presence.service');

module.exports = function registerPresenceHandlers(io, socket) {
  socket.on('presence:query', async (userIds, callback) => {
    try {
      const ids = Array.isArray(userIds) ? userIds.slice(0, 200) : [];
      const statuses = await presenceService.getStatuses(ids);
      callback?.({ ok: true, statuses });
    } catch (err) {
      callback?.({ ok: false, error: 'Failed to fetch presence' });
    }
  });
};
