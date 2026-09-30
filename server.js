process.noDeprecation = true;
require('dns').setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Auto-install dependencies if node_modules is missing (e.g. first clone on Termux)
if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
  console.log('📦 Mendeteksi instalasi baru. Memasang library yang dibutuhkan...');
  try {
    execSync('npm install --omit=dev', { stdio: 'inherit', cwd: __dirname });
    console.log('✅ Semua library berhasil terpasang!');
  } catch (e) {
    console.error('❌ Gagal memasang library otomatis:', e.message);
  }
}

const express = require('express');
const chalk = require('chalk');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const os = require('os');
const crypto = require('crypto');

// Determine DATA_DIR:
// In Termux (Android), store user media & configs in phone storage (/sdcard/Download/bot_data)
// In Windows / PC, use process.cwd() (local folder)
const isAndroid = process.platform !== 'win32' && fs.existsSync('/sdcard');
const DATA_DIR = isAndroid 
  ? '/sdcard/Download/bot_data' 
  : (fs.existsSync(path.join(process.cwd(), 'setup')) ? process.cwd() : __dirname);

// PKG Static Bundler Hack: Force pkg to bundle dependencies for the cloud engine (eval)
if (false) {
  require('instagram-private-api');
  require('instagram-private-api/dist/services/publish.service');
  require('jimp-compact');
  require('pureimage');
  require('opentype.js');
  require('pngjs');
  require('jpeg-js');
  require('bluebird');
  require('fluent-ffmpeg');
  require('chance');
}

function initDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
  }

  const folders = [
    'media', 'media/feed', 'media/feed/dm', 'media/feed/story', 'media/feed/profile', 'setup', 'setup/bio', 'setup/caption',
    'setup/highlights', 'setup/sticker', 'setup/link', 'setup/comment',
    'autosetup-configs', 'auto_progress', 'dm', 'fonts', 'tmp'
  ];

  folders.forEach(f => {
    const p = path.join(DATA_DIR, f);
    if (!fs.existsSync(p)) {
      try { fs.mkdirSync(p, { recursive: true }); } catch (e) { }
    }

    const copyRecursive = (srcDir, destDir) => {
      try {
        if (!fs.existsSync(srcDir)) return;
        const items = fs.readdirSync(srcDir);
        items.forEach(item => {
          const srcPath = path.join(srcDir, item);
          const destPath = path.join(destDir, item);

          if (fs.lstatSync(srcPath).isDirectory()) {
            if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
            copyRecursive(srcPath, destPath);
          } else {
            if (!fs.existsSync(destPath)) {
              fs.copyFileSync(srcPath, destPath);
            }
          }
        });
      } catch (e) { }
    };

    const internalPath = path.join(__dirname, f);
    if (path.resolve(internalPath) !== path.resolve(p)) {
      copyRecursive(internalPath, p);
    }
  });

  // Extract shortlink_urls.json if missing
  const slPath = path.join(DATA_DIR, 'shortlink_urls.json');
  if (!fs.existsSync(slPath)) {
    const internalSL = path.join(__dirname, 'shortlink_urls.json');
    if (fs.existsSync(internalSL)) {
      try { fs.copyFileSync(internalSL, slPath); } catch (e) { }
    }
  }
}

initDir();
const AUTH_SERVER = Buffer.from('aHR0cHM6Ly9uaW5qYS1hdXRoLXNlcnZlci52ZXJjZWwuYXBwL2FwaS9hdXRo', 'base64').toString();
const ENCRYPTION_KEY = Buffer.from('U0VNT0dBX1lBTkdfTEFOR0dBTkFOX0lOSV9MQU5DQVJfUkVKRUtJX05ZQQ==', 'base64').toString();
// ============================================================
// UNIVERSAL DEVICE ID: Windows (node-machine-id), Linux/Termux (/proc)
// ============================================================
function getDeviceId() {
  // Prioritas 1: node-machine-id (PC Windows/Linux dengan native addon)
  try {
    const machineId = require('node-machine-id');
    return machineId.machineIdSync();
  } catch (e) { }

  // Prioritas 2: /proc/sys/kernel/random/boot_id (Android/Termux/Linux tanpa addon)
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (bootId && bootId.length > 0) {
      return crypto.createHash('sha256').update(bootId).digest('hex').substring(0, 32);
    }
  } catch (e) { }

  // Prioritas 3: Kombinasi hostname + PATH + USER (fallback universal)
  try {
    const hostname = os.hostname();
    const pathHash = crypto.createHash('md5').update(process.env.PATH || '').digest('hex');
    const uniqueStr = `${hostname}-${pathHash}-${process.env.USER || 'default'}`;
    return crypto.createHash('sha256').update(uniqueStr).digest('hex').substring(0, 32);
  } catch (e) { }

  // Fallback terakhir
  return `device-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

const HWID = getDeviceId();

function processStream(text) {
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    throw new Error('E101');
  }
}

let SvcHandler = null;
let memBuffer = null;
let customerName = 'Dibuat oleh mas abdul haris hamammi';
let runningText = null;

async function initProcess() {
  try {
    const localIndex = require('./index.js');
    SvcHandler = localIndex.instagram;

    if (SvcHandler) {
      SvcHandler.RAM_TOOLS = {
        'viewstory': 'runViewStory',
        'autosetup': 'runAutoSetup',
        'postfeed': 'runPostFeed',
        'poststory': 'runPostStory',
        'liketimeline': 'runLikeTimeline',
        'liketarget': 'runLikeTarget',
        'followerstarget': 'runFollowersTarget',
        'lctarget': 'runLCTarget',
        'dmfollowers': 'runDMFollowers',
        'scraper': 'runScraper',
        'likeuuid': 'runLikeUUID',
        'commentuuid': 'runCommentUUID',
        'fftuuid': 'runFFTUUID',
        'fftdmuuid': 'runFFTDMUUID',
        'ffthashtag': 'runFFTHashtag',
        'fftgps': 'runFFTGPS',
      };

      // Ready in RAM offline
    }
  } catch (err) {
    _originalError('[CRITICAL] Gagal inisialisasi local engine:', err.message || err);
  }
}



const getFFmpegPath = () => {
  if (process.platform !== 'win32') return 'ffmpeg';
  const cwdBin = path.join(process.cwd(), 'bin', 'ffmpeg.exe');
  if (fs.existsSync(cwdBin)) return cwdBin;
  const localBin = path.join(__dirname, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(localBin)) return localBin;
  const localFF = path.join(process.cwd(), 'tmp', 'ffmpeg.exe');
  if (fs.existsSync(localFF)) return localFF;
  try { return require('ffmpeg-static'); }
  catch (e) { return 'ffmpeg'; }
};


const getFFprobePath = () => {
  if (process.platform !== 'win32') return 'ffprobe';
  const cwdBin = path.join(process.cwd(), 'bin', 'ffprobe.exe');
  if (fs.existsSync(cwdBin)) return cwdBin;
  const localBin = path.join(__dirname, 'bin', 'ffprobe.exe');
  if (fs.existsSync(localBin)) return localBin;
  const localFP = path.join(process.cwd(), 'tmp', 'ffprobe.exe');
  if (fs.existsSync(localFP)) return localFP;
  try { return require('@ffprobe-installer/ffprobe').path; }
  catch (e) { return 'ffprobe'; }
};

const BANNER = chalk.yellow(`
░░█▀▄░█▀█░▀█▀░░░▀█▀░█▀█░█░░░█▀█░█░░░
░░█▀▄░█░█░░█░░░░░█░░█░█░█░░░█░█░█░░░
░░▀▀░░▀▀▀░░▀░░░░░▀░░▀▀▀░▀▀▀░▀▀▀░▀▀▀░
`);

// ============================================================
// LOG ISOLATION & CONSOLE OVERRIDE
// Mutes the terminal and redirects all logs to the extension.
// ============================================================
const logsByUser = new Map(); // username -> logEntry[]
const sseByUser = new Map(); // username -> Set<res>
const MAX_LOGS = 200;

function getLogBuffer(username) {
  const bucket = (username || '__global__').toLowerCase();
  if (!logsByUser.has(bucket)) logsByUser.set(bucket, []);
  return logsByUser.get(bucket);
}
function getSseClients(username) {
  const bucket = (username || '__global__').toLowerCase();
  if (!sseByUser.has(bucket)) sseByUser.set(bucket, new Set());
  return sseByUser.get(bucket);
}

const _originalLog = console.log;
const _originalError = console.error;

function addLog(type, message, username) {
  const bucket = (username || '__global__').toLowerCase();
  const cleanMessage = String(message)
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
    .trim();
  if (!cleanMessage) return;
  if (/Local Engine Berhasil Dimuat|Offline Mode Active/i.test(cleanMessage)) return;

  const logEntry = {
    timestamp: new Date().toLocaleTimeString(),
    type,
    message: cleanMessage,
    username: bucket
  };

  const buf = getLogBuffer(bucket);
  buf.push(logEntry);
  if (buf.length > MAX_LOGS) buf.shift();

  // Broadcast via Socket.io (if initialized)
  if (typeof io !== 'undefined' && io) {
    io.emit('extension_log', logEntry);
  }

  // Broadcast via SSE
  const sseMsg = JSON.stringify(logEntry);
  getSseClients(bucket).forEach(client => {
    try { client.write(`data: ${sseMsg}\n\n`); } catch (e) { }
  });
}

// Global Console Override: Terminal stays clean, Logs go to Extension UI.
console.log = function (...args) { addLog('info', args.join(' ')); };
console.error = function (...args) { addLog('err', args.join(' ')); };
console.warn = function (...args) { addLog('warn', args.join(' ')); };
console.info = function (...args) { addLog('info', args.join(' ')); };
console.debug = function (...args) { addLog('debug', args.join(' ')); };

// Global Error Catching
process.on('uncaughtException', (err) => {
  const msg = `[CRITICAL CRASH] ${err.message}\n${err.stack}`;
  _originalError(msg);
  addLog('err', msg);
  try { fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), `[${new Date().toISOString()}] ${msg}\n\n`); } catch (e) { }
});
process.on('unhandledRejection', (reason, promise) => {
  const msg = `[UNHANDLED REJECTION] ${reason}`;
  _originalError(msg);
  addLog('err', msg);
  try { fs.appendFileSync(path.join(DATA_DIR, 'crash.log'), `[${new Date().toISOString()}] ${msg}\n\n`); } catch (e) { }
});

// Show Banner - ONCE
process.stdout.write('\x1Bc'); // Clear console
process.stdout.write(BANNER + '\n');

// Initialize the cloud engine process after banner, console overrides, and _originalError are ready
initProcess();

const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(getFFmpegPath());
ffmpeg.setFfprobePath(getFFprobePath());

// Track running background tasks
const runningTasks = new Map(); // taskId -> childProcess (Spawned)
const activeRAMTasks = new Map(); // taskId -> igInstance (Integrated)

// Convert any video format to Instagram-compatible MP4
function convertToMp4(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    let vf = 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2';
    if (options.blur) {
      vf += `,boxblur=${options.blurValue || 20}:5`;
    }

    const command = ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
        '-preset fast',
        '-crf 23'
      ]);

    if (options.mute) {
      command.noAudio();
    } else {
      command.outputOptions(['-c:a aac']);
    }

    command.output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function generateVideoCover(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const outDir = path.dirname(outputPath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    } catch (e) { }

    ffmpeg(videoPath)
      .screenshots({
        count: 1,
        folder: path.dirname(outputPath),
        filename: path.basename(outputPath),
        timemarks: ['00:00:00.100']
      })
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        ffmpeg(videoPath)
          .screenshots({
            count: 1,
            folder: path.dirname(outputPath),
            filename: path.basename(outputPath),
            timemarks: ['0%']
          })
          .on('end', () => resolve(outputPath))
          .on('error', reject);
      });
  });
}

const app = express();
const server = http.createServer(app);

// Configure multer for media uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(DATA_DIR, 'media'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use('/media', express.static(path.join(DATA_DIR, 'media')));
const TOOLS_DIR = path.join(DATA_DIR, 'tools');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const FEED_DIR = path.join(MEDIA_DIR, 'feed');
const SETUP_DIR = path.join(DATA_DIR, 'setup');
const CONFIGS_DIR = path.join(DATA_DIR, 'autosetup-configs');
const DM_DIR = path.join(DATA_DIR, 'dm');
const FONTS_DIR = path.join(DATA_DIR, 'fonts');
const AUTO_PROGRESS_DIR = path.join(DATA_DIR, 'auto_progress');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');

// License gate removed - all features unlocked offline
app.get('/api/extension/license/check', async (req, res) => {
  if (!SvcHandler) await initProcess();
  res.json({ ok: true, license: 'LIFETIME', customerName: 'Dibuat oleh mas abdul haris hamammi' });
});

app.post('/api/extension/license/activate', async (req, res) => {
  if (!SvcHandler) await initProcess();
  res.json({ ok: true, message: 'Aktivasi Berhasil (Offline Mode)!' });
});

app.get('/api/menu', (req, res) => {
  res.json({ ok: true, status: 'online' });
});

// List all .txt files in the data directory and media directory
app.get('/api/list-files', (req, res) => {
  const rootFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt'));
  let mediaFiles = [];
  if (fs.existsSync(MEDIA_DIR)) {
    mediaFiles = fs.readdirSync(MEDIA_DIR).filter(f => f.endsWith('.txt')).map(f => `media/${f}`);
  }

  // Scrape setup/ subfolders
  let setupFiles = [];
  if (fs.existsSync(SETUP_DIR)) {
    const subs = fs.readdirSync(SETUP_DIR);
    subs.forEach(sub => {
      const subPath = path.join(SETUP_DIR, sub);
      if (fs.statSync(subPath).isDirectory()) {
        const files = fs.readdirSync(subPath).filter(f => f.endsWith('.txt')).map(f => `setup/${sub}/${f}`);
        setupFiles = [...setupFiles, ...files];
      }
    });
  }

  const allFiles = [...rootFiles, ...mediaFiles, ...setupFiles];
  res.json({ files: allFiles });
});

// New endpoint for specific setup category listing
app.get('/api/setup-files', (req, res) => {
  const category = req.query.category; // e.g. 'caption', 'bio'
  if (!category) return res.json({ ok: false, error: 'Category required' });

  const targetDir = path.join(SETUP_DIR, category);
  if (!fs.existsSync(targetDir)) return res.json({ ok: true, files: [] });

  try {
    const files = fs.readdirSync(targetDir)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({
        filename: f,
        path: `setup/${category}/${f}`
      }));
    res.json({ ok: true, files });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});


// Get content of any .txt file (supports nested paths like setup/sticker/sticker.txt)
const handleGetFile = (req, res) => {
  let rawFilename = req.params[0] || req.params.filename || '';
  try { rawFilename = decodeURIComponent(rawFilename); } catch (e) { }

  let filePath = path.join(DATA_DIR, rawFilename);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, rawFilename);
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ ok: true, content });
  } else {
    res.status(404).json({ ok: false, error: 'File not found: ' + rawFilename });
  }
};

const handlePostFile = (req, res) => {
  let rawFilename = req.params[0] || req.params.filename || '';
  try { rawFilename = decodeURIComponent(rawFilename); } catch (e) { }
  const { content } = req.body;

  if (!rawFilename.endsWith('.txt')) {
    return res.status(400).json({ ok: false, error: 'Only .txt files are allowed' });
  }

  let filePath = path.join(DATA_DIR, rawFilename);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content || '', 'utf8');
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};

app.get(/^\/api\/files\/(.+)$/, handleGetFile);
app.get('/api/files/:filename', handleGetFile);
app.post(/^\/api\/files\/(.+)$/, handlePostFile);
app.post('/api/files/:filename', handlePostFile);

// Obsolete endpoints removed

// List media files
app.get('/api/media', (req, res) => {
  const mediaDir = path.join(DATA_DIR, 'media');
  if (!fs.existsSync(mediaDir)) return res.json([]);

  // Get files from media/
  let files = fs.readdirSync(mediaDir).filter(f => {
    const fullPath = path.join(mediaDir, f);
    return !fs.lstatSync(fullPath).isDirectory() && /\.(jpg|jpeg|png|webp|mp4)$/i.test(f);
  });

  // Get files from media/feed/
  const feedDir = path.join(mediaDir, 'feed');
  if (fs.existsSync(feedDir)) {
    const feedFiles = fs.readdirSync(feedDir).filter(f => /\.(jpg|jpeg|png|webp|mp4)$/i.test(f)).map(f => `feed/${f}`);
    files = [...files, ...feedFiles];
  }

  res.json(files);
});

// List media sub-folders
app.get('/api/media-folders', (req, res) => {
  const mediaDir = path.join(DATA_DIR, 'media');
  if (!fs.existsSync(mediaDir)) return res.json({ folders: [] });

  const subs = fs.readdirSync(mediaDir).filter(f => fs.lstatSync(path.join(mediaDir, f)).isDirectory());
  const folders = subs.map(f => ({ name: f, path: `media/${f}` }));
  res.json({ folders });
});


app.get('/api/browse-folders', (req, res) => {
  let targetPath = req.query.path || DATA_DIR;
  if (!path.isAbsolute(targetPath)) targetPath = path.resolve(DATA_DIR, targetPath);

  if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Path not found' });

  try {
    const items = fs.readdirSync(targetPath, { withFileTypes: true });

    const folders = items
      .filter(item => item.isDirectory())
      .map(item => item.name);

    const files = items
      .filter(item => item.isFile())
      .map(item => item.name);

    res.json({
      currentPath: targetPath,
      parentPath: path.dirname(targetPath),
      folders: folders.sort(),
      files: files.sort()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/native-folder-picker', (req, res) => {
  // Native picker is not supported on Android/Termux (No PowerShell)
  res.status(400).json({ error: 'Native Picker hanya tersedia di Windows. Gunakan Browse Server.' });
});

app.get('/api/check-folder', (req, res) => {
  const targetPath = req.query.path;
  if (!targetPath) return res.json({ exists: false });
  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(__dirname, targetPath);
  res.json({ exists: fs.existsSync(fullPath) && fs.lstatSync(fullPath).isDirectory() });
});

app.post('/api/upload-media', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  res.json({ filename: req.file.filename });
});

// Serve media folder for preview if needed
app.use('/media', express.static(path.join(DATA_DIR, 'media'), {
  setHeaders: (res) => { res.set('Access-Control-Allow-Origin', '*'); }
}));

app.post('/api/upload-font', upload.single('font'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  const targetPath = path.join(FONTS_DIR, req.file.originalname);
  fs.renameSync(req.file.path, targetPath);
  res.json({ filename: req.file.originalname });
});

app.get('/api/fonts', (req, res) => {
  if (!fs.existsSync(FONTS_DIR)) return res.json([]);
  const files = fs.readdirSync(FONTS_DIR).filter(f => f.toLowerCase().endsWith('.ttf'));
  res.json(files);
});

app.get('/api/extension/ping', (req, res) => res.json({ ok: true, message: 'Ninja Server is Alive!' }));

// Serve the default URL list for the shortlink generator
app.get('/api/extension/shortlink-urls', (req, res) => {
  const filePath = path.join(DATA_DIR, 'shortlink_urls.json');
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, 'utf8');
    res.json(JSON.parse(data));
  } else {
    res.json({ imo: "https://imo.im", clickdealer: "https://clickdealer.com", trafee: "https://trafee.com" });
  }
});

app.post('/api/extension/shortlink-urls/update', (req, res) => {
  const { imo, clickdealer, trafee } = req.body;
  const filePath = path.join(DATA_DIR, 'shortlink_urls.json');
  try {
    const data = { imo, clickdealer, trafee };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---- Auto Setup Config -----------------------------------
const AUTO_SETUP_FILE = path.join(DATA_DIR, 'autosetup_config.json');
app.get('/api/extension/autosetup-config', (req, res) => {
  if (fs.existsSync(AUTO_SETUP_FILE)) {
    try {
      const data = fs.readFileSync(AUTO_SETUP_FILE, 'utf8');
      res.json({ ok: true, config: JSON.parse(data) });
    } catch (e) { res.json({ ok: true, config: {} }); }
  } else {
    res.json({ ok: true, config: {} });
  }
});

app.post('/api/extension/autosetup-config', (req, res) => {
  try {
    const { config } = req.body;
    fs.writeFileSync(AUTO_SETUP_FILE, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- NEW CONFIG MANAGER ENDPOINTS ---

app.get('/api/extension/autosetup/configs', (req, res) => {
  try {
    if (!fs.existsSync(CONFIGS_DIR)) return res.json({ ok: true, configs: [] });
    const files = fs.readdirSync(CONFIGS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    res.json({ ok: true, configs: files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/extension/autosetup/configs/:name', (req, res) => {
  try {
    const { name } = req.params;
    const filePath = path.join(CONFIGS_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      res.json({ ok: true, config });
    } else {
      res.status(404).json({ ok: false, error: 'Config not found' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/autosetup/configs/:name', (req, res) => {
  try {
    const { name } = req.params;
    const { config } = req.body;
    const filePath = path.join(CONFIGS_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/extension/autosetup/configs/:name', (req, res) => {
  try {
    const { name } = req.params;
    const filePath = path.join(CONFIGS_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ ok: true });
    } else {
      res.status(404).json({ ok: false, error: 'Config not found' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/autosetup/start', async (req, res) => {
  const { config, session } = req.body;
  const username = (session?.username || '__global__').toLowerCase();

  // --- ENGINE-FUSION: DIRECT EXECUTION (Prioritize Integrated) ---
  if (SvcHandler && SvcHandler.prototype.runAutoSetup) {
    addLog('info', `[SYSTEM] Memulai Integrated Auto Setup untuk @${username}...`, username);
    const taskKey = `${username}:autosetup`;

    // Stop existing if any
    if (activeRAMTasks.has(taskKey)) {
      try { activeRAMTasks.get(taskKey).isStopped = true; } catch (e) { }
      activeRAMTasks.delete(taskKey);
    }

    (async () => {
      try {
        const ig = new SvcHandler();
        activeRAMTasks.set(taskKey, ig); // Register for Stop button

        if (typeof ig.setLogger === 'function') ig.setLogger(addLog);

        await ig.loginWithExtensionSession(false, true, session);
        const taskConfig = { ...(config || {}), ...(req.body.env || {}) };
        await ig.runAutoSetup(taskConfig);

        activeRAMTasks.delete(taskKey);
      } catch (err) {
        activeRAMTasks.delete(taskKey);
        addLog('err', `[AUTO SETUP ERROR] ${err.message}`, username);
      }
    })();
    return res.json({ ok: true, message: 'Auto Setup started (Integrated)' });
  }

  return res.status(400).json({ ok: false, error: 'Tool autosetup belum terintegrasi di server engine.' });
});

// ---- Generic Task Management ---------------------------
app.post('/api/extension/task/start', async (req, res) => {
  try {
    const { tool, env, session } = req.body;
    if (!tool) return res.status(400).json({ ok: false, error: 'Tool name required' });

    const username = (session?.username || '__global__').toLowerCase();
    const taskKey = `${username}:${tool}`;

    // Stop existing task of same type for this user if running
    if (runningTasks.has(taskKey)) {
      try { runningTasks.get(taskKey).kill(); } catch (e) { }
      runningTasks.delete(taskKey);
    }

    const toolName = tool.replace('.js', '');

    // --- STAGE 1: RAM-ONLY EXECUTION (Zero-Disk) ---
    // Check if the tool is integrated into the engine
    const ramMethod = SvcHandler && SvcHandler.RAM_TOOLS ? SvcHandler.RAM_TOOLS[toolName] : null;

    if (ramMethod && SvcHandler.prototype[ramMethod]) {
      addLog('info', `[SYSTEM] Memulai Integrated Tool ${toolName} (RAM Only)...`, username);

      // Stop existing RAM task of same type if running
      if (activeRAMTasks.has(taskKey)) {
        try { activeRAMTasks.get(taskKey).isStopped = true; } catch (e) { }
        activeRAMTasks.delete(taskKey);
      }

      (async () => {
        try {
          const ig = new SvcHandler();
          activeRAMTasks.set(taskKey, ig); // Register for Stop button

          if (typeof ig.setLogger === 'function') ig.setLogger((type, msg, user) => addLog(type, msg, user || username));

          // Ensure session object has valid _cookies array and ua
          let safeSession = session ? { ...session } : {};
          if (safeSession.cookies && (!safeSession._cookies || safeSession._cookies.length === 0)) {
            safeSession._cookies = parseCookiesToArray(safeSession.cookies);
          }
          if (!safeSession.ua) {
            safeSession.ua = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36';
          }

          await ig.loginWithExtensionSession(false, true, safeSession);

          // Merge configuration
          const taskConfig = { ...(env || {}), ...(env.config || {}) };
          await ig[ramMethod](taskConfig);

          // Notify UI that task finished (for RAM tools)
          const sseMsg = JSON.stringify({ type: 'task-finished', tool, code: 0 });
          getSseClients(username).forEach(client => { try { client.write(`data: ${sseMsg}\n\n`); } catch (e) { } });

          activeRAMTasks.delete(taskKey);
        } catch (err) {
          activeRAMTasks.delete(taskKey);
          addLog('err', `[${toolName.toUpperCase()} ERROR] ${err.message}`, username);
          addLog('err', `[@TASK_UPDATE@]${JSON.stringify({ type: 'error', message: err.message })}`, username);
        }
      })();
      return res.json({ ok: true, message: `${toolName} started in RAM` });
    }

    // Non-integrated tools return an informative error
    return res.status(400).json({ ok: false, error: `Tool ${toolName} belum diintegrasikan ke dalam engine.` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/task/stop', (req, res) => {
  try {
    const { tool, username: userRaw } = req.body;
    const username = (userRaw || '__global__').toLowerCase();
    const taskKey = `${username}:${tool}`;

    let stopped = false;

    // 1. Check for Spawned Task
    if (runningTasks.has(taskKey)) {
      try { runningTasks.get(taskKey).kill(); } catch (e) { }
      runningTasks.delete(taskKey);
      stopped = true;
    }

    // 2. Check for RAM/Integrated Task
    if (activeRAMTasks.has(taskKey)) {
      try {
        const ig = activeRAMTasks.get(taskKey);
        ig.isStopped = true; // Flag for internal loops
        if (typeof ig.stop === 'function') ig.stop(); // If core engine has stop method
      } catch (e) { }
      activeRAMTasks.delete(taskKey);
      stopped = true;
    }

    if (stopped) {
      addLog('warn', `[SYSTEM] Tugas ${tool} dihentikan paksa oleh pengguna.`, username);
      res.json({ ok: true, message: `Task ${tool} stopped` });
    } else {
      res.json({ ok: true, message: 'Task not running' });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});






// Variable to store current index for SSUR key rotation
const SSUR_KEYS = [
  'nZ9ZzSa4LZ4o', 'Ed8nLSFpNVGB', 'YJimrVqxmExf', 'L9YRXGPugtet', 'HR7RDeKNVgTX',
  'RKqh9qcjDoe4', 'XoWtP22exnmy', 'GGFedvn7yhFZ', 'yJpFtTfXNZVi', 'MqQsBMbCvthf',
  'MqQsBMbCvthf', 'vMd8zBusHzKk', 'ZYhVdSnyyEH6', '4XKRnpnNEUYX', '84zd7S9HP7CF',
  'PtpgRsxM5ozh'
];
let ssurKeyIndex = 0;

// Proxy for Shortlink Generation to bypass Browser CORS/WAF (e.g., CleanURI)

app.post('/api/extension/shortlink', async (req, res) => {
  const { provider, longUrl, apiKey } = req.body;

  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  };

  const axiosOptions = { timeout: 10000, headers: defaultHeaders };

  // Provider Functions
  const getSpoome = async (url) => {
    const res = await axios.post('https://spoo.me/',
      new URLSearchParams({ url }).toString(),
      { ...axiosOptions, headers: { ...defaultHeaders, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' } }
    );
    return res.data.short_url;
  };

  const getSsur = async (url, key) => {
    let currentKey = key;
    if (!currentKey) {
      currentKey = SSUR_KEYS[ssurKeyIndex];
      ssurKeyIndex = (ssurKeyIndex + 1) % SSUR_KEYS.length;
    }
    const res = await axios.get(`https://ssur.cc/api.php?appkey=${currentKey}&format=json&longurl=${encodeURIComponent(url)}`, axiosOptions);
    if (res.data.code !== 1) throw new Error(res.data.msg || 'ssur.cc API Error');
    return res.data.ae_url;
  };

  const getTinyUrl = async (url) => {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, axiosOptions);
    return res.data;
  };

  const getIxSk = async (url) => {
    const params = new URLSearchParams({ longurl: url, action: 'create' });
    const res = await axios.post('https://ix.sk/',
      params.toString(),
      { ...axiosOptions, headers: { ...defaultHeaders, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const match = res.data.match(/class=["']shorturl["'][^>]*value=["'](https?:\/\/ix\.sk\/[^"']+)["']/i) ||
                  res.data.match(/value=["'](https?:\/\/ix\.sk\/[^"']+)["'][^>]*class=["']shorturl["']/i) ||
                  res.data.match(/https?:\/\/ix\.sk\/[a-zA-Z0-9_-]+/i);
    if (!match) throw new Error('ix.sk parse error');
    return (match[1] || match[0]).trim();
  };

  try {
    let finalShortUrl = '';

    if (provider === 'ix' || provider === 'ixsk') {
      try {
        finalShortUrl = await getIxSk(longUrl);
      } catch (err) {
        console.log(chalk.yellow(`[Shortlink] ix.sk failed (${err.message}), trying ssur.cc...`));
        try {
          finalShortUrl = await getSsur(longUrl, apiKey);
        } catch (err2) {
          console.log(chalk.yellow(`[Shortlink] ssur.cc failed, trying spoome...`));
          try {
            finalShortUrl = await getSpoome(longUrl);
          } catch (err3) {
            console.log(chalk.yellow(`[Shortlink] spoome failed, trying tinyurl...`));
            try {
              finalShortUrl = await getTinyUrl(longUrl);
            } catch (err4) {
              console.log(chalk.red(`[Shortlink] All shortlink providers failed, using longUrl.`));
              finalShortUrl = longUrl;
            }
          }
        }
      }
    } else if (provider === 'ssur') {
      // Implementation of multi-stage fallback for ssur
      try {
        finalShortUrl = await getSsur(longUrl, apiKey);
      } catch (err) {
        console.log(chalk.yellow(`[Shortlink] ssur.cc failed, trying ix.sk...`));
        try {
          finalShortUrl = await getIxSk(longUrl);
        } catch (err2) {
          console.log(chalk.yellow(`[Shortlink] ix.sk failed, trying spoome...`));
          try {
            finalShortUrl = await getSpoome(longUrl);
          } catch (err3) {
            console.log(chalk.yellow(`[Shortlink] spoome failed, trying tinyurl...`));
            try {
              finalShortUrl = await getTinyUrl(longUrl);
            } catch (err4) {
              console.log(chalk.red(`[Shortlink] All shortlink providers failed, using longUrl.`));
              finalShortUrl = longUrl;
            }
          }
        }
      }
    } else {
      // Original logic for other providers
      switch (provider) {
        case 'ix':
        case 'ixsk':
          finalShortUrl = await getIxSk(longUrl);
          break;
        case 'spoome':
          finalShortUrl = await getSpoome(longUrl);
          break;
        case 'tinyurl':
          finalShortUrl = await getTinyUrl(longUrl);
          break;
        default:
          return res.json({ ok: true, shortUrl: longUrl, fallback: true });
      }
    }

    if (!finalShortUrl || typeof finalShortUrl !== 'string' || !finalShortUrl.startsWith('http')) {
      finalShortUrl = longUrl;
    }

    res.json({ ok: true, shortUrl: finalShortUrl.trim() });
  } catch (error) {
    res.json({ ok: true, shortUrl: longUrl, fallback: true });
  }
});


io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('EXEC_ACTION', async (payload) => {
    const { requestId, action, data } = payload;
    try {
      if (action === 'follow') {
        const client = await getExtClient(data.cookies, data.ua);
        const result = await client.follow(data.targetId, data.isPrivate);
        socket.emit('ACTION_RESPONSE', { requestId, ok: true, ...result });
      } else if (action === 'resolve-user') {
        const client = await getExtClient(data.cookies, data.ua);
        const result = await client.resolveUser(data.username);
        socket.emit('ACTION_RESPONSE', { requestId, ok: true, ...result });
      } else if (action === 'user-info' || action === 'get-user-info') {
        const client = await getExtClient(data.cookies, data.ua);
        const targetId = data.userId || data.pk || data.targetId;
        const info = await client.ig.user.info(targetId);
        const user = (info && info.user) ? info.user : info;
        socket.emit('ACTION_RESPONSE', {
          requestId,
          ok: true,
          username: user.username,
          pk: String(user.pk || targetId),
          userId: String(user.pk || targetId),
          fullName: user.full_name || '',
          isPrivate: !!user.is_private,
          profilePicUrl: user.profile_pic_url || ''
        });
      } else {
        // Fallback untuk action lain jika belum terdaftar
        socket.emit('ACTION_RESPONSE', { requestId, ok: false, error: 'Unknown socket action' });
      }
    } catch (err) {
      socket.emit('ACTION_RESPONSE', { requestId, ok: false, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const extSessions = new Map();

function parseCookiesToArray(cookieStr) {
  if (!cookieStr || typeof cookieStr !== 'string') return [];
  return cookieStr.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    return { name: name.trim(), value: rest.join('=').trim(), domain: '.instagram.com', path: '/', secure: true, httpOnly: false };
  }).filter(c => c.name && c.value);
}

async function getExtClient(cookies, ua = null, forceReauth = false) {
  if (!cookies) throw new Error('No cookies provided');
  if (!SvcHandler) throw new Error('Core Engine belum siap! Silakan tunggu beberapa detik atau restart server.');

  const cookieStr = Array.isArray(cookies) ? cookies.map(c => `${c.name}=${c.value}`).join('; ') : cookies;
  const sessionid = (cookieStr.match(/sessionid=([^;]+)/) || [])[1];
  if (!sessionid) throw new Error('No sessionid in cookies.');

  let sessionEntry = extSessions.get(sessionid);
  if (!sessionEntry) {
    const client = new SvcHandler();
    sessionEntry = { client, ua, ready: false };
    extSessions.set(sessionid, sessionEntry);
  }

  // Hanya jalankan loginWithExtensionSession jika belum pernah ready atau dipaksa re-auth
  if (!sessionEntry.ready || forceReauth) {
    const cookieArray = Array.isArray(cookies) ? cookies : parseCookiesToArray(cookies);
    await sessionEntry.client.loginWithExtensionSession(true, false, { _cookies: cookieArray, ua: ua });
    sessionEntry.ready = true;
  }

  return sessionEntry.client;
}


// ---- Font Serving ----------------------------------------
// FONTS_DIR is defined globally at the top
app.use('/api/extension/fonts/files', express.static(FONTS_DIR, { setHeaders: (res) => { res.set('Access-Control-Allow-Origin', '*'); } }));
app.get('/api/extension/fonts', (req, res) => {
  try {
    const dataFonts = fs.existsSync(FONTS_DIR) ? fs.readdirSync(FONTS_DIR).filter(f => /\.(ttf|otf|woff|woff2)$/i.test(f)) : [];
    const localFonts = fs.existsSync(path.join(__dirname, 'fonts')) ? fs.readdirSync(path.join(__dirname, 'fonts')).filter(f => /\.(ttf|otf|woff|woff2)$/i.test(f)) : [];
    const combined = Array.from(new Set([...dataFonts, ...localFonts]));
    res.json({ ok: true, fonts: combined });
  } catch (e) { res.json({ ok: true, fonts: [] }); }
});

app.get('/api/extension/font', (req, res) => {
  try {
    const { filename } = req.query;
    if (!filename) return res.status(400).json({ ok: false, error: 'filename required' });

    const safe = path.basename(filename);
    let filePath = path.join(FONTS_DIR, safe);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, 'fonts', safe);
    }

    if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Font file not found' });

    const ext = path.extname(safe).toLowerCase().replace('.', '');
    const mime = `font/${ext === 'ttf' ? 'ttf' : (ext === 'otf' ? 'otf' : ext)}`;
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');

    res.json({ ok: true, content: `data:${mime};base64,${base64}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/extension/license', (req, res) => {
  res.json({ ok: true, hwid: 'OFFLINE', licenseKey: 'LIFETIME', engineReady: !!SvcHandler, customerName: 'Dibuat oleh mas abdul haris hamammi', runningText: '' });
});

app.post('/api/extension/license/save', async (req, res) => {
  if (!SvcHandler) await initProcess();
  res.json({ ok: true, message: 'OK', engineReady: !!SvcHandler });
});

function processExtData(text) {
  if (!text || typeof text !== 'string' || !text.includes(':')) return text;
  try {
    return processStream(text); // Gunakan fungsi decrypt yang sudah ada
  } catch (e) {
    return text;
  }
}

// Middleware untuk mendeteksi data terenkripsi dari Extension
app.use('/api/extension', (req, res, next) => {
  if (req.body && req.body.enc) {
    try {
      const decrypted = processExtData(req.body.enc);
      const parsed = JSON.parse(decrypted);
      req.body = parsed; // Ganti body dengan hasil dekripsi
    } catch (e) {
      console.error('[SECURITY] Gagal mendekripsi payload extension');
    }
  }
  next();
});

app.post('/api/extension/session', async (req, res) => {
  try {
    const { cookies, ua, forceUsername } = req.body;
    const client = await getExtClient(cookies, ua, true);

    // If client identity is still unknown but we have a forced username, try to fix it
    if (!client.username && forceUsername) {
      try {
        const info = await client.ig.user.searchExact(forceUsername);
        client.username = info.username;
        client.pk = info.pk;
        client.extUserInfo = info;
      } catch (e) { }
    }

    const info = client.extUserInfo;
    if (!info || !info.username) throw new Error('Identitas akun tidak ditemukan (ds_user_id missing).');

    res.json({ ok: true, username: info.username, pk: String(info.pk), profilePicUrl: info.profile_pic_url });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- Follow Engine & Human Simulation -------------------
app.post('/api/extension/follow', async (req, res) => {
  try {
    const client = await getExtClient(req.body.cookies, req.body.ua);
    const result = await client.ig.friendship.create(req.body.userId);
    res.json({ ok: true, status: result.following ? 'following' : (result.outgoing_request ? 'requested' : 'none') });
  } catch (e) {
    const errMsg = (e.message || '').toLowerCase();
    if (errMsg.includes('login_required') || errMsg.includes('checkpoint') || errMsg.includes('401')) {
      const cookieStr = Array.isArray(req.body.cookies) ? req.body.cookies.map(c => `${c.name}=${c.value}`).join('; ') : req.body.cookies;
      const sessionid = (cookieStr && cookieStr.match(/sessionid=([^;]+)/) || [])[1];
      if (sessionid) extSessions.delete(sessionid);
    }
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/follow/create', async (req, res) => {
  try {
    const client = await getExtClient(req.body.cookies, req.body.ua);
    const result = await client.follow(req.body.userId);
    res.json({ ok: true, result });
  } catch (e) {
    const errMsg = (e.message || '').toLowerCase();
    if (errMsg.includes('login_required') || errMsg.includes('checkpoint') || errMsg.includes('401')) {
      const cookieStr = Array.isArray(req.body.cookies) ? req.body.cookies.map(c => `${c.name}=${c.value}`).join('; ') : req.body.cookies;
      const sessionid = (cookieStr && cookieStr.match(/sessionid=([^;]+)/) || [])[1];
      if (sessionid) extSessions.delete(sessionid);
    }
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/simulate/browse', async (req, res) => {
  try {
    const { cookies, count = 3, ua } = req.body;
    const client = await getExtClient(cookies, ua);
    addLog('info', `🎭 [Simulation] Starting human activity simulation...`);
    const targets = await client.getRandomFollowing(count);
    if (!targets || !targets.length) {
      addLog('warn', `🎭 [Simulation] Following list empty, skipping...`);
      return res.json({ ok: true, simulated: 0, message: 'Following list empty' });
    }
    for (const target of targets) {
      addLog('info', `🎭 [Simulation] Viewing profile: @${target.username}`);
      await client.simulateProfileView(target.pk);
      addLog('info', `🎭 [Simulation] Scrolling & interacting with media...`);
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    }
    addLog('ok', `🎭 [Simulation] Completed ${targets.length} interaction steps.`);
    res.json({ ok: true, simulated: targets.length });
  } catch (e) {
    console.error(`[Simulate Error] ${e.message}`);
    addLog('err', `Simulation Error: ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- Scraper & Resolvers ---------------------------------
app.post('/api/extension/scrape', async (req, res) => {
  try {
    const { cookies, type, userId, mediaId, limit = 500, ua } = req.body;
    const client = await getExtClient(cookies, ua);
    let users = []; const seen = new Set();
    const feed = type === 'followers' ? client.ig.feed.accountFollowers(userId) : client.ig.feed.accountFollowingV2(userId);
    while (users.length < limit) {
      const page = await feed.items(); if (!page.length) break;
      for (const u of page) {
        if (users.length >= limit) break;
        if (!seen.has(String(u.pk))) { seen.add(String(u.pk)); users.push({ pk: String(u.pk), username: u.username }); }
      }
      if (!feed.isMoreAvailable()) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    res.json({ ok: true, users });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/extension/resolve-user', async (req, res) => {
  try {
    const client = await getExtClient(req.body.cookies, req.body.ua);
    const info = await client.ig.user.searchExact(req.body.username.replace('@', ''));
    res.json({ ok: true, pk: String(info.pk), username: info.username });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

const handleUserInfo = async (req, res) => {
  try {
    const targetId = req.body.userId || req.body.pk || req.body.id || req.query.userId || req.query.pk;
    if (!targetId) return res.status(400).json({ ok: false, error: 'userId is required' });
    const client = await getExtClient(req.body.cookies, req.body.ua);
    const info = await client.ig.user.info(targetId);
    const user = (info && info.user) ? info.user : info;
    if (!user || !user.username) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }
    res.json({
      ok: true,
      username: user.username,
      pk: String(user.pk || targetId),
      userId: String(user.pk || targetId),
      fullName: user.full_name || '',
      isPrivate: !!user.is_private,
      profilePicUrl: user.profile_pic_url || ''
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
};
app.post('/api/extension/user/info', handleUserInfo);
app.post('/api/extension/user-info', handleUserInfo);
app.get('/api/extension/user/info', handleUserInfo);

app.post('/api/extension/resolve-media', async (req, res) => {
  try {
    const client = await getExtClient(req.body.cookies, req.body.ua);
    const mediaId = await client.getMediaIdByUrl(req.body.url);
    res.json({ ok: true, mediaId });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- DM Flow ---------------------------------------------
app.post('/api/extension/dm/send', async (req, res) => {
  try {
    const client = await getExtClient(req.body.cookies, req.body.ua);
    const thread = req.body.threadId ? client.ig.entity.directThread(req.body.threadId.toString()) : client.ig.entity.directThread(req.body.uids.map(id => id.toString()));
    await thread.broadcastText(req.body.message);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Send media DM: kirim media (foto/video) dari folder lokal, lalu kirim teks
app.post('/api/extension/dm/send-with-media', async (req, res) => {
  try {
    const { cookies, ua, uids, threadId, message, mediaFolder } = req.body;
    const client = await getExtClient(cookies, ua);

    // Cari file media dari folder
    let baseDir = mediaFolder || 'media/feed';
    let folderPath = path.isAbsolute(baseDir) ? baseDir : path.resolve(DATA_DIR, baseDir);

    // Auto-subfolder detection for DM (STRICT MODE)
    const dmSubfolder = path.join(folderPath, 'dm');
    if (fs.existsSync(dmSubfolder) && fs.lstatSync(dmSubfolder).isDirectory()) {
      folderPath = dmSubfolder;
      console.log(chalk.cyan(`[DM-AutoDir] Mengarahkan ke sub-folder khusus DM: ${folderPath}`));
    }

    let mediaFile = null;
    if (fs.existsSync(folderPath)) {
      const files = fs.readdirSync(folderPath).filter(f => /\.(jpg|jpeg|png|webp|mp4)$/i.test(f) && !f.includes('_unique_'));
      if (files.length > 0) {
        // Pilih file secara acak
        mediaFile = path.join(folderPath, files[Math.floor(Math.random() * files.length)]);
        console.log(chalk.green(`[DM-Media] File terpilih: ${path.basename(mediaFile)} (dari ${path.basename(folderPath)})`));
      } else {
        console.log(chalk.yellow(`[DM-Media] Peringatan: Tidak ada file media di ${folderPath}`));
      }
    }

    let activeThreadId = threadId ? threadId.toString() : null;
    const recipientUids = (uids || []).map(id => id.toString());

    // Coba temukan existing thread ID jika belum ada
    if (!activeThreadId && recipientUids.length > 0) {
      try {
        const threadInfo = await client.ig.directThread.getByParticipants(recipientUids);
        if (threadInfo) {
          activeThreadId = (threadInfo.thread && threadInfo.thread.thread_id) || threadInfo.thread_id || (threadInfo.thread && threadInfo.thread.thread_v2_id);
          if (activeThreadId) {
            console.log(chalk.green(`[DM-Media] Ditemukan thread percakapan yang sudah ada: ${activeThreadId}`));
          }
        }
      } catch (e) {
        // Belum ada thread sebelumnya dengan partisipan ini
      }
    }

    const hasText = !!(message && message.trim());
    const hasMedia = !!(mediaFile && fs.existsSync(mediaFile));

    let sentText = false;
    let sentMedia = false;

    // 1. JIKA ADA TEKS: Kirim teks terlebih dahulu menggunakan recipientUids (atau threadId)
    // Pengiriman teks dengan recipientUids 100% konsisten berhasil baik untuk target baru maupun yang sudah pernah di-DM
    if (hasText) {
      console.log(chalk.cyan(`[DM-Media] Mengirim pesan teks: "${message.trim().substring(0, 40)}..."`));
      const textThread = (recipientUids && recipientUids.length > 0)
        ? client.ig.entity.directThread(recipientUids)
        : client.ig.entity.directThread(activeThreadId.toString());

      const textRes = await textThread.broadcastText(message);
      sentText = true;
      activeThreadId = textThread.threadId || (textRes && (textRes.thread_id || (textRes.payload && textRes.payload.thread_id))) || activeThreadId;
      console.log(chalk.green(`[DM-Media] Pesan teks berhasil terkirim! (thread_id: ${activeThreadId || 'ok'})`));

      // Beri jeda natural jika akan menyusul pengiriman media
      if (hasMedia) {
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 600));
      }
    }

    // 2. JIKA ADA MEDIA: Kirim media (foto atau video) ke target
    if (hasMedia) {
      console.log(chalk.cyan(`[DM-Media] Mengirim media: ${path.basename(mediaFile)} ke thread ${activeThreadId || recipientUids}`));
      if (typeof client.directSendMedia === 'function') {
        await client.directSendMedia(mediaFile, { threadId: activeThreadId, uids: recipientUids });
      } else {
        const targetThread = activeThreadId
          ? client.ig.entity.directThread(activeThreadId.toString())
          : client.ig.entity.directThread(recipientUids);
        await targetThread.broadcastPhoto({ file: fs.readFileSync(mediaFile) });
      }
      sentMedia = true;
      console.log(chalk.green(`[DM-Media] Media berhasil terkirim!`));
    }

    res.json({ ok: true, sentText, sentMedia, threadId: activeThreadId });
  } catch (e) {
    console.error(chalk.red(`[DM-Media] Gagal mengirim pesan: ${e.message}`));
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/dm/inbox', async (req, res) => {
  try {
    const client = await getExtClient(req.body.cookies, req.body.ua);
    const feed = client.ig.feed.directInbox();
    const items = await feed.items();
    const threads = items.map(t => ({
      threadId: t.thread_id,
      threadTitle: t.thread_title,
      users: (t.users || []).map(u => ({ pk: String(u.pk), username: u.username })),
      lastMessage: t.last_permanent_item ? (t.last_permanent_item.text || 'Media/Image') : ''
    }));
    res.json({ ok: true, threads });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/extension/dm/scrape-own', async (req, res) => {
  try {
    const { type, cookies, ua } = req.body;
    const client = await getExtClient(cookies, ua);
    const myId = client.ig.state.cookieUserId;

    // accountFollowers or accountFollowing
    const feed = type === 'followers' ? client.ig.feed.accountFollowers(myId) : client.ig.feed.accountFollowing(myId);
    let items = [];

    // Fetch up to 1000 items to avoid taking too much time
    while (items.length < 1000) {
      const page = await feed.items();
      if (!page.length) break;
      items.push(...page);
      if (!feed.isMoreAvailable()) break;
    }

    const mapped = items.map(u => ({ pk: String(u.pk), username: u.username }));
    res.json({ ok: true, items: mapped });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/extension/user/feed', async (req, res) => {
  try {
    const { cookies, ua, target } = req.body;
    const client = await getExtClient(cookies, ua);

    let userId = target;
    // Jika input bukan angka (ID), maka cari ID berdasarkan username
    if (!/^\d+$/.test(target)) {
      userId = await client.ig.user.getIdByUsername(target);
    }

    const userFeed = client.ig.feed.user(userId);
    const items = await userFeed.items();

    // Urutkan berdasarkan waktu upload asli (taken_at) secara descending (terbaru di posisi pertama)
    // agar Pin Post lama (misal 1 bulan lalu) tidak menduduki urutan pertama
    if (Array.isArray(items)) {
      items.sort((a, b) => (b.taken_at || 0) - (a.taken_at || 0));
    }

    res.json({ ok: true, items });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Helper Auto-detect Target: URL Post, Shortcode, Media ID, atau Akun
function parsePostOrAccount(target) {
  if (!target) return { type: 'unknown' };
  const s = String(target).trim();

  // 1. Direct Media PK (numeric 15+ digits)
  if (/^\d{15,}$/.test(s)) {
    return { type: 'post', mediaId: s, raw: s };
  }
  // 2. Post / Reel / TV / Share URL
  const urlMatch = s.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reels?|tv|share\/p)\/([a-zA-Z0-9_-]+)/i);
  if (urlMatch && urlMatch[1]) {
    return { type: 'post', shortcode: urlMatch[1], raw: s };
  }
  // 3. Shortcode with explicit prefix: p/CODE, reel/CODE, post/CODE, sc:CODE
  const prefixMatch = s.match(/^(?:p|reels?|tv|post|sc)[\/:\s]+([a-zA-Z0-9_-]+)$/i);
  if (prefixMatch && prefixMatch[1]) {
    return { type: 'post', shortcode: prefixMatch[1], raw: s };
  }
  // 4. Shortcode containing hyphen '-' (impossible in IG usernames)
  if (s.includes('-') && /^[a-zA-Z0-9_-]{8,15}$/.test(s)) {
    return { type: 'post', shortcode: s, raw: s };
  }
  // 5. Standard shortcode: contains uppercase [A-Z], no dot '.', length 9-13 (IG usernames are lowercase only)
  if (/[A-Z]/.test(s) && !s.includes('.') && /^[a-zA-Z0-9_-]{9,13}$/.test(s)) {
    return { type: 'post', shortcode: s, raw: s };
  }
  // 6. Explicit @username
  if (s.startsWith('@')) {
    return { type: 'account', account: s.replace(/^@+/, ''), raw: s };
  }
  // 7. Profile URL: instagram.com/username
  const profMatch = s.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]+)/i);
  if (profMatch && profMatch[1] && !['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'share'].includes(profMatch[1].toLowerCase())) {
    return { type: 'account', account: profMatch[1], raw: s };
  }
  // 8. Fallback: account (username or user UUID)
  return { type: 'account', account: s, raw: s };
}

// ---- Like Runner Endpoints ----
app.post('/api/extension/like/post', async (req, res) => {
  try {
    const { cookies, ua, target, mediaId } = req.body;
    const client = await getExtClient(cookies, ua);

    // 1. Cek apakah ada mediaId langsung atau target berupa Postingan (URL / Shortcode)
    let parsed = mediaId ? { type: 'post', mediaId: String(mediaId) } : parsePostOrAccount(target);

    if (parsed.type === 'post') {
      let targetMediaId = parsed.mediaId;
      if (!targetMediaId && parsed.shortcode) {
        targetMediaId = await client.getMediaIdByUrl(parsed.shortcode);
      }
      if (!targetMediaId) throw new Error('Gagal mengonversi target postingan ke Media ID');

      addLog('info', `[Like] Like direct post: ${targetMediaId} (target: ${parsed.shortcode || targetMediaId})`);
      try {
        await client.like(targetMediaId);
      } catch (likeErr) {
        // Fallback ke client.ig.media.like jika direct API gagal
        await client.ig.media.like({
          mediaId: targetMediaId,
          moduleInfo: { module_name: 'feed_shortform' },
          d: 0,
        });
      }

      return res.json({ ok: true, mediaId: targetMediaId, shortcode: parsed.shortcode || targetMediaId, isDirectPost: true });
    }

    // 2. Jika akun (Username / User UUID)
    let userId = parsed.account || target;
    if (!/^\d+$/.test(userId)) {
      try {
        userId = await client.ig.user.getIdByUsername(userId);
      } catch (uErr) {
        // Cek jika username ternyata sebuah raw shortcode (9-15 char alphanumeric)
        if (/^[a-zA-Z0-9_-]{9,15}$/.test(target)) {
          addLog('info', `[Like] Target '${target}' bukan akun, mencoba resolusi sebagai Shortcode post...`);
          try {
            const fallbackMediaId = await client.getMediaIdByUrl(target);
            if (fallbackMediaId) {
              try {
                await client.like(fallbackMediaId);
              } catch (err2) {
                await client.ig.media.like({ mediaId: fallbackMediaId, moduleInfo: { module_name: 'feed_shortform' }, d: 0 });
              }
              return res.json({ ok: true, mediaId: fallbackMediaId, shortcode: target, isDirectPost: true });
            }
          } catch (scErr) { }
        }
        throw uErr;
      }
    }

    const userFeed = client.ig.feed.user(userId);
    const page = await userFeed.items();

    if (!page || page.length === 0) {
      return res.json({ ok: false, error: 'NO_POSTS' });
    }

    // Urutkan postingan berdasarkan waktu upload terbaru (taken_at)
    const sorted = [...page].sort((a, b) => (b.taken_at || 0) - (a.taken_at || 0));
    const latestPost = sorted[0];
    try {
      await client.like(latestPost.pk);
    } catch (e1) {
      await client.ig.media.like({
        mediaId: latestPost.pk,
        moduleInfo: {
          module_name: 'profile',
          user_id: userId,
          username: latestPost.user ? latestPost.user.username : undefined,
        },
        d: 0,
      });
    }

    res.json({ ok: true, mediaId: latestPost.pk, shortcode: latestPost.code, username: latestPost.user ? latestPost.user.username : undefined });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/like/comment', async (req, res) => {
  try {
    const { cookies, ua, commentId } = req.body;
    const client = await getExtClient(cookies, ua);
    await client.ig.media.likeComment(commentId.toString());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/media/comments', async (req, res) => {
  try {
    const { cookies, ua, shortcode, limit = 50 } = req.body;
    const client = await getExtClient(cookies, ua);

    // Gunakan helper internal untuk resolusi ID media dari URL/Shortcode
    const mediaId = await client.getMediaIdByUrl(`https://www.instagram.com/p/${shortcode}/`);
    const commentFeed = client.ig.feed.mediaComments(mediaId);

    let allComments = [];
    while (allComments.length < limit) {
      const items = await commentFeed.items();
      if (!items.length) break;
      allComments = allComments.concat(items);
      if (!commentFeed.isMoreAvailable()) break;
    }

    res.json({ ok: true, mediaId: String(mediaId), comments: allComments.slice(0, limit) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/media/comment', async (req, res) => {
  try {
    const { cookies, ua, mediaId, text, replyToCommentId, target } = req.body;
    // Strip BOM and whitespace, convert to ASCII-safe string
    const cleanText = (text || '').replace(/^\uFEFF/, '').trim();
    if (!cleanText) return res.status(400).json({ ok: false, error: 'Teks komentar tidak boleh kosong.' });

    const client = await getExtClient(cookies, ua);
    let resolvedMediaId = mediaId;
    if (!resolvedMediaId && target) {
      const parsed = parsePostOrAccount(target);
      if (parsed.type === 'post') {
        resolvedMediaId = parsed.mediaId || (await client.getMediaIdByUrl(parsed.shortcode || target));
      } else if (/^[a-zA-Z0-9_-]{9,15}$/.test(target)) {
        try {
          resolvedMediaId = await client.getMediaIdByUrl(target);
        } catch (errSc) { }
      }
    }

    if (!resolvedMediaId) return res.status(400).json({ ok: false, error: 'mediaId tidak boleh kosong.' });
    addLog('info', `[Comment] Kirim ke media ${resolvedMediaId}: "${cleanText.substring(0, 30)}"`);
    const result = await client.comment(resolvedMediaId, cleanText, replyToCommentId);
    res.json({ ok: true, comment: result, mediaId: resolvedMediaId });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/extension/setup-files/comment', (req, res) => {
  try {
    const dir = path.join(SETUP_DIR, 'comment');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/extension/setup-file/comment', (req, res) => {
  try {
    const { filename } = req.query;
    const filePath = path.join(SETUP_DIR, 'comment', path.basename(filename));
    if (!fs.existsSync(filePath)) throw new Error('File not found');
    // Strip BOM (Windows UTF-8 with BOM) and normalize line endings
    let content = fs.readFileSync(filePath, 'utf8')
      .replace(/^\uFEFF/, '')         // strip BOM
      .replace(/\r\n/g, '\n')         // CRLF -> LF
      .replace(/\r/g, '\n');          // CR -> LF
    res.json({ ok: true, content });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---- Log Management ------------------
app.get('/api/extension/logs/stream', (req, res) => {
  const username = (req.query.username || '__global__').toLowerCase();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  const clients = getSseClients(username);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(':\n\n'); } catch (e) { } }, 15000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.get('/api/extension/logs', (req, res) => {
  const qUser = (req.query.username || '__global__').toLowerCase();
  let logs = [...getLogBuffer(qUser)];
  if (qUser !== '__global__') {
    const globalLogs = getLogBuffer('__global__');
    logs = [...logs, ...globalLogs];
  }
  res.json({ ok: true, logs });
});

app.post('/api/extension/logs/clear', (req, res) => {
  const username = req.query.username || req.body.username;
  if (username) { if (logsByUser.has(username.toLowerCase())) logsByUser.get(username.toLowerCase()).length = 0; }
  else logsByUser.forEach(buf => buf.length = 0);
  res.json({ ok: true });
});

// In-memory cache for converted batch videos across multi-account story posts
const storyBatchVideoCache = new Map();

// ---- Multimedia (Story & Feed) --------------------------
app.post('/api/extension/story', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  let tmpFile = null;
  let convertedFile = null;
  let batchId = null;
  try {
    const {
      cookies, linkUrl, linkTitle, linkFontSize, highlightName, overlayText,
      storyX = '0.5', storyY = '0.75', storyScale = '1.0', storyRotation = '0',
      storyColor = '#ffffff', storyTextColor = '#0095f6', storyRadius = '15',
      showIcon = 'true', storyFont = '', ua, blur, blurValue, mute, iconScale = '0.8',
      totalAccounts, accountIndex
    } = req.body;
    batchId = req.body.batchId || null;

    // --- CRITICAL: Identify uploaded files immediately for cleanup ---
    if (req.files) {
      if (req.files['video'] && req.files['video'][0]) tmpFile = req.files['video'][0].path;
      else if (req.files['image'] && req.files['image'][0]) tmpFile = req.files['image'][0].path;
    }

    const client = await getExtClient(cookies, ua);

    // Bind engine logger to this user for real-time streaming
    client.setLogger((type, msg, user) => addLog(type, msg, user || client.username));

    let type = 'photo';

    if (req.files['video'] && req.files['video'][0]) {
      const rawVideoPath = req.files['video'][0].path;
      type = 'video';

      if (batchId) {
        let cache = storyBatchVideoCache.get(batchId);
        if (!cache) {
          const cacheConvertedFile = rawVideoPath + '_batch_converted.mp4';
          const total = parseInt(totalAccounts) || 1;

          const convertPromise = (async () => {
            console.log(chalk`{cyan [story-batch] Mengonversi shared video sekali untuk batch ${batchId}... (Blur=${blur === 'true'}, Mute=${mute === 'true'})}`);
            await convertToMp4(rawVideoPath, cacheConvertedFile, {
              blur: blur === 'true',
              blurValue: parseInt(blurValue) || 20,
              mute: mute === 'true'
            });
            console.log(chalk`{cyan [story-batch] Konversi shared video selesai.}`);
            return cacheConvertedFile;
          })();

          const timer = setTimeout(() => {
            if (fs.existsSync(cacheConvertedFile)) {
              try { fs.unlinkSync(cacheConvertedFile); } catch (e) {}
            }
            storyBatchVideoCache.delete(batchId);
          }, 5 * 60 * 1000);

          cache = {
            filePath: cacheConvertedFile,
            remaining: total,
            total,
            convertPromise,
            timer
          };
          storyBatchVideoCache.set(batchId, cache);
        }

        convertedFile = await cache.convertPromise;
      } else {
        // Single non-batch conversion: if already MP4, pass directly to single-pass engine in index.js
        const originalName = (req.files['video'][0].originalname || '').toLowerCase();
        const isMp4 = rawVideoPath.toLowerCase().endsWith('.mp4') || originalName.endsWith('.mp4');

        if (isMp4) {
          convertedFile = rawVideoPath;
          console.log(chalk`{cyan [story] Video berformat MP4 terdeteksi. Melewati konversi ganda langsung ke single-pass engine 1080p.}`);
        } else {
          convertedFile = rawVideoPath + '_converted.mp4';
          console.log(chalk`{cyan [story] Mengonversi format non-MP4 (${originalName}) ke MP4...}`);
          await convertToMp4(rawVideoPath, convertedFile, { blur: false, mute: false });
          console.log(chalk`{cyan [story] Konversi format selesai.}`);
        }
      }
    } else if (req.files['image'] && req.files['image'][0]) {
      type = 'photo';
    }

    if (!tmpFile) throw new Error('No media file uploaded');

    let finalLinkText = (linkTitle || '').trim();
    if (!finalLinkText && linkUrl) {
      try { finalLinkText = new URL(linkUrl.startsWith('http') ? linkUrl : 'https://' + linkUrl).hostname.replace('www.', ''); } catch { finalLinkText = linkUrl.slice(0, 20); }
    }

    const storyOptions = {
      linkUrl,
      linkTitle: finalLinkText,
      showIcon: showIcon === 'true',
      iconScale: parseFloat(iconScale) || 0.8,
      x: storyX,
      y: storyY,
      color: storyColor,
      textColor: storyTextColor,
      radius: storyRadius,
      scale: storyScale,
      rotation: storyRotation,
      fontSize: linkFontSize,
      fontFile: (() => {
        if (!storyFont || storyFont === 'default') return '';
        if (fs.existsSync(path.join(FONTS_DIR, storyFont))) return path.join(FONTS_DIR, storyFont);
        if (fs.existsSync(path.join(__dirname, 'fonts', storyFont))) return path.join(__dirname, 'fonts', storyFont);
        return '';
      })(),
      overlayText,
      highlightName,
      blur: blur === 'true',
      blurValue: parseInt(blurValue) || 20,
      mute: mute === 'true'
    };

    const finalFilePath = convertedFile || tmpFile;
    const result = await client.publishStory(finalFilePath, type, storyOptions);
    if (!result || (result.status && result.status !== 'ok')) {
      throw new Error(result?.message || 'Instagram rejected the story post.');
    }

    if (highlightName && result?.media) {
      try {
        const mediaId = String(result.media.id || result.media.pk);
        addLog('info', `Menambahkan story ke highlight "${highlightName}"...`, client.username);
        // Delay 2.5s to ensure story is indexed on Instagram's CDN
        await new Promise(r => setTimeout(r, 2500));
        await client.ensureHighlight(mediaId, highlightName);
        addLog('ok', `Berhasil menambahkan ke highlight "${highlightName}"!`, client.username);
      } catch (highlightErr) {
        addLog('warn', `Gagal menambahkan ke highlight (mungkin karena delay indeks Instagram): ${highlightErr.message}`, client.username);
      }
    }
    res.json({ ok: true, mediaId: result?.media?.id });
  } catch (e) {
    console.error(chalk`{red [story] Error: ${e.message}}`);
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    // Robust cleanup in finally block
    if (tmpFile && fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (e) { } }

    if (batchId && storyBatchVideoCache.has(batchId)) {
      const cache = storyBatchVideoCache.get(batchId);
      cache.remaining--;
      if (cache.remaining <= 0) {
        clearTimeout(cache.timer);
        if (cache.filePath && fs.existsSync(cache.filePath)) {
          try {
            fs.unlinkSync(cache.filePath);
            console.log(chalk`{cyan [story-batch] Seluruh akun batch ${batchId} selesai, cache video berhasil dihapus bersih.}`);
          } catch (e) { }
        }
        storyBatchVideoCache.delete(batchId);
      }
    } else {
      if (convertedFile && fs.existsSync(convertedFile)) { try { fs.unlinkSync(convertedFile); } catch (e) { } }
    }
  }
});

// ---- Feed (Single Post: Photo & Video) -------------------
app.post(['/api/extension/feed', '/api/extension/feed/post'], upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
  let tmpFile = null;
  let coverFile = null;
  try {
    const { cookies, caption, ua, mediaType } = req.body;
    let isVideo = false;

    if (req.files) {
      if (req.files['video'] && req.files['video'][0]) {
        tmpFile = req.files['video'][0].path;
        isVideo = true;
      } else if (req.files['file'] && req.files['file'][0]) {
        tmpFile = req.files['file'][0].path;
      } else if (req.files['image'] && req.files['image'][0]) {
        tmpFile = req.files['image'][0].path;
      }
    } else if (req.file) {
      tmpFile = req.file.path;
    }

    if (!tmpFile) throw new Error('No media file uploaded');

    // Deep video detection: check mediaType field, original filename, mime, and magic bytes
    if (!isVideo) {
      if (mediaType === 'video') isVideo = true;
      const originalName = (req.files?.image?.[0]?.originalname || req.files?.file?.[0]?.originalname || req.file?.originalname || '').toLowerCase();
      if (['.mp4', '.mov', '.mkv', '.avi', '.webm'].some(ext => originalName.endsWith(ext))) isVideo = true;
      const mime = (req.files?.image?.[0]?.mimetype || req.files?.file?.[0]?.mimetype || req.file?.mimetype || '').toLowerCase();
      if (mime.startsWith('video/')) isVideo = true;

      // Check magic bytes of the file:
      if (!isVideo && fs.existsSync(tmpFile)) {
        try {
          const fd = fs.openSync(tmpFile, 'r');
          const buf = Buffer.alloc(32);
          fs.readSync(fd, buf, 0, 32, 0);
          fs.closeSync(fd);
          if (buf.toString('ascii', 4, 8) === 'ftyp' || buf.toString('ascii', 4, 8) === 'moov' || (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3)) {
            isVideo = true;
          }
        } catch (e) { }
      }
    }

    // Ensure video file has proper .mp4 extension for ffmpeg and Instagram processor
    if (isVideo && !tmpFile.toLowerCase().endsWith('.mp4') && !tmpFile.toLowerCase().endsWith('.mov')) {
      const properVideoPath = tmpFile + '.mp4';
      try {
        fs.renameSync(tmpFile, properVideoPath);
        tmpFile = properVideoPath;
      } catch (e) { }
    }

    const client = await getExtClient(cookies, ua);
    client.setLogger((type, msg, user) => addLog(type, msg, user || client.username));

    let result;
    if (isVideo) {
      addLog('info', '[feed] Mempersiapkan media feed...', client.username);
      const tmpDir = path.join(DATA_DIR, 'tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      coverFile = path.join(tmpDir, `feed_cover_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`);
      await generateVideoCover(tmpFile, coverFile);
      addLog('info', '[feed] Mengunggah feed', client.username);
      result = await client.publishVideo(tmpFile, coverFile, caption || '');
      addLog('ok', '[feed] Berhasil diposting! ✨', client.username);
    } else {
      addLog('info', '[feed] Mempersiapkan media feed...', client.username);
      addLog('info', '[feed] Mengunggah feed', client.username);
      result = await client.publishPhoto(tmpFile, caption || '');
      addLog('ok', '[feed] Berhasil diposting! ✨', client.username);
    }

    res.json({ ok: true, mediaId: result?.media?.pk || result?.media?.id });
  } catch (e) {
    console.error(chalk`{red [feed] Error: ${e.message}}`);
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (e) { } }
    if (coverFile && fs.existsSync(coverFile)) { try { fs.unlinkSync(coverFile); } catch (e) { } }
  }
});

// ---- Feed (Post dari Folder: Photo & Video) --------------
app.post('/api/extension/feed/post-local', async (req, res) => {
  let coverFile = null;
  try {
    const { cookies, filename, caption, folderName, ua } = req.body;
    const client = await getExtClient(cookies, ua);
    client.setLogger((type, msg, user) => addLog(type, msg, user || client.username));
    let targetFolder = folderName || 'media/feed';
    let baseDir = path.join(DATA_DIR, targetFolder);
    const autoFeedDir = path.join(baseDir, 'feed');
    if (fs.existsSync(autoFeedDir) && fs.lstatSync(autoFeedDir).isDirectory()) {
      targetFolder = path.join(targetFolder, 'feed').replace(/\\/g, '/');
    }
    const filePath = path.join(DATA_DIR, targetFolder, filename);

    if (!fs.existsSync(filePath)) throw new Error(`File tidak ditemukan: ${targetFolder}/${filename}`);

    const ext = path.extname(filename).toLowerCase();
    const isVideo = ['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(ext);

    addLog('info', `[feed] Mengunggah feed: ${filename}`, client.username);
    let result;
    if (isVideo) {
      const tmpDir = path.join(DATA_DIR, 'tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      coverFile = path.join(tmpDir, `feed_cover_${Date.now()}_${path.basename(filename, ext)}.jpg`);
      await generateVideoCover(filePath, coverFile);
      result = await client.publishVideo(filePath, coverFile, caption || '');
    } else {
      result = await client.publishPhoto(filePath, caption || '');
    }

    if (result && (result.status === 'ok' || result.media)) {
      addLog('ok', `[feed] Berhasil diposting! ✨`, client.username);
      res.json({ ok: true, mediaId: result?.media?.pk || result?.media?.id });
    } else {
      throw new Error(result?.message || 'Gagal posting ke Instagram.');
    }
  } catch (e) {
    console.error(chalk`{red [feed] Error posting local: ${e.message}}`);
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    if (coverFile && fs.existsSync(coverFile)) { try { fs.unlinkSync(coverFile); } catch (e) { } }
  }
});


app.post('/api/extension/like-latest', async (req, res) => {
  try {
    const { cookies, userId, count = 1, ua } = req.body;
    const client = await getExtClient(cookies, ua);

    let items = [];
    try {
      const feed = client.ig.feed.user(userId);
      items = await feed.items();
    } catch (feedErr) {
      console.error(`Feed fetch failed for ${userId}:`, feedErr.message);
      return res.json({ ok: true, liked: 0, error: feedErr.message });
    }

    if (!items.length) {
      return res.json({ ok: true, liked: 0, message: 'No posts found' });
    }

    // Urutkan postingan berdasarkan waktu upload terbaru (taken_at)
    if (Array.isArray(items)) {
      items.sort((a, b) => (b.taken_at || 0) - (a.taken_at || 0));
    }

    let likedCount = 0;
    for (let i = 0; i < Math.min(items.length, count); i++) {
      try {
        await client.like(items[i].pk);
        likedCount++;
        if (i < Math.min(items.length, count) - 1) {
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        }
      } catch (err) {
        console.error(`Like failed for ${items[i].pk}:`, err.message);
      }
    }
    res.json({ ok: true, liked: likedCount });
  } catch (e) {
    res.json({ ok: true, liked: 0, error: e.message }); // Return ok:true even on general error to avoid blocking the caller
  }
});

// ---- Profile Management ----------------------------------
app.post('/api/extension/profile/bio', async (req, res) => {
  try {
    const { cookies, biography, ua } = req.body;
    const client = await getExtClient(cookies, ua);
    await client.updateProfile({ biography: biography || '' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/profile/edit', async (req, res) => {
  try {
    const { cookies, ua, biography, fullName, externalUrl, gender, chainingEnabled } = req.body;
    const client = await getExtClient(cookies, ua);
    await client.updateProfile({ biography, fullName, externalUrl, gender, chainingEnabled });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/extension/profile/data', async (req, res) => {
  try {
    const cookies = req.headers['x-ig-cookies'];
    const ua = req.headers['x-ig-ua'];
    if (!cookies) return res.status(401).json({ ok: false, error: 'No cookies' });
    const client = await getExtClient(cookies, ua);
    const profile = await client.getProfileData();
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/extension/profile/pic', upload.single('image'), async (req, res) => {
  let tmpFile = null;
  try {
    const { cookies, ua } = req.body;
    if (req.file) tmpFile = req.file.path;
    const client = await getExtClient(cookies, ua);
    if (!req.file) throw new Error('No image');
    await client.setProfilePicture(tmpFile);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (e) { } }
  }
});

// Update Profile Fields (Bio, Name, External Link, Gender)
app.post('/api/extension/profile/edit', async (req, res) => {
  try {
    const { cookies, ua, ...params } = req.body;
    const client = await getExtClient(cookies, ua);
    const result = await client.updateProfile(params);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Set External Link (Bio Link - Instagrapi Spec update_bio_links/)
app.post('/api/extension/profile/links', async (req, res) => {
  try {
    const { cookies, ua, url, title } = req.body;
    const linkUrl = url || req.body.linkUrl;
    const linkTitle = title || req.body.linkTitle || '';
    if (!linkUrl) return res.status(400).json({ ok: false, error: 'URL link required' });
    const client = await getExtClient(cookies, ua);
    const result = await client.setExternalUrl(linkUrl, linkTitle);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Dedicated Native Biography Endpoint
app.post('/api/extension/profile/bio', async (req, res) => {
  try {
    const { cookies, ua, biography } = req.body;
    const client = await getExtClient(cookies, ua);
    const result = await client.setNativeBiography(biography || '');
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Remove Bio Links Endpoint
app.post('/api/extension/profile/remove-links', async (req, res) => {
  try {
    const { cookies, ua, linkIds } = req.body;
    const client = await getExtClient(cookies, ua);
    const result = await client.removeBioLinks(linkIds || []);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Bulk Feed Info (Using consolidated endpoints)
app.get('/api/extension/feed/bulk-info', (req, res) => {
  let folderName = req.query.folderName || 'media/feed';
  const captionFile = req.query.captionFile;
  const mediaType = req.query.mediaType || 'all';

  let feedDir = path.join(DATA_DIR, folderName);
  const autoFeedDir = path.join(feedDir, 'feed');
  if (fs.existsSync(autoFeedDir) && fs.lstatSync(autoFeedDir).isDirectory()) {
    feedDir = autoFeedDir;
    folderName = path.join(folderName, 'feed').replace(/\\/g, '/');
  }

  let images = [];
  if (fs.existsSync(feedDir)) {
    images = fs.readdirSync(feedDir).filter(f => {
      if (f.includes('_unique_') || f.includes('_converted') || f.includes('_cover')) return false;
      const ext = path.extname(f).toLowerCase();
      const isPhoto = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
      const isVideo = ['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(ext);
      if (mediaType === 'photo') return isPhoto;
      if (mediaType === 'video') return isVideo;
      return isPhoto || isVideo;
    });
  }

  let captions = [];
  if (captionFile) {
    const capFile = path.join(DATA_DIR, captionFile);
    if (fs.existsSync(capFile)) captions = fs.readFileSync(capFile, 'utf8').split('|').map(l => l.trim()).filter(l => l.length > 0);
  }
  res.json({ ok: true, images, captions, resolvedFolder: folderName });
});

app.get('/api/extension/feed/bulk-progress', (req, res) => {
  try {
    const { username } = req.query;
    const progressFile = path.join(DATA_DIR, 'bulk_feed_progress.json');
    let progress = {};
    if (fs.existsSync(progressFile)) progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));

    // Ensure both legacy indices and new postedMedia history are returned
    const userProgress = progress[username] || {
      lastImageIndex: 0,
      lastCaptionIndex: 0,
      postedMedia: []
    };
    if (!userProgress.postedMedia) userProgress.postedMedia = [];

    res.json({ ok: true, progress: userProgress });
  } catch (e) {
    res.json({ ok: true, progress: { lastImageIndex: 0, lastCaptionIndex: 0, postedMedia: [] } });
  }
});


app.post('/api/extension/feed/bulk-progress', (req, res) => {
  try {
    const { username, lastImageIndex, lastCaptionIndex, postedMedia } = req.body;
    if (!username) throw new Error('Username required');
    const progressFile = path.join(DATA_DIR, 'bulk_feed_progress.json');
    let progress = {};
    if (fs.existsSync(progressFile)) progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));

    const existing = progress[username] || { lastImageIndex: 0, lastCaptionIndex: 0, postedMedia: [] };

    progress[username] = {
      lastImageIndex: typeof lastImageIndex !== 'undefined' ? lastImageIndex : existing.lastImageIndex,
      lastCaptionIndex: typeof lastCaptionIndex !== 'undefined' ? lastCaptionIndex : existing.lastCaptionIndex,
      postedMedia: postedMedia || existing.postedMedia || []
    };

    fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});


// ---- DM Template Routes ---------------------------------
// DM_DIR is defined globally at the top

// List .txt files inside server/dm/
app.get('/api/extension/dm/templates', (req, res) => {
  try {
    if (!fs.existsSync(DM_DIR)) return res.json({ ok: true, files: [] });
    const files = fs.readdirSync(DM_DIR).filter(f => f.toLowerCase().endsWith('.txt'));
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ ok: false, files: [], error: e.message });
  }
});

// Read content of a specific template file
app.get('/api/extension/dm/template', (req, res) => {
  try {
    const { filename } = req.query;
    if (!filename) return res.status(400).json({ ok: false, error: 'filename required' });
    // Security: only allow simple filenames (no path traversal)
    const safe = path.basename(filename);
    if (!safe.toLowerCase().endsWith('.txt')) return res.status(400).json({ ok: false, error: 'Only .txt allowed' });
    const filePath = path.join(DM_DIR, safe);
    if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'File not found. Letakkan file .txt ke dalam folder server/dm/' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ ok: true, content });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Add Log (From Background.js) -----------------------
app.post('/api/extension/logs/add', (req, res) => {
  try {
    const { message, type, username } = req.body;
    addLog(type || 'info', message || '', username);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Port & Listen
const PORT = process.env.PORT || 7500;
server.listen(PORT);
