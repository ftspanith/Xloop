require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const guestGate = require('./middleware/guestGate');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Bypass localtunnel's browser warning page automatically
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  next();
});

// ── Invite-only gate (check before serving static files) ──
app.use(guestGate);

app.use(express.static(path.join(__dirname, 'public')));

// Connect MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log(' Connected to MongoDB Atlas');
    await seedAdmin();
  })
  .catch(err => console.error(' MongoDB Error:', err));

// Routes
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/movies',      require('./routes/movies'));
app.use('/api/series',      require('./routes/series'));
app.use('/api/search',      require('./routes/search'));
app.use('/api/import',      require('./routes/import'));
app.use('/api/scrape',      require('./routes/scrape'));
app.use('/api/orchestrator',require('./routes/orchestrator'));

// 404 handler
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: `Route ${req.method} ${req.path} not found` });
  }
  next();
});

// Global error handler — catches any thrown/unhandled errors from routes
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[Server Error]', err.message, err.stack);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ message: err.message || 'Internal server error' });
});

// Fallback: serve index.html for unknown routes (must come after API routes + error handler)
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Prevent silent crashes from unhandled rejections
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(` Xloop running → http://localhost:${PORT}`));

async function seedAdmin() {
  const Admin = require('./models/Admin');
  const bcrypt = require('bcryptjs');
  const exists = await Admin.findOne({ username: 'admin' });
  if (!exists) {
    const hash = await bcrypt.hash('xloop@admin123', 10);
    await Admin.create({ username: 'admin', password: hash });
    console.log(' Admin seeded → username: admin | password: xloop@admin123');
  }
}
