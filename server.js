require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const compression = require('compression');
const guestGate  = require('./middleware/guestGate');

// ── Fail fast if critical env vars are missing ──────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[FATAL] Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Minimal request logger (replaces morgan — avoids log spam) ───────────────
// Only logs errors (4xx/5xx) in production, logs all in dev
if (!IS_PROD) {
  app.use((req, _res, next) => {
    // Dev-only: log incoming API requests
    if (req.path.startsWith('/api/')) process.stdout.write(`→ ${req.method} ${req.path}\n`);
    next();
  });
}

// ── Gzip compression (cuts response size 60-80%) ─────────────────────────────
app.use(compression({
  level: 6,           // balanced speed vs compression ratio
  threshold: 1024,    // only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress SSE streams
    if (req.path.includes('/stream')) return false;
    return compression.filter(req, res);
  }
}));

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));        // was 50mb — no API needs 50mb
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Bypass localtunnel browser warning page
app.use((_req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});

// ── Request timeout — prevents hung requests tying up serverless slots ────────
// Any API call that takes more than 12 seconds will get a 503 automatically
app.use('/api/', (req, res, next) => {
  const TIMEOUT_MS = 12_000;
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ message: 'Request timed out. Please try again.' });
    }
  }, TIMEOUT_MS);
  res.on('finish', () => clearTimeout(timer));
  res.on('close',  () => clearTimeout(timer));
  next();
});

// ── HTTP caching headers for public API routes ────────────────────────────────
// Reduces repeat DB hits from same user (browser caches API responses)
app.use('/api/', (req, res, next) => {
  // Never cache auth, admin, or write operations
  const noCache = req.method !== 'GET'
    || req.path.startsWith('/auth')
    || req.path.startsWith('/import')
    || req.path.startsWith('/orchestrator')
    || req.path.startsWith('/scrape')
    || req.path === '/health';

  if (noCache) {
    res.setHeader('Cache-Control', 'no-store');
  } else {
    // Public read routes: cache in browser for 60s, CDN for 30s
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=30, stale-while-revalidate=120');
  }
  next();
});

// ── Invite-only gate ──────────────────────────────────────────────────────────
app.use(guestGate);

// ── Static files with caching ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: IS_PROD ? '1d' : 0,    // cache static assets 1 day in prod
  etag: true,
  lastModified: true,
}));

// ── DB readiness guard ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health')    return next();
  const state = mongoose.connection.readyState;
  if (state !== 1) {
    const label = ['disconnected','connected','connecting','disconnecting'][state] || 'unknown';
    // Removed console.warn here — this fires on EVERY request when DB is down,
    // flooding logs. The 503 response tells the client everything it needs.
    return res.status(503).json({
      message: 'Database not ready. Please wait a moment and try again.',
      db: label,
    });
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/movies',       require('./routes/movies'));
app.use('/api/series',       require('./routes/series'));
app.use('/api/search',       require('./routes/search'));
app.use('/api/import',       require('./routes/import'));
app.use('/api/scrape',       require('./routes/scrape'));
app.use('/api/orchestrator', require('./routes/orchestrator'));

// ── Health check (no auth, no DB guard, no cache) ────────────────────────────
app.get('/api/health', (req, res) => {
  const state = mongoose.connection.readyState;
  const label = ['disconnected','connected','connecting','disconnecting'][state] || 'unknown';
  res.json({
    status: label === 'connected' ? 'ok' : 'degraded',
    db: label,
    uptime: Math.floor(process.uptime()),
    mem: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    ts: new Date().toISOString(),
  });
});

// ── 404 for unknown API routes ────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: `${req.method} ${req.path} not found` });
  next();
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Global error handler (MUST be last) ──────────────────────────────────────
app.use((err, req, res, _next) => { // eslint-disable-line no-unused-vars
  console.error(`[Error] ${req.method} ${req.path} →`, err.message);
  res.status(err.status || err.statusCode || 500).json({ message: err.message || 'Internal server error' });
});

// ── Process-level error guards (prevent silent crashes) ──────────────────────
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]', reason?.message || reason));
process.on('uncaughtException',  (err)    => { console.error('[UncaughtException]', err.message); process.exit(1); });

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS:         10_000,
  socketTimeoutMS:          45_000,
  heartbeatFrequencyMS:     10_000,
  family:                   4,       // IPv4 only — no IPv6 DNS hangs
  maxPoolSize:              10,
  minPoolSize:              2,
};

const PORT = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGODB_URI, MONGO_OPTS)
  .then(async () => {
    console.log('[DB] Connected to MongoDB Atlas');
    await seedAdmin();
    app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Xloop running on :${PORT}`));
  })
  .catch(err => {
    console.error('[DB] Connection FAILED:', err.message);
    process.exit(1);
  });

// Connection lifecycle — minimal, non-spammy
mongoose.connection.on('disconnected', () => console.warn('[DB] Disconnected — returning 503 until reconnected'));
mongoose.connection.on('reconnected',  () => console.log('[DB] Reconnected'));
mongoose.connection.on('error',        (e) => console.error('[DB] Error:', e.message));

// ── Admin seeder ──────────────────────────────────────────────────────────────
async function seedAdmin() {
  try {
    const Admin  = require('./models/Admin');
    const bcrypt = require('bcryptjs');
    const exists = await Admin.findOne({ username: 'admin' });
    if (!exists) {
      const hash = await bcrypt.hash('xloop@admin123', 10);
      await Admin.create({ username: 'admin', password: hash });
      console.log('[Admin] Default admin account created');
    }
  } catch (err) {
    console.error('[Admin] Seed error (non-fatal):', err.message);
  }
}
