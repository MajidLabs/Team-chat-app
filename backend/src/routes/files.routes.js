const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const createRateLimiter = require('../middleware/rateLimiter');
const asyncHandler = require('../utils/asyncHandler');
const env = require('../config/env');

const router = express.Router();
router.use(authenticate);

const uploadDir = path.join(process.cwd(), env.uploadDir);
fs.mkdirSync(uploadDir, { recursive: true });

// Deliberately excludes anything scriptable or executable - notably .svg,
// which (unlike raster images) can carry embedded JS that would run in this
// server's origin if a recipient opened it directly via the attachment
// link, same as .html/.js would.
const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.pdf', '.txt', '.csv', '.md',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    const err = new Error(`File type ${ext || '(none)'} is not allowed`);
    err.status = 400;
    err.expose = true;
    return cb(err);
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: env.maxFileSizeMb * 1024 * 1024 },
});

// Translates multer's own errors (oversized file, etc.) and the fileFilter
// rejection above into clean, safe-to-show 4xx responses instead of letting
// them fall through to the generic 500 handler.
function handleUploadErrors(next) {
  return (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      err.status = 413;
      err.expose = true;
      err.message = `File exceeds the ${env.maxFileSizeMb}MB limit`;
    }
    next(err);
  };
}

const uploadLimiter = createRateLimiter({
  keyPrefix: 'rl:upload',
  points: env.rateLimit.uploadsPerMin,
  duration: 60,
});

// The file is uploaded on its own first; the returned metadata is then
// attached to a message via the 'message:send' socket event. This keeps
// the (slow, size-limited) upload off the realtime path entirely.
//
// The `id` in the response is what message:send will actually trust later -
// see message.handler.js. The rest of the fields are echoed back purely so
// the UI can show a preview before the message is sent.
router.post(
  '/upload',
  uploadLimiter,
  (req, res, next) => upload.single('file')(req, res, handleUploadErrors(next)),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const uploadId = uuidv4();
    const fileUrl = `/${env.uploadDir}/${req.file.filename}`;
    await pool.query(
      `INSERT INTO uploads (id, owner_id, file_name, file_url, mime_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, req.user.id, req.file.originalname, fileUrl, req.file.mimetype, req.file.size]
    );

    res.status(201).json({
      id: uploadId,
      fileName: req.file.originalname,
      fileUrl,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
    });
  })
);

module.exports = router;
