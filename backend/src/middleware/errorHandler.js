function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  // Anything reaching this middleware is, by convention, an error nobody
  // upstream already turned into a clean 4xx response. Default to a generic
  // message so DB errors, library internals, or stack details never reach
  // the client - only opt in via err.expose when the message itself was
  // deliberately written to be safe and useful to show (e.g. a rejected
  // file type), never for anything caught from a lower layer.
  const message = err.expose && status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
