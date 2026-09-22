// middleware/guestGate.js
// Blocks all user-facing pages unless the visitor has a valid invite token.
// Admin routes (/api/auth, /admin/*) are always allowed.
// Disable by setting { "enabled": false } in invite_tokens.json

'use strict';
const fs   = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, '../invite_tokens.json');
const COOKIE_NAME = 'xloop_invite';
const COOKIE_DAYS = 30;

// ── In-memory token cache (avoids blocking fs.readFileSync on every request) ──
let _cache      = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 30_000; // re-read file every 30 seconds at most

function loadTokens() {
  const now = Date.now();
  if (_cache && now < _cacheExpiry) return _cache;
  try {
    _cache      = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    _cacheExpiry = now + CACHE_TTL_MS;
    return _cache;
  } catch {
    // File missing or malformed — gate disabled
    _cache      = { enabled: false, members: [] };
    _cacheExpiry = now + CACHE_TTL_MS;
    return _cache;
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
}

module.exports = function guestGate(req, res, next) {
  const config = loadTokens();

  // Gate disabled — let everyone through
  if (!config.enabled) return next();

  // Bypass for local development
  if (req.hostname === 'localhost' || req.hostname === '127.0.0.1') {
    return next();
  }

  const p = req.path;

  // Always open: auth endpoint + health check + denied page + favicon
  if (
    p.startsWith('/api/auth') ||
    p === '/api/health' ||
    p === '/invite-denied.html' ||
    p === '/favicon.ico'
  ) return next();

  // Admin pages use their own JWT auth — bypass gate
  if (p.startsWith('/admin/') || p === '/admin.html') return next();

  // Static assets — allow so that the denied page can load CSS/JS
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
      const expires = new Date(Date.now() + COOKIE_DAYS * 86_400_000).toUTCString();
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(inviteParam)}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`
      );
      // Redirect to the original page (without the invite param in the URL)
      const redirectTo = req.path || '/';
      return res.redirect(redirectTo);
    }
  }

  // No valid token — show denied page
  return res.redirect('/invite-denied.html');
};
