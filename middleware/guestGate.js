// middleware/guestGate.js
// Blocks all user-facing pages unless the visitor has a valid invite token.
// Admin routes (/api/auth, /api/import, /api/scrape, /admin.html) are always allowed.
// Disable by setting tokens.enabled = false in invite_tokens.json

'use strict';
const fs   = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, '../invite_tokens.json');
const COOKIE_NAME = 'xloop_invite';
const COOKIE_DAYS = 30;

// Routes that bypass the gate entirely
const OPEN_PATHS = [
  '/api/auth',
  '/api/health',
  '/invite-denied.html',
];

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return { enabled: false, members: [] }; }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.split('=')[1] : null;
}

module.exports = function guestGate(req, res, next) {
  const config = loadTokens();

  // Gate disabled — let everyone through
  if (!config.enabled) return next();

  // If you are accessing it locally (localhost or 127.0.0.1), bypass the gate
  if (req.hostname === 'localhost' || req.hostname === '127.0.0.1') {
    return next();
  }

  // Always open: API auth + admin routes + denied page
  const p = req.path;
  if (
    p.startsWith('/api/auth') ||
    p.startsWith('/api/health') ||
    p === '/invite-denied.html' ||
    p === '/favicon.ico'
  ) return next();

  // Admin pages — skip gate (they have their own auth)
  if (p === '/admin.html' || p.startsWith('/api/')) return next();

  // CSS/JS/images — skip gate so denied page can load its own assets
  if (/\.(css|js|svg|png|jpg|jpeg|webp|woff2?|ico)$/.test(p)) return next();

  // Check cookie first
  const cookieToken = getCookie(req, COOKIE_NAME);
  if (cookieToken && config.members.some(m => m.token === cookieToken)) {
    return next();
  }

  // Check ?invite= query param
  const inviteParam = req.query.invite;
  if (inviteParam) {
    const member = config.members.find(m => m.token === inviteParam);
    if (member) {
      // Set a 30-day cookie so they don't need the link every time
      const expires = new Date(Date.now() + COOKIE_DAYS * 86400000).toUTCString();
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${inviteParam}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`
      );
      // Redirect to home without the token in the URL
      return res.redirect('/');
    }
  }

  // No valid token — show denied page
  return res.redirect('/invite-denied.html');
};
