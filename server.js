require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const guestGate = require('./middleware/guestGate');

// ── Fail fast if critical env vars are missing ──────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[FATAL] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[FATAL] Please check your .env file.');
  process.exit(1);
}

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Bypass localtunnel browser warning page
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});

// ── Invite-only gate ──────────────────────────────────────────────────────────
app.use(guestGate);
app.use(express.static(path.join(__dirname, 'public')));

// ── DB readiness guard ────────────────────────────────────────────────────────
// Returns 503 immediately when DB is not connected instead of buffering for 10s.
// The user sees a clear error instead of the cryptic "buffering timed out" message.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health') return next(); // always allow health check
  const state = mongoose.connection.readyState;
  // 1 = connected — anything else means not ready
  if (state !== 1) {
    const label = ['disconnected','connected','connecting','disconnecting'][state] || 'unknown';
    console.warn(`[DB Guard] ${req.method} ${req.path} rejected — DB: ${label}`);
    return res.status(503).json({
      message: 'Database not connected. Please wait a moment and try again.',
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

// Health check (no auth, no DB guard)
app.get('/api/health', (req, res) => {
  const state = mongoose.connection.readyState;
  const label = ['disconnected','connected','connecting','disconnecting'][state] || 'unknown';
  res.json({ status: label === 'connected' ? 'ok' : 'degraded', db: label, uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// 404 for unknown API routes
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: `Route ${req.method} ${req.path} not found` });
  next();
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Global error handler — MUST be last
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[Server Error]', err.message, err.stack);
  res.status(err.status || err.statusCode || 500).json({ message: err.message || 'Internal server error' });
});

// Prevent silent crashes
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]', reason));
process.on('uncaughtException',  (err)    => console.error('[Uncaught Exception]', err));

// ── MongoDB — connect FIRST, listen AFTER ────────────────────────────────────
// family:4               → force IPv4; prevents IPv6 resolution hangs on mobile/WiFi
// serverSelectionTimeoutMS → fail fast instead of hanging for 30s (default)
// app.listen() is inside .then() so the server never starts without a DB connection
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS:         10_000,
  socketTimeoutMS:          45_000,
  family:                   4,
  maxPoolSize:              10,
  minPoolSize:              2,
};

const PORT = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGODB_URI, MONGO_OPTS)
  .then(async () => {
    console.log('Connected to MongoDB Atlas');
    await seedAdmin();
    app.listen(PORT, '0.0.0.0', () => console.log(`Xloop running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection FAILED:', err.message);
    console.error('Check: MONGODB_URI in .env | Atlas IP whitelist | network');
    process.exit(1);
  });

// Connection lifecycle
mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected — API will return 503 until reconnected.'));
mongoose.connection.on('reconnected',  () => console.log('MongoDB reconnected.'));
mongoose.connection.on('error',       (e) => console.error('MongoDB error:', e.message));

// ── Admin seeder ──────────────────────────────────────────────────────────────
async function seedAdmin() {
  try {
    const Admin  = require('./models/Admin');
    const bcrypt = require('bcryptjs');
    const exists = await Admin.findOne({ username: 'admin' });
    if (!exists) {
      const hash = await bcrypt.hash('xloop@admin123', 10);
      await Admin.create({ username: 'admin', password: hash });
      console.log('Admin seeded: username=admin password=xloop@admin123');
    }
  } catch (err) {
    console.error('Admin seed error (non-fatal):', err.message);
  }
}
