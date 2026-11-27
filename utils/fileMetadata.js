/**
 * utils/fileMetadata.js  — NEW in v7
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized file size, year, and metadata validation utilities.
 * Used by pipeline_full.js, routes/orchestrator.js, and import routes.
 *
 * Exports:
 *   parseFileSizeToBytes(str)             → number | null
 *   formatBytes(bytes, decimals)          → string  ("1.50 GB")
 *   validateFileSizeVsQuality(str, q)     → { valid, warning, bytes }
 *   extractYearFromString(str)            → number | null
 *   extractAllYears(str)                  → number[]
 *   isPlausibleReleaseYear(year)          → boolean
 *   fileSizePlausibilityReport(item)      → { status, details }
 */
'use strict';

const CURRENT_YEAR = new Date().getFullYear();

// ─── Size Parsing ─────────────────────────────────────────────────────────────

/**
 * parseFileSizeToBytes — parse a size string to bytes.
 * Supports: "1.5 GB", "800MB", "2.3GiB", "1,200 MB", "14 GB", "512 KiB"
 * Returns null if not parseable or nonsensical.
 */
function parseFileSizeToBytes(str) {
  if (str == null) return null;
  if (typeof str === 'number' && Number.isFinite(str) && str > 0) return str;
  const s = String(str).replace(/,/g, '').replace(/\s+/g, ' ').trim();
  const match = s.match(/([\d.]+)\s*(TB|TiB|GB|GiB|MB|MiB|KB|KiB|B)\b/i);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const unit   = match[2].toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const factor = unit.startsWith('T') ? 1024 ** 4
    : unit.startsWith('G') ? 1024 ** 3
    : unit.startsWith('M') ? 1024 ** 2
    : unit.startsWith('K') ? 1024 : 1;
  return Math.round(amount * factor);
}

/**
 * formatBytes — human-readable file size.
 * @param {number} bytes
 * @param {number} decimals
 * @returns {string}  e.g. "1.50 GB"
 */
function formatBytes(bytes, decimals = 2) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k    = 1024;
  const dm   = Math.max(0, decimals);
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i    = Math.floor(Math.log(bytes) / Math.log(k));
  const idx  = Math.min(i, sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, idx)).toFixed(dm)) + ' ' + sizes[idx];
}

// ─── Quality-aware file size plausibility ────────────────────────────────────

const SIZE_EXPECTATIONS = {
  '8k':   { min: 20 * 1024 ** 3, warn: 50 * 1024 ** 3,   label: '8K' },
  '4k':   { min: 2 * 1024 ** 3,  warn: 8 * 1024 ** 3,    label: '4K/2160p' },
  '2160': { min: 2 * 1024 ** 3,  warn: 8 * 1024 ** 3,    label: '4K/2160p' },
  '1080': { min: 300 * 1024 ** 2,warn: 1 * 1024 ** 3,    label: '1080p' },
  '720':  { min: 100 * 1024 ** 2,warn: 400 * 1024 ** 2,  label: '720p' },
  '480':  { min: 50 * 1024 ** 2, warn: 150 * 1024 ** 2,  label: '480p' },
  '360':  { min: 20 * 1024 ** 2, warn: 80 * 1024 ** 2,   label: '360p' },
};

/**
 * validateFileSizeVsQuality — sanity-check file size against quality tier.
 * @param {string|number} sizeStr  — size string or bytes
 * @param {string} quality         — e.g. "4K", "1080p", "HD"
 * @returns {{ valid: boolean, warning: string|null, bytes: number|null }}
 */
function validateFileSizeVsQuality(sizeStr, quality) {
  const bytes = parseFileSizeToBytes(sizeStr);
  if (!bytes) return { valid: false, warning: 'Could not parse file size', bytes: null };
  if (bytes < 1024 * 1024) return { valid: false, warning: `File is only ${formatBytes(bytes)} — likely corrupt or incomplete`, bytes };

  const q = String(quality || '').toLowerCase();
  for (const [key, { min, warn, label }] of Object.entries(SIZE_EXPECTATIONS)) {
    if (q.includes(key)) {
      if (bytes < min) {
        return { valid: false, warning: `${label} file is only ${formatBytes(bytes)} — expected ≥ ${formatBytes(min)}`, bytes };
      }
      if (bytes < warn) {
        return { valid: true, warning: `${label} file is ${formatBytes(bytes)} — lower than typical (${formatBytes(warn)}+)`, bytes };
      }
      return { valid: true, warning: null, bytes };
    }
  }
  return { valid: true, warning: null, bytes };
}

// ─── Year Extraction ─────────────────────────────────────────────────────────

/**
 * isPlausibleReleaseYear — returns true if year is a valid media release year.
 * Allows 1888 (oldest film) through next year.
 */
function isPlausibleReleaseYear(year) {
  const n = Number(year);
  return Number.isInteger(n) && n >= 1888 && n <= CURRENT_YEAR + 1;
}

/**
 * extractYearFromString — extract the most plausible release year from a string.
 * Uses context-aware scoring:
 *   - 4-digit sequences matching release year range
 *   - Preceded/followed by common year delimiters ( . _ [ ( )
 *   - More recent years scored higher (assume recent releases more common)
 *
 * Guards against years that are part of titles like "2001: A Space Odyssey",
 * "1917", "2012", "2010" — these are protected when the year IS the title.
 *
 * @param {string} str
 * @returns {number|null}
 */
function extractYearFromString(str) {
  if (!str) return null;
  const s = String(str);
  // Find all 4-digit year candidates with delimiter context
  const yearRe = /(?:^|[\s._\-\[(])((19|20)\d{2})(?:[\s._\-\])]|$)/g;
  const candidates = [];
  let m;
  while ((m = yearRe.exec(s)) !== null) {
    const y = Number(m[1]);
    if (isPlausibleReleaseYear(y)) {
      // Check if this year is the title itself or at the start (title year)
      const isTitleYear = m.index === 0 || (m.index <= 2 && s.trim().startsWith(m[1]));
      candidates.push({ year: y, pos: m.index, isTitleYear });
    }
  }
  if (!candidates.length) return null;
  // Prefer non-title years (they're more likely release year metadata)
  // Among equals, prefer more recent
  const nonTitle = candidates.filter(c => !c.isTitleYear);
  const pool     = nonTitle.length > 0 ? nonTitle : candidates;
  pool.sort((a, b) => b.year - a.year || a.pos - b.pos);
  return pool[0].year;
}

/**
 * extractAllYears — extract all plausible release years from a string (deduped, sorted desc).
 */
function extractAllYears(str) {
  if (!str) return [];
  const s      = String(str);
  const yearRe = /(?:^|[\s._\-\[(])((19|20)\d{2})(?:[\s._\-\])]|$)/g;
  const found  = new Set();
  let m;
  while ((m = yearRe.exec(s)) !== null) {
    const y = Number(m[1]);
    if (isPlausibleReleaseYear(y)) found.add(y);
  }
  return [...found].sort((a, b) => b - a);
}

// ─── Full plausibility report ─────────────────────────────────────────────────

/**
 * fileSizePlausibilityReport — comprehensive check for a download entry.
 * @param {{ size, quality, codec, year, title }} item
 * @returns {{ status: 'ok'|'warn'|'error', details: string[] }}
 */
function fileSizePlausibilityReport(item) {
  const details = [];
  let hasError = false;
  let hasWarn  = false;

  const sizeCheck = validateFileSizeVsQuality(item?.size, item?.quality);
  if (!sizeCheck.valid) {
    details.push('❌ ' + (sizeCheck.warning || 'Invalid file size'));
    hasError = true;
  } else if (sizeCheck.warning) {
    details.push('⚠️  ' + sizeCheck.warning);
    hasWarn = true;
  }

  // Year sanity
  const year = Number(item?.year);
  if (item?.year && !isPlausibleReleaseYear(year)) {
    details.push(`⚠️  Year ${year} is outside plausible release range (1888–${CURRENT_YEAR + 1})`);
    hasWarn = true;
  }

  // Size vs year: very old 4K file is suspicious (4K didn't exist pre-2007)
  if (year && year < 2007 && String(item?.quality || '').toLowerCase().includes('4k')) {
    details.push(`⚠️  4K file for a ${year} production — verify source`);
    hasWarn = true;
  }

  if (!details.length) details.push('✅ All checks passed');

  return {
    status:  hasError ? 'error' : (hasWarn ? 'warn' : 'ok'),
    details,
    bytes:   sizeCheck.bytes,
    sizeStr: sizeCheck.bytes ? formatBytes(sizeCheck.bytes) : null,
  };
}

module.exports = {
  parseFileSizeToBytes,
  formatBytes,
  validateFileSizeVsQuality,
  extractYearFromString,
  extractAllYears,
  isPlausibleReleaseYear,
  fileSizePlausibilityReport,
};
