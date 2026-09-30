const jwt = require('jsonwebtoken');

module.exports = function (req, res, next) {
  // Guard: JWT_SECRET must be set (server.js already crashes at startup if missing,
  // but this is a defensive belt-and-suspenders check for the middleware itself)
  if (!process.env.JWT_SECRET) {
    console.error('[auth] JWT_SECRET is not configured — rejecting all auth requests');
    return res.status(500).json({ message: 'Server misconfiguration: auth unavailable' });
  }

  const authHeader = req.headers['authorization'];
  // SSE routes (EventSource) cannot send headers — accept token as query param fallback
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ message: 'Access denied. No token.' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    // Distinguish between expired and invalid tokens for better client feedback
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired. Please log in again.' });
    }
    res.status(403).json({ message: 'Invalid token.' });
  }
};
