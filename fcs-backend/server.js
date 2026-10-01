// ============================================================
// server.js — Feeless Copyright Sounds Backend
// ============================================================
// Dependencies:
//   npm install express cors multer express-session bcrypt
//               connect-sqlite3 socket.io uuid dotenv
// ============================================================

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const multer     = require('multer');
const session    = require('express-session');
const bcrypt     = require('bcrypt');
const SQLiteStore = require('connect-sqlite3')(session);
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const NodeID3 = require('node-id3');
const ffmpeg = require('fluent-ffmpeg');

const app    = express();
const server = http.createServer(app);

// ============================================================
// ENVIRONMENT VARIABLES  (.env file — never commit this)
// ============================================================
// SESSION_SECRET=some_long_random_string_here
// ADMIN_USERNAME=your_admin_username
// ADMIN_PASSWORD_HASH=bcrypt_hash_of_your_password
// FRONTEND_URL=http://localhost:3000
// PORT=5000
// NODE_ENV=development
//
// To generate ADMIN_PASSWORD_HASH, run once in Node REPL:
//   const bcrypt = require('bcrypt');
//   console.log(bcrypt.hashSync('YourPasswordHere', 12));
// ============================================================

const {
  SESSION_SECRET    = 'change_this_secret_in_production',
  ADMIN_USERNAME    = 'admin',
  ADMIN_PASSWORD_HASH,
  FRONTEND_URL      = 'http://localhost:3000',
  PORT              = 5000,
  NODE_ENV          = 'development',
  VOLUME_BOOST_DB   = '4',
} = process.env;

// In development, accept requests from any device on the local network
// (e.g. a phone at http://192.168.x.x:3000) so the site can be tested
// on real devices, not just localhost. In production, only the exact
// configured FRONTEND_URL is allowed.
const corsOriginCheck = (origin, callback) => {
  if (!origin) return callback(null, true); // non-browser requests (curl, health checks, etc.)
  if (origin === FRONTEND_URL) return callback(null, true);
  if (NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):3000$/.test(origin)) {
    return callback(null, true);
  }
  return callback(new Error('Not allowed by CORS'));
};

// ============================================================
// DIRECTORY SETUP
// ============================================================
const UPLOADS_DIR   = path.join(__dirname, 'uploads');
const PROCESSED_DIR = path.join(__dirname, 'processed'); // converted/boosted files cache
const DB_DIR        = path.join(__dirname, 'data');
const SESSIONS_DIR  = path.join(__dirname, 'data', 'sessions');
const TRACKS_FILE   = path.join(DB_DIR, 'tracks.json');

[UPLOADS_DIR, PROCESSED_DIR, DB_DIR, SESSIONS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ============================================================
// TRACKS — Simple JSON file store
// (swap for a real DB in production)
// ============================================================
const loadTracks = () => {
  try {
    if (fs.existsSync(TRACKS_FILE)) {
      return JSON.parse(fs.readFileSync(TRACKS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to load tracks.json:', err);
  }
  return [];
};

const saveTracks = (tracks) => {
  fs.writeFileSync(TRACKS_FILE, JSON.stringify(tracks, null, 2));
};

let tracks = loadTracks();

// ============================================================
// USERS — Visitor accounts (Sign Up / Sign In)
// Completely separate from the single hardcoded admin account above.
// ============================================================
const USERS_FILE = path.join(DB_DIR, 'users.json');

const loadUsers = () => {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to load users.json:', err);
  }
  return [];
};

const saveUsers = (users) => {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
};

let users = loadUsers();

// Strips the password hash before a user object is ever sent to the browser
const sanitizeUser = (user) => {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
};

// ============================================================
// FEEDBACK — Per-track feedback submitted from the track page
// Same simple JSON file store as tracks/users above.
// ============================================================
const FEEDBACK_FILE = path.join(DB_DIR, 'feedback.json');

const loadFeedback = () => {
  try {
    if (fs.existsSync(FEEDBACK_FILE)) {
      return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to load feedback.json:', err);
  }
  return [];
};

const saveFeedback = (feedback) => {
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2));
};

let feedback = loadFeedback();

// ============================================================
// SOCKET.IO
// ============================================================
const io = new Server(server, {
  cors: {
    origin: corsOriginCheck,
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// ============================================================
// AUDIO FORMAT CONFIG + CONVERSION
// ============================================================
// ── Compression strategy per format ──────────────────────────────────────────
// MP3:  192 kbps VBR — high quality, ~40% smaller than 320 kbps (barely noticeable)
// WAV:  44100 Hz / 16-bit stereo (CD standard) — reduces size if source was 24-bit/48 kHz
// FLAC: Compression level 8 (maximum, still fully lossless) — 15–30% smaller than default
const FORMAT_CONFIG = {
  mp3:  { ext: 'mp3',  codec: 'libmp3lame', bitrate: '192k',  audioChannels: 2, sampleRate: 44100 },
  wav:  { ext: 'wav',  codec: 'pcm_s16le',                    audioChannels: 2, sampleRate: 44100 },
  flac: { ext: 'flac', codec: 'flac',        compressionLevel: 8, audioChannels: 2, sampleRate: 44100 },
};

// Converts the source MP3 into the target format and boosts volume by VOLUME_BOOST_DB.
// NOTE: Metadata (title/artist/cover) is intentionally NOT written here via ffmpeg's
// -metadata flag — passing values containing spaces (e.g. "dj siva") through ffmpeg's
// command-line args caused crashes ("Error opening output file siva"). Tags are instead
// embedded afterward using NodeID3 (see generateProcessedFile below), which is safe.
const processAudioFile = (inputPath, outputPath, format) => {
  return new Promise((resolve, reject) => {
    const config = FORMAT_CONFIG[format];
    let command = ffmpeg(inputPath)
      .audioFilters(`volume=${VOLUME_BOOST_DB}dB`)
      .audioCodec(config.codec)
      .audioChannels(config.audioChannels)
      .audioFrequency(config.sampleRate);

    // MP3: apply target bitrate for lossy compression
    if (config.bitrate) command = command.audioBitrate(config.bitrate);

    // FLAC: apply compression level 0–8 (8 = smallest file, still lossless)
    if (config.compressionLevel !== undefined) {
      command = command.outputOptions(['-compression_level', String(config.compressionLevel)]);
    }

    command
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
};

const getProcessedFilePath = (track, format) =>
  path.join(PROCESSED_DIR, `${track.id}.${FORMAT_CONFIG[format].ext}`);

// Generates (or re-generates) the boosted/converted file for a track + format.
const generateProcessedFile = async (track, format) => {
  const inputPath  = path.join(__dirname, track.audioUrl.replace(/^\//, ''));
  const outputPath = getProcessedFilePath(track, format);

  await processAudioFile(inputPath, outputPath, format);

  // MP3 gets full ID3 tags + embedded cover art written safely via NodeID3
  // (NodeID3 handles spaces in title/artist correctly — unlike ffmpeg's CLI args)
  if (format === 'mp3') {
    const coverPath = path.join(__dirname, track.cover.replace(/^\//, ''));
    embedID3Tags(outputPath, coverPath, {
      title:  track.title,
      artist: track.artist,
      genre:  track.genre,
    });
  }

  // WAV: strips ffmpeg's auto-inserted LIST chunk, writes our own CP1252-
  // encoded LIST INFO chunk (for Explorer/native Windows text display) plus
  // an id3 chunk with cover art (for VLC/foobar2000/etc).
  if (format === 'wav') {
    const dbCoverPath = path.join(__dirname, track.cover.replace(/^\//, ''));
    embedID3InWav(outputPath, dbCoverPath, inputPath, {
      title:  track.title,
      artist: track.artist,
      genre:  track.genre,
    });
  }

  return outputPath;
};

// Returns a cached processed file if it exists, otherwise generates it fresh.
// MP3: the cache is only trusted if it carries the '• [FCS-Release]' album
// tag — older cached MP3s from before this fix would otherwise be served
// forever, since they DO exist on disk.
// WAV always regenerates — guarantees the LIST-strip + CP1252 + hybrid-tag
// fix applies to every download, and no stale/corrupted .wav is ever served.
const getOrCreateProcessedFile = async (track, format) => {
  const outputPath = getProcessedFilePath(track, format);

  if (format === 'wav') return generateProcessedFile(track, format);

  if (format === 'mp3' && fs.existsSync(outputPath)) {
    try {
      const existingTags = NodeID3.read(outputPath);
      if (existingTags && existingTags.album === '• [FCS-Release]') {
        return outputPath;
      }
      console.warn(`[MP3 Cache] Stale tags on ${outputPath}, regenerating`);
    } catch (err) {
      console.warn(`[MP3 Cache] Could not read tags from ${outputPath}, regenerating:`, err.message);
    }
    return generateProcessedFile(track, format);
  }

  if (fs.existsSync(outputPath)) return outputPath;
  return generateProcessedFile(track, format);
};

// Deletes all cached processed versions of a track (called on edit/delete)
const clearProcessedFiles = (trackId) => {
  Object.values(FORMAT_CONFIG).forEach(({ ext }) => {
    const filePath = path.join(PROCESSED_DIR, `${trackId}.${ext}`);
    fs.unlink(filePath, () => {}); // ignore errors if file doesn't exist
  });
};

// ============================================================
// MIDDLEWARE
// ============================================================
// Must be set when running behind a reverse proxy (nginx/caddy)
if (NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(cors({
  origin: corsOriginCheck,
  credentials: true,           // Required for session cookies
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files (audio + cover art)
app.use('/uploads', express.static(UPLOADS_DIR));

// ============================================================
// SESSION MIDDLEWARE
// ============================================================
app.use(session({
  store: new SQLiteStore({
    dir: SESSIONS_DIR,
    db: 'sessions.db',
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,                          // JS cannot access cookie
    secure: NODE_ENV === 'production',       // HTTPS only in prod
    sameSite: NODE_ENV === 'production' ? 'strict' : 'lax',
    maxAge: 1000 * 60 * 60 * 8,             // 8 hours
  }
}));

// ============================================================
// MULTER — File Upload Config
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${uuidv4()}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedAudio = ['audio/mpeg', 'audio/mp3'];
  const allowedImage = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (
    (file.fieldname === 'audio' && allowedAudio.includes(file.mimetype)) ||
    (file.fieldname === 'cover' && allowedImage.includes(file.mimetype))
  ) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type for field "${file.fieldname}"`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max per file
});

// ============================================================
// AUTH GUARD MIDDLEWARE
// ============================================================
const requireAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Unauthorized' });
};

// Helper to delete a file from disk safely
const deleteFile = (filePath) => {
  if (!filePath) return;
  const absolute = path.join(__dirname, filePath.replace(/^\//, ''));
  fs.unlink(absolute, err => {
    if (err && err.code !== 'ENOENT') {
      console.error(`[File] Could not delete ${absolute}:`, err.message);
    }
  });
};

// Helper to embed ID3 tags (title, artist, cover art, etc.) into an MP3 file
// This makes the metadata show correctly in Windows Media Player, iTunes, etc.
//
// The '•' bullet is baked directly into the album STRING. ID3v2 (unlike the
// classic RIFF LIST INFO format used for WAV below) has proper Unicode text
// frame support, so UTF-8/UTF-16 characters like '•' render correctly here
// with no special handling needed.
const embedID3Tags = (audioPath, coverPath, tags) => {
  try {
    const id3Tags = {
      title:  `${tags.title || 'Unknown'} - ${tags.artist || 'Unknown'}`,
      artist: '',
      album:  '• [FCS-Release]',
      genre:  tags.genre  || '',
      year:   new Date().getFullYear().toString(),
      comment: {
        language: 'eng',
        text: `${tags.title} - ${tags.artist} [FCS-Release] | Feeless Copyright Sounds | Free Download at ${process.env.FRONTEND_URL || 'http://localhost:3000'}`
      }
    };

    if (coverPath && fs.existsSync(coverPath)) {
      const coverBuffer = fs.readFileSync(coverPath);
      const ext = path.extname(coverPath).toLowerCase();
      const mime =
        ext === '.png'  ? 'image/png'  :
        ext === '.webp' ? 'image/webp' :
        'image/jpeg';

      id3Tags.image = {
        mime,
        type: { id: 3, name: 'front cover' },
        description: 'Cover',
        imageBuffer: coverBuffer
      };
    }

    const success = NodeID3.write(id3Tags, audioPath);
    if (success) {
      console.log(`[ID3] Tags embedded: "${tags.title}" by ${tags.artist}`);
    } else {
      console.error(`[ID3] Failed to write tags to: ${audioPath}`);
    }
  } catch (err) {
    console.error('[ID3] Error embedding tags:', err.message);
  }
};

// Removes any 'LIST' sub-chunks from a RIFF/WAVE buffer.
// ffmpeg's WAV muxer unconditionally inserts its own 'LIST INFO' chunk
// (just an encoder tag, e.g. "Lavf60.16.100") into every WAV it produces,
// even with zero -metadata flags. We strip it so we can write our OWN
// clean LIST INFO chunk in its place — see embedID3InWav below.
const stripListChunks = (wavData) => {
  const parts = [wavData.slice(0, 12)]; // keep 'RIFF' + size + 'WAVE'
  let off = 12;
  while (off < wavData.length - 8) {
    const id     = wavData.toString('ascii', off, off + 4);
    const size   = wavData.readUInt32LE(off + 4);
    const padded = size % 2 !== 0;
    const chunkTotal = 8 + size + (padded ? 1 : 0);
    if (id !== 'LIST') {
      parts.push(wavData.slice(off, off + chunkTotal));
    }
    off += chunkTotal;
  }
  const result = Buffer.concat(parts);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
};

// Encodes a string for a RIFF LIST INFO field using Windows CP1252 (ANSI),
// NOT UTF-8.
//
// The classic RIFF INFO chunk format predates Unicode and has no declared
// encoding — Windows Explorer and the built-in Media Player app read its
// text using the system ANSI codepage (CP1252 on US/Western installs), not
// UTF-8. If we write '•' as UTF-8 (3 bytes: 0xE2 0x80 0xA2), Windows reads
// those same 3 bytes back as 3 separate CP1252 characters — producing the
// mojibake "â€¢" instead of "•". CP1252 has a native single-byte bullet at
// 0x95, so we substitute that byte directly. Every other character in our
// tag text is plain ASCII, which is byte-identical in both encodings.
const toAnsiBuffer = (str) => {
  const bytes = [];
  for (const ch of str) {
    if (ch === '•') {
      bytes.push(0x95); // CP1252 bullet
    } else {
      const code = ch.charCodeAt(0);
      bytes.push(code <= 0xff ? code : 0x3f); // '?' fallback for anything else non-Latin1
    }
  }
  return Buffer.from(bytes);
};

// Builds a single RIFF LIST/INFO sub-chunk (4-byte ID + 4-byte LE size +
// null-terminated ANSI/CP1252 string, padded to an even length).
const makeInfoSubChunk = (id, value) => {
  if (!value) return Buffer.alloc(0);
  const textBytes = toAnsiBuffer(value);
  const data = Buffer.concat([textBytes, Buffer.from([0x00])]);
  const pad  = data.length % 2 !== 0 ? 1 : 0;
  const buf  = Buffer.alloc(8 + data.length + pad, 0);
  buf.write(id, 0, 'ascii');
  buf.writeUInt32LE(data.length, 4);
  data.copy(buf, 8);
  return buf;
};

// Embeds metadata into a WAV file using a HYBRID approach — this exists
// because of a hard platform limitation confirmed empirically:
//
//   - Windows Explorer's Properties panel and the built-in Windows 11
//     "Media Player" app read TEXT metadata from a RIFF 'LIST INFO' chunk,
//     encoded as CP1252 (see toAnsiBuffer above). They do NOT recognize an
//     'id3 ' chunk for text at all.
//   - Cover art is only supported via the 'id3 ' chunk's APIC frame —
//     confirmed working in VLC/foobar2000/etc.
//   - When both chunk types are present, Windows' own built-in Media Player
//     app reads text from LIST but ignores id3 (so cover art won't show
//     THERE specifically) — a Windows platform gap, not fixable server-side.
//
// So we write BOTH: our own clean LIST INFO chunk (title/album/genre) for
// native Windows text-tag compatibility, AND an id3 chunk with full tags +
// cover art for every other player that supports it.
const embedID3InWav = (wavPath, dbCoverPath, sourcePath, tags) => {
  try {
    let wavData = fs.readFileSync(wavPath);

    if (
      wavData.length < 12 ||
      wavData.toString('ascii', 0, 4) !== 'RIFF' ||
      wavData.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      console.error(`[WAV Meta] Not a valid RIFF/WAVE file: ${wavPath}`);
      return;
    }

    const beforeLen = wavData.length;
    wavData = stripListChunks(wavData);
    if (wavData.length !== beforeLen) {
      console.log(`[WAV Meta] Stripped ffmpeg's auto-inserted LIST chunk (${beforeLen - wavData.length} bytes)`);
    }

    const titleStr   = `${tags.title || 'Unknown'} - ${tags.artist || 'Unknown'}`;
    const albumStr   = '• [FCS-Release]';
    const commentStr = `${tags.title} - ${tags.artist} [FCS-Release] | Feeless Copyright Sounds | Free Download at ${process.env.FRONTEND_URL || 'http://localhost:3000'}`;
    const yearStr    = new Date().getFullYear().toString();

    // ── Our own LIST INFO chunk, CP1252-encoded (Explorer + native Windows text) ──
    const infoSubChunks = Buffer.concat([
      makeInfoSubChunk('INAM', titleStr),
      makeInfoSubChunk('IPRD', albumStr),
      makeInfoSubChunk('IGNR', tags.genre || ''),
      makeInfoSubChunk('ICMT', commentStr),
      makeInfoSubChunk('ICRD', yearStr),
    ]);
    const listPayloadSize = 4 + infoSubChunks.length;
    const listChunk = Buffer.alloc(8 + listPayloadSize, 0);
    listChunk.write('LIST', 0, 'ascii');
    listChunk.writeUInt32LE(listPayloadSize, 4);
    listChunk.write('INFO', 8, 'ascii');
    infoSubChunks.copy(listChunk, 12);

    // ── Resolve cover art (DB path first, then source-audio fallback) ──
    let imageObj = null;

    if (dbCoverPath && fs.existsSync(dbCoverPath)) {
      const ext = path.extname(dbCoverPath).toLowerCase();
      imageObj  = {
        mime:        ext === '.png'  ? 'image/png'  :
                     ext === '.webp' ? 'image/webp' :
                     'image/jpeg',
        type:        { id: 3, name: 'front cover' },
        description: 'Cover',
        imageBuffer: fs.readFileSync(dbCoverPath),
      };
      console.log(`[WAV Meta] Cover from DB path: ${dbCoverPath}`);
    }

    if (!imageObj && sourcePath && fs.existsSync(sourcePath)) {
      console.warn(`[WAV Meta] DB cover not found at "${dbCoverPath}", reading from source audio`);
      const srcTags = NodeID3.read(sourcePath);
      if (srcTags && srcTags.image && srcTags.image.imageBuffer) {
        imageObj = {
          mime:        srcTags.image.mime || 'image/jpeg',
          type:        { id: 3, name: 'front cover' },
          description: 'Cover',
          imageBuffer: srcTags.image.imageBuffer,
        };
        console.log(`[WAV Meta] Cover extracted from source audio: ${sourcePath}`);
      } else {
        console.warn(`[WAV Meta] No embedded cover found in source audio: ${sourcePath}`);
      }
    }

    if (!imageObj) {
      console.warn(`[WAV Meta] Proceeding without cover art for "${tags.title}"`);
    }

    // ── id3 chunk (cover art + full tags, proper Unicode — for VLC/foobar2000/etc) ──
    const id3TagsObj = {
      title:   titleStr,
      artist:  '',
      album:   albumStr,
      genre:   tags.genre || '',
      year:    yearStr,
      comment: { language: 'eng', text: commentStr },
    };
    if (imageObj) id3TagsObj.image = imageObj;

    const id3Buffer = NodeID3.create(id3TagsObj);
    const dataSize  = id3Buffer.length;
    const needsPad  = dataSize % 2 !== 0;
    const id3Chunk  = Buffer.alloc(8 + dataSize + (needsPad ? 1 : 0), 0);
    id3Chunk.write('id3 ', 0, 'ascii');
    id3Chunk.writeUInt32LE(dataSize, 4);
    id3Buffer.copy(id3Chunk, 8);

    const newWav = Buffer.concat([wavData, listChunk, id3Chunk]);
    newWav.writeUInt32LE(newWav.length - 8, 4);

    fs.writeFileSync(wavPath, newWav);
    console.log(`[WAV Meta] LIST INFO + id3 chunk written: "${tags.title}" — cover embedded: ${!!imageObj}`);
  } catch (err) {
    console.error('[WAV Meta] Error:', err.message);
    console.error(err.stack);
  }
};

// ============================================================
// ROUTES — ADMIN AUTH
// ============================================================

// POST /api/admin/login
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  if (username !== ADMIN_USERNAME) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  if (!ADMIN_PASSWORD_HASH) {
    console.error('[Auth] ADMIN_PASSWORD_HASH not set in .env');
    return res.status(500).json({ success: false, error: 'Server misconfiguration' });
  }

  const match = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!match) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  // Regenerate session ID on privilege escalation (session fixation protection)
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ success: false, error: 'Session error' });
    req.session.isAdmin = true;
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ success: false, error: 'Session save error' });
      console.log(`[Auth] Admin logged in from ${req.ip}`);
      res.json({ success: true });
    });
  });
});

// POST /api/admin/logout
app.post('/api/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false, error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// GET /api/admin/session — called on app load to restore session state
app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isAdmin === true) });
});

// ============================================================
// ROUTES — VISITOR AUTH (Sign Up / Sign In)
// For regular site visitors creating their own accounts —
// completely independent from the single admin login above.
// ============================================================

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Name, email, and password are all required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (users.find(u => u.email === normalizedEmail)) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = {
      id: uuidv4(),
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      createdAt: new Date().toISOString(),
    };

    users.push(newUser);
    saveUsers(users);

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ success: false, error: 'Session error' });
      req.session.userId = newUser.id;
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ success: false, error: 'Session save error' });
        res.json({ success: true, user: sanitizeUser(newUser) });
      });
    });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    res.status(500).json({ success: false, error: 'Could not create account' });
  }
});

// POST /api/auth/signin
app.post('/api/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = users.find(u => u.email === normalizedEmail);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ success: false, error: 'Session error' });
      req.session.userId = user.id;
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ success: false, error: 'Session save error' });
        res.json({ success: true, user: sanitizeUser(user) });
      });
    });
  } catch (err) {
    console.error('[Auth] Signin error:', err);
    res.status(500).json({ success: false, error: 'Could not sign in' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  if (req.session) req.session.userId = null;
  req.session.save(() => res.json({ success: true }));
});

// GET /api/auth/session — checks if a visitor is currently signed in
app.get('/api/auth/session', (req, res) => {
  if (req.session && req.session.userId) {
    const user = users.find(u => u.id === req.session.userId);
    return res.json({ authenticated: !!user, user: sanitizeUser(user) });
  }
  res.json({ authenticated: false, user: null });
});

// ============================================================
// ROUTES — PUBLIC TRACKS
// ============================================================

// GET /api/tracks — return all tracks (public)
app.get('/api/tracks', (req, res) => {
  res.json(tracks);
});

// ============================================================
// ROUTES — FEEDBACK
// ============================================================

// POST /api/tracks/:id/feedback — submit feedback for a track (public, no login required)
app.post('/api/tracks/:id/feedback', (req, res) => {
  const track = tracks.find(t => t.id === req.params.id);
  if (!track) {
    return res.status(404).json({ success: false, error: 'Track not found' });
  }

  const {
    rating,          // 1-5, required unless reporting a problem
    audioQuality,    // 'distorted' | 'too_quiet' | 'too_loud' | 'muffled' | 'static_noise' | 'choppy' | 'out_of_sync', required when reporting a problem
    issues,          // array of strings, required (min 1) when reporting a problem — e.g. ['genre_wrong', 'no_download']
    comment,         // string, optional
    name,            // string, required when reporting a problem
    email,           // string, required when reporting a problem
    commercialUse,   // true | false, required when reporting a problem
    isProblemReport: isProblemReportFlag, // boolean, whether the client was in "report a problem" mode
  } = req.body;

  const VALID_AUDIO_QUALITY = ['distorted', 'too_quiet', 'too_loud', 'muffled', 'static_noise', 'choppy', 'out_of_sync'];
  const VALID_ISSUES = ['genre_wrong', 'no_play', 'no_download', 'wrong_format'];
  const reportedIssues = Array.isArray(issues) ? issues.filter(i => VALID_ISSUES.includes(i)) : [];
  // Trust the client's mode flag when present; otherwise fall back to inferring from selected issues
  const isProblemReport = typeof isProblemReportFlag === 'boolean' ? isProblemReportFlag : reportedIssues.length > 0;

  const ratingNum = Number(rating);
  const ratingValid = Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 5;
  if (!isProblemReport && !ratingValid) {
    return res.status(400).json({ success: false, error: 'Rating must be a whole number from 1 to 5' });
  }

  // Every field in the problem-report flow is mandatory
  if (isProblemReport) {
    if (!VALID_AUDIO_QUALITY.includes(audioQuality)) {
      return res.status(400).json({ success: false, error: 'Please select an audio quality option' });
    }
    if (reportedIssues.length === 0) {
      return res.status(400).json({ success: false, error: 'Please select at least one issue' });
    }
    if (commercialUse !== true && commercialUse !== false) {
      return res.status(400).json({ success: false, error: "Please specify whether you'd use this track commercially" });
    }
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Name is required to report a problem' });
    }
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ success: false, error: 'Email is required to report a problem' });
    }
  }

  const entry = {
    id:            uuidv4(),
    trackId:       track.id,
    trackTitle:    track.title,
    rating:        ratingValid ? ratingNum : null,
    audioQuality:  VALID_AUDIO_QUALITY.includes(audioQuality) ? audioQuality : null,
    issues:        reportedIssues,
    // Cap comment length server-side regardless of what the frontend enforces
    comment:       typeof comment === 'string' ? comment.slice(0, 500).trim() : '',
    name:          typeof name === 'string' ? name.slice(0, 100).trim() : '',
    email:         typeof email === 'string' ? email.slice(0, 200).trim() : '',
    commercialUse: commercialUse === true,
    createdAt:     new Date().toISOString(),
  };

  feedback.push(entry);
  saveFeedback(feedback);

  console.log(`[Feedback] New ${entry.rating}★ review for "${track.title}"`);
  res.json({ success: true, feedback: entry });
});

// GET /api/admin/feedback — list all feedback, newest first (admin only)
app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const sorted = [...feedback].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(sorted);
});

// DELETE /api/admin/feedback/:id — remove a feedback entry (admin only, e.g. spam cleanup)
app.delete('/api/admin/feedback/:id', requireAdmin, (req, res) => {
  const before = feedback.length;
  feedback = feedback.filter(f => f.id !== req.params.id);
  if (feedback.length === before) {
    return res.status(404).json({ success: false, error: 'Feedback entry not found' });
  }
  saveFeedback(feedback);
  res.json({ success: true });
});

// GET /api/tracks/:id/download-file?format=mp3|wav|flac&token=...
// MP3 is free and public. WAV/FLAC require a valid payment token from /api/payment/verify.
app.get('/api/tracks/:id/download-file', async (req, res) => {
  try {
    const { format = 'mp3' } = req.query;
    const track = tracks.find(t => t.id === req.params.id);

    if (!track) return res.status(404).json({ success: false, error: 'Track not found' });
    if (!FORMAT_CONFIG[format]) return res.status(400).json({ success: false, error: 'Invalid format requested' });

    // All formats (MP3, WAV, FLAC) are free — no payment or token required
    const filePath = await getOrCreateProcessedFile(track, format);

    track.downloads = (track.downloads || 0) + 1;
    saveTracks(tracks);
    io.emit('trackDownloadUpdated', { id: track.id, downloads: track.downloads });

    const safeName = `${track.title} - ${track.artist}`.replace(/[\\/:*?"<>|]/g, '');
    res.download(filePath, `${safeName}.${FORMAT_CONFIG[format].ext}`);
  } catch (err) {
    console.error('[Download] Processing failed:', err);
    res.status(500).json({ success: false, error: 'Failed to process download. Please try again.' });
  }
});

// ============================================================
// ROUTES — PROTECTED ADMIN TRACK OPERATIONS
// ============================================================

// POST /api/tracks/upload — upload a new track (admin only)
app.post(
  '/api/tracks/upload',
  requireAdmin,
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
  (req, res) => {
    const { title, artist, genre, duration, bpm, trackKey, releaseDate, youtubeUrl } = req.body;

    if (!req.files?.audio || !req.files?.cover) {
      return res.status(400).json({ success: false, error: 'Both audio and cover files are required' });
    }
    if (!title || !artist) {
      return res.status(400).json({ success: false, error: 'Title and artist are required' });
    }

    const audioFile = req.files.audio[0];
    const coverFile = req.files.cover[0];

    const audioPath = path.join(UPLOADS_DIR, audioFile.filename);
    const coverPath = path.join(UPLOADS_DIR, coverFile.filename);

    // Embed title, artist, cover art etc. into the MP3 file itself
    embedID3Tags(audioPath, coverPath, {
      title:  title?.trim(),
      artist: artist?.trim(),
      genre:  genre?.trim()
    });

    const newTrack = {
      id:          uuidv4(),
      title:       title.trim(),
      artist:      artist.trim(),
      genre:       genre?.trim() || '',
      duration:    duration?.trim() || '',
      bpm:         bpm?.trim() || '',
      trackKey:    trackKey?.trim() || '',
      youtubeUrl:  youtubeUrl?.trim() || '',
      releaseDate: releaseDate || new Date().toLocaleDateString(),
      downloads:   0,
      audioUrl:    `/uploads/${audioFile.filename}`,
      cover:       `/uploads/${coverFile.filename}`,
      createdAt:   new Date().toISOString(),
    };

    tracks.push(newTrack);
    saveTracks(tracks);

    console.log(`[Track] Uploaded: "${newTrack.title}" by ${newTrack.artist}`);
    res.json({ success: true, track: newTrack });
  }
);

// PUT /api/tracks/:id — edit an existing track (admin only)
app.put(
  '/api/tracks/:id',
  requireAdmin,
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
  (req, res) => {
    const trackIndex = tracks.findIndex(t => t.id === req.params.id);
    if (trackIndex === -1) {
      return res.status(404).json({ success: false, error: 'Track not found' });
    }

    const track = tracks[trackIndex];
    const { title, artist, genre, duration, bpm, trackKey, youtubeUrl } = req.body;

    // Update text fields
    if (title)    track.title    = title.trim();
    if (artist)   track.artist   = artist.trim();
    if (genre !== undefined)    track.genre    = genre.trim();
    if (duration !== undefined) track.duration = duration.trim();
    if (bpm !== undefined)      track.bpm      = bpm.trim();
    if (trackKey !== undefined) track.trackKey = trackKey.trim();
    if (youtubeUrl !== undefined) track.youtubeUrl = youtubeUrl.trim();
    track.updatedAt = new Date().toISOString();

    // Replace cover if a new file was uploaded
    if (req.files?.cover) {
      deleteFile(track.cover);
      track.cover = `/uploads/${req.files.cover[0].filename}`;
    }

    // Replace audio if a new file was uploaded
    if (req.files?.audio) {
      deleteFile(track.audioUrl);
      track.audioUrl = `/uploads/${req.files.audio[0].filename}`;
    }

    // Re-embed ID3 tags with updated metadata into the current audio file
    const currentAudioPath = path.join(__dirname, track.audioUrl.replace(/^\//, ''));
    const currentCoverPath = req.files?.cover
      ? path.join(UPLOADS_DIR, req.files.cover[0].filename)
      : path.join(__dirname, track.cover.replace(/^\//, ''));

    embedID3Tags(currentAudioPath, currentCoverPath, {
      title:  track.title,
      artist: track.artist,
      genre:  track.genre
    });

    tracks[trackIndex] = track;
    saveTracks(tracks);

    // Invalidate cached MP3/WAV/FLAC conversions — they'll regenerate on next download
    clearProcessedFiles(track.id);

    console.log(`[Track] Updated: "${track.title}" (${track.id})`);
    res.json({ success: true, track });
  }
);

// DELETE /api/tracks/:id — remove a track and its files (admin only)
app.delete('/api/tracks/:id', requireAdmin, (req, res) => {
  const trackIndex = tracks.findIndex(t => t.id === req.params.id);
  if (trackIndex === -1) {
    return res.status(404).json({ success: false, error: 'Track not found' });
  }

  const [removed] = tracks.splice(trackIndex, 1);
  saveTracks(tracks);

  // Clean up files from disk
  deleteFile(removed.audioUrl);
  deleteFile(removed.cover);
  clearProcessedFiles(removed.id);

  console.log(`[Track] Deleted: "${removed.title}" (${removed.id})`);
  res.json({ success: true, id: removed.id });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  // Multer-specific errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'File too large. Maximum size is 50 MB.' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    console.error('[Server Error]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
  next();
});

// ============================================================
// START SERVER
// ============================================================
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   FCS Backend Server Running             ║
║   http://localhost:${PORT}                  ║
║   Mode: ${NODE_ENV.padEnd(32)}║
╚══════════════════════════════════════════╝
  `);
});
