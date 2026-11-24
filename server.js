require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const compression = require('compression');
const guestGate  = require('./middleware/guestGate');

// ── Warn if critical env vars are missing (do not exit, Vercel will 500) ────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.warn(`[WARNING] Missing critical env vars: ${missing.join(', ')}. App will likely fail!`);
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
    if (req.path.includes('/stream') || req.path.includes('/start')) return false;
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
// Authenticated/admin reads must always reflect the live database. Only public
// GET responses may use the short CDN/browser cache below.
app.use('/api/', (req, res, next) => {
  const isAuthenticated = Boolean(req.headers.authorization);
  const noCache = req.method !== 'GET'
    || isAuthenticated
    || req.path.startsWith('/auth')
    || req.path.startsWith('/import')
    || req.path.startsWith('/orchestrator')
    || req.path.startsWith('/scrape')
    || req.path === '/health';

  if (noCache) {
    res.setHeader('Cache-Control', 'no-store');
    return next();
  }

  // Cache only public responses, and never override a route's explicit no-store.
  const origJson = res.json.bind(res);
  res.json = function (body) {
    const status = res.statusCode;
    const existingCacheControl = String(res.getHeader('Cache-Control') || '');
    const explicitlyNoStore = /\\bno-store\\b/i.test(existingCacheControl);

    if (status >= 200 && status < 300 && !explicitlyNoStore) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=30, stale-while-revalidate=120');
    } else if (!explicitlyNoStore) {
      // Error responses are NEVER cached.
      res.setHeader('Cache-Control', 'no-store');
    }
    return origJson(body);
  };
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

// ── DB readiness guard — wait up to 8s for cold-start connection ─────────────
// On Vercel, MongoDB takes 2-5s to connect. Instead of immediately returning
// 503, we poll readyState up to 8 seconds before giving up.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health')    return next();

  if (mongoose.connection.readyState === 1) return next();

  // Wait up to 8 seconds for the DB to become ready (cold start)
  const MAX_WAIT_MS  = 8000;
  const POLL_INTERVAL = 200;
  let waited = 0;

  while (mongoose.connection.readyState !== 1 && waited < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    waited += POLL_INTERVAL;
  }

  if (mongoose.connection.readyState !== 1) {
    const state = mongoose.connection.readyState;
    const label = ['disconnected','connected','connecting','disconnecting'][state] || 'unknown';
    return res.status(503).json({
      message: 'Database not ready. Please try again in a moment.',
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
process.on('uncaughtException',  (err)    => console.error('[UncaughtException]', err.message));

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 15_000,   // find a server (was 10s)
  connectTimeoutMS:         15_000,   // initial connect (was 10s)
  socketTimeoutMS:          120_000,  // per-op timeout — was 45s, need 120s for bulk insertMany
  heartbeatFrequencyMS:     10_000,
  family:                   4,        // IPv4 only — no IPv6 DNS hangs
  maxPoolSize:              30,        // was 10 — pipeline + uploads run concurrently
  minPoolSize:              3,         // keep 3 warm connections
  waitQueueTimeoutMS:       30_000,   // max time to wait for a connection from the pool
};

const PORT = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGODB_URI, MONGO_OPTS)
  .then(async () => {
    console.log('[DB] Connected to MongoDB Atlas');
    await seedAdmin();
    // Do not start listener in Vercel — Vercel handles requests directly via module.exports
    if (!process.env.VERCEL) {
      app.listen(PORT, '0.0.0.0', () => console.log(`[Server] Xloop running on :${PORT}`));
    }
  })
  .catch(err => {
    console.error('[DB] Connection FAILED:', err.message);
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

// ── Export for Vercel Serverless ─────────────────────────────────────────────
module.exports = app;
