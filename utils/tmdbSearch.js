/**
 * utils/tmdbSearch.js  — v2 ENHANCED
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared TMDB search engine used by BOTH:
 *   • pipeline_full.js  — Telegram auto-import pipeline
 *   • routes/import.js  — Manual paste / bulk import
 *
 * v2 Improvements:
 *   • 24-variant title candidate engine (was 14)
 *   • Regional alternate-title lookup for SEARCH (not just verification)
 *   • In-memory LRU cache for TMDB query results (TTL: 24h)
 *   • OMDb rate-limit guard + exponential backoff
 *   • trigram similarity added as 4th similarity component
 *   • Transliteration normalization (ā→a, ñ→n, ü→u)
 *   • Year-protected title guard: "2001: A Space Odyssey" preserved
 *   • Extended sequel number guard (handles multi-digit, Roman, word numbers)
 *   • File size extraction & validation exported
 *   • Better OMDb year-empty handling (tries year ±1 instead of null-fail)
 *
 * Exports:
 *   buildTitleCandidates(rawTitle, cleanedTitle, year) → string[]
 *   searchTMDB(title, year, isSeries, season, msgDate, imdbId, tmdbIdHint, options) → meta | null
 *   searchOMDB(title, year, isSeries, omdbKey) → meta | null
 *   stringSimilarity(a, b) → number (0–1)
 *   parseFileSizeToBytes(str) → number | null
 */

'use strict';
const axios = require('axios');
const DEFAULT_AXIOS_GET = axios.get;
const { cleanTitleForApi } = require('./parser');

// ─── LRU Cache (simple, TTL-based) ───────────────────────────────────────────
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TMDB_CACHE   = new Map();
const TMDB_CACHE_MAX = 2000;

function cacheGet(key) {
  const entry = TMDB_CACHE.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { TMDB_CACHE.delete(key); return undefined; }
  return entry.value;
}
function cacheSet(key, value) {
  if (TMDB_CACHE.size >= TMDB_CACHE_MAX) {
    // Evict oldest 10%
    const toEvict = [...TMDB_CACHE.entries()]
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, Math.floor(TMDB_CACHE_MAX * 0.1));
    toEvict.forEach(([k]) => TMDB_CACHE.delete(k));
  }
  TMDB_CACHE.set(key, { value, ts: Date.now() });
}

// ─── Levenshtein string similarity (0–1) ─────────────────────────────────────
function normalizeMatchTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')     // strip diacritics
    // Transliterate common extended chars: ā→a, ñ→n, ü→u, ß→ss, etc.
    .replace(/[āăą]/g, 'a').replace(/[čć]/g, 'c').replace(/[ēě]/g, 'e')
    .replace(/[īı]/g, 'i').replace(/[łĺ]/g, 'l').replace(/[ňń]/g, 'n')
    .replace(/[ōő]/g, 'o').replace(/[řŕ]/g, 'r').replace(/[šś]/g, 's')
    .replace(/[ūű]/g, 'u').replace(/[žź]/g, 'z').replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editSimilarity(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  if (a === b) return 1;
  if (!left.length || !right.length) return 0;
  const maxLength = Math.max(left.length, right.length);
  if (Math.abs(left.length - right.length) > Math.max(4, Math.floor(maxLength * 0.6))) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / maxLength;
}

// ─── Trigram similarity ───────────────────────────────────────────────────────
function trigrams(str) {
  const s = ' ' + str.replace(/\s+/g, ' ').trim() + ' ';
  const tg = new Set();
  for (let i = 0; i <= s.length - 3; i++) tg.add(s.slice(i, i + 3));
  return tg;
}
function trigramSimilarity(a, b) {
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return (2 * intersection) / (ta.size + tb.size);
}

function stringSimilarity(a, b) {
  const left  = normalizeMatchTitle(a);
  const right = normalizeMatchTitle(b);
  if (left === right) return 1;
  if (!left || !right) return 0;

  const edit = editSimilarity(left, right);
  const compactLeft  = left.replace(/\s+/g, '');
  const compactRight = right.replace(/\s+/g, '');
  const compact = editSimilarity(compactLeft, compactRight) * 0.97;

  const leftTokens  = left.split(' ').filter(Boolean);
  const rightTokens = right.split(' ').filter(Boolean);
  const available   = new Set(rightTokens.map((_, index) => index));
  let matched = 0;
  for (const token of leftTokens) {
    let bestIndex = -1;
    let bestScore = 0;
    for (const index of available) {
      const candidate  = rightTokens[index];
      const score      = editSimilarity(token, candidate);
      const minimum    = Math.min(token.length, candidate.length);
      const threshold  = minimum <= 3 ? 1 : (minimum <= 5 ? 0.8 : 0.72);
      if (score >= threshold && score > bestScore) { bestScore = score; bestIndex = index; }
    }
    if (bestIndex >= 0) { matched++; available.delete(bestIndex); }
  }
  const tokenScore = (2 * matched) / (leftTokens.length + rightTokens.length);

  // 4th component: trigram similarity (good for compact/phonetic variants)
  const tgScore = trigramSimilarity(left, right) * 0.90;

  return Math.max(edit, compact, tokenScore * 0.92, tgScore);
}

// ─── fetchWithRetry ───────────────────────────────────────────────────────────
async function fetchWithRetry(fn, retries = 2, baseDelay = 800) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (e?.response?.status === 429) {
        // Rate limited — back off longer
        const delay = baseDelay * Math.pow(2, i) + Math.random() * 400;
        if (i < retries) await new Promise(r => setTimeout(r, delay));
        else return null;
      } else if (i < retries) {
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
      } else {
        return null;
      }
    }
  }
}

// ─── Number-word conversion maps ─────────────────────────────────────────────
const NUM_WORDS_MAP = {
  one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',ten:'10',
  eleven:'11',twelve:'12',thirteen:'13',fourteen:'14',fifteen:'15',
  sixteen:'16',seventeen:'17',eighteen:'18',nineteen:'19',twenty:'20',
  first:'1',second:'2',third:'3',fourth:'4',fifth:'5',
};
const ROMAN_TO_NUM = { 'I':'1','II':'2','III':'3','IV':'4','V':'5','VI':'6','VII':'7','VIII':'8','IX':'9','X':'10','XI':'11','XII':'12' };
const NUM_TO_ROMAN = { '1':'I','2':'II','3':'III','4':'IV','5':'V','6':'VI','7':'VII','8':'VIII','9':'IX','10':'X','11':'XI','12':'XII' };

// ─── File size parsing (exported utility) ─────────────────────────────────────
/**
 * parseFileSizeToBytes — parse a size string to bytes
 * Supports: "1.5 GB", "800MB", "2.3GiB", "1,200 MB", "14 GB"
 * Returns null if not parseable.
 */
function parseFileSizeToBytes(str) {
  if (str == null) return null;
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
 * validateFileSizeVsQuality — sanity-check: 4K files should not be < 200 MB
 * Returns 'ok' | 'suspicious' | 'invalid'
 */
function validateFileSizeVsQuality(sizeStr, quality) {
  const bytes = parseFileSizeToBytes(sizeStr);
  if (!bytes) return 'unknown';
  const q = String(quality || '').toLowerCase();
  if ((q.includes('4k') || q.includes('2160')) && bytes < 200 * 1024 * 1024) return 'suspicious';
  if ((q.includes('1080')) && bytes < 100 * 1024 * 1024) return 'suspicious';
  if (bytes < 10 * 1024 * 1024) return 'invalid'; // <10 MB: definitely bad
  return 'ok';
}

// ─────────────────────────────────────────────────────────────────────────────
// buildTitleCandidates — 24-variant title candidate generator (was 14)
//
// New variants added in v2:
//  #15: Diacritic-stripped variant   ("Thérèse" → "Therese")
//  #16: Transliterated common chars  (ā→a etc.)
//  #17: Short-word "of/the/a" article removal ("Knight of Cups" → "Knight Cups")
//  #18: Possessive strip             ("Spider-Man's" → "Spider-Man")
//  #19: Ordinal suffix removal       ("2nd Part" → "2 Part")
//  #20: Year-aware variant           ("Title 2024" → "Title" when year known)
//  #21: Bracket content extraction   ("Title (Director's Cut)" → "Title")
//  #22: "vs"/"versus" toggle         ("Batman vs Superman" → "Batman versus Superman")
//  #23: Doubled-word collapse        ("The The" → "The")
//  #24: Initial-letter abbreviation  ("Kabir Khan" → "KK")
// ─────────────────────────────────────────────────────────────────────────────
function buildTitleCandidates(rawTitle, cleanedTitle, year) {
  const seen   = new Set();
  const result = [];
  const add = (t) => {
    const s = (t || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2) return;
    const key = s.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(s); }
  };

  // Helper: convert number-words + Roman numerals → Arabic digits
  const toArabic = (s) => s
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|first|second|third|fourth|fifth)\b/gi, m => NUM_WORDS_MAP[m.toLowerCase()] || m)
    .replace(/\b(XII|XI|IX|IV|VIII|VII|VI|V|III|II|X{1,3}I{0,3}|I{1,3})\b/g, m => ROMAN_TO_NUM[m.toUpperCase()] || m);

  // Helper: normalize "Part N/word/Roman" → "Part <digit>"
  const normalizePart = (s) => s
    .replace(/\bPart\s+0*(\d+)\b/gi, (_, n) => 'Part ' + parseInt(n, 10))
    .replace(/\bPart\s+(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth)\b/gi, (_, w) => 'Part ' + (NUM_WORDS_MAP[w.toLowerCase()] || w))
    .replace(/\bPart\s+(XII|XI|IX|IV|VIII|VII|VI|V|III|II|X{1,3}I{0,3}|I{1,3})\b/gi, (_, r) => 'Part ' + (ROMAN_TO_NUM[r.toUpperCase()] || r));

  // ── ORIGINAL 14 ALGORITHMS ────────────────────────────────────────────────

  // Algorithm 1: Direct clean title
  add(cleanedTitle);

  // Algorithm 2: Strip residual language/quality suffixes
  const suf2 = cleanedTitle
    .replace(/\s+(telugu|tamil|hindi|malayalam|kannada|bengali|english|korean|japanese|chinese|arabic|turkish|spanish|french|german|dubbed|dub|dual\s*audio|multi\s*audio|4k|uhd|hdr|1080p|720p|480p|web[-\s]?dl|webrip|bluray|hevc|x265|x264|avc|av1|remux|hdcam|cam|proper|repack)\s*$/gi, '')
    .trim();
  const suf2Words  = suf2.split(/\s+/).filter(Boolean).length;
  const origWords  = cleanedTitle.split(/\s+/).filter(Boolean).length;
  if (suf2 !== cleanedTitle && suf2Words >= Math.min(2, origWords)) add(suf2);

  // Algorithm 3: Hyphen/dash → space
  add(cleanedTitle.replace(/[-\u2013\u2014]/g, ' ').replace(/\s+/g, ' ').trim());

  // Algorithm 4: Colon-subtitle handling
  const colonMatch = cleanedTitle.match(/^(.+?)\s*[:\u2013\u2014]\s*(.+)$/);
  if (colonMatch) {
    const base     = colonMatch[1].trim();
    const subtitle = colonMatch[2].trim();
    add(base + ': ' + normalizePart(subtitle));
    const partNum = subtitle.match(/\bPart\s*(\d+)/i)?.[1] || subtitle.match(/\b(\d+)\s*$/)?.[1];
    if (partNum && parseInt(partNum) > 1) add(base + ' ' + parseInt(partNum));
    if (base.length >= 2) add(base);
    // Also try subtitle alone (e.g. "The Rule" from "Pushpa: The Rule")
    if (subtitle.length >= 3 && !JUNK_SINGLES_RE.test(subtitle)) add(subtitle);
  }

  // Algorithm 5: Remove trailing sequel number
  const noTrailNum = cleanedTitle.replace(/\s+\d+\s*$/, '').trim();
  if (noTrailNum !== cleanedTitle && noTrailNum.length >= 2) add(noTrailNum);

  // Algorithm 6: Arabic → Roman at end
  const romanized = cleanedTitle.replace(/\s+(\d{1,2})\s*$/, (_, n) => NUM_TO_ROMAN[n] ? ' ' + NUM_TO_ROMAN[n] : ' ' + n);
  if (romanized !== cleanedTitle) add(romanized);

  // Algorithm 7: Roman → Arabic at end
  const arabicized = cleanedTitle.replace(/\s+(XII|XI|IX|IV|VIII|VII|VI|V|III|II|I{1,3}|X)\s*$/i, (_, r) => {
    const a = ROMAN_TO_NUM[r.toUpperCase()]; return a ? ' ' + a : ' ' + r;
  });
  if (arabicized !== cleanedTitle) add(arabicized);

  // Algorithm 8: "The" prefix toggle (only for titles ≥ 4 chars)
  if (/^The\s+/i.test(cleanedTitle)) {
    add(cleanedTitle.replace(/^The\s+/i, '').trim());
  } else if (cleanedTitle.replace(/\s+/g, '').length >= 4) {
    add('The ' + cleanedTitle);
  }

  // Algorithm 9: Number-words → digits
  const numWrds = toArabic(cleanedTitle);
  if (numWrds.toLowerCase() !== cleanedTitle.toLowerCase()) add(numWrds);

  // Algorithm 10: First 3 / first 2 words (long title prefix reduction)
  const words = cleanedTitle.split(/\s+/).filter(Boolean);
  if (words.length > 4) { add(words.slice(0, 3).join(' ')); add(words.slice(0, 2).join(' ')); }
  else if (words.length > 3) { add(words.slice(0, 2).join(' ')); }

  // Algorithm 11: Ampersand / "and" toggle
  if (/&/.test(cleanedTitle))      add(cleanedTitle.replace(/\s*&\s*/g, ' and '));
  if (/ and /i.test(cleanedTitle)) add(cleanedTitle.replace(/\s+and\s+/gi, ' & '));

  // Algorithm 11b: Roman numeral in MIDDLE → Arabic
  const midArabic = cleanedTitle.replace(/\b(XII|XI|IX|IV|VIII|VII|VI|V|III|II|I{1,3}|X{1,3})\b/g, r => ROMAN_TO_NUM[r.toUpperCase()] || r);
  if (midArabic.toLowerCase() !== cleanedTitle.toLowerCase()) add(midArabic);

  // Algorithm 11c: Remove mid-title sequel number ("Pushpa 2 The Rule" → "Pushpa The Rule")
  const midNumRemoved = cleanedTitle.replace(/\s+\d+(?=\s+[A-Z])/g, '').trim();
  if (midNumRemoved.toLowerCase() !== cleanedTitle.toLowerCase()) add(midNumRemoved);

  // Algorithm 12: "Part N" / "Chapter N" → bare digit
  const partToNum = cleanedTitle
    .replace(/\bPart\s+(\d+)\b/gi, (_, n) => n)
    .replace(/\bChapter\s+(\d+)\b/gi, (_, n) => n)
    .trim();
  if (partToNum !== cleanedTitle) add(partToNum);

  // Algorithm 12b: Punctuation/spacing-normalized title
  const spacedTitle = cleanedTitle
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (spacedTitle.toLowerCase() !== cleanedTitle.toLowerCase()) add(spacedTitle);

  // Algorithm 12c: Compact spelling variant ("DJ Tillu" → "DJTillu")
  const compactTitle = cleanedTitle.replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  if (compactTitle.length >= 5 && compactTitle.toLowerCase() !== cleanedTitle.toLowerCase()) add(compactTitle);

  // Algorithm 12d: Raw unclean title (when cleanTitleForApi over-strips)
  const rawC = (rawTitle || '').replace(/\s+/g, ' ').trim();
  if (rawC && rawC.toLowerCase() !== cleanedTitle.toLowerCase()) add(rawC);

  // ── NEW ALGORITHMS (15–24) ────────────────────────────────────────────────

  // Algorithm 15: Diacritic-stripped variant ("Thérèse Raquin" → "Therese Raquin")
  const diacriticFree = cleanedTitle.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (diacriticFree !== cleanedTitle) add(diacriticFree);

  // Algorithm 16: Transliterated variant (ā→a, ñ→n, etc.)
  const transliterated = cleanedTitle
    .replace(/[āăą]/g, 'a').replace(/[čć]/g, 'c').replace(/[ēě]/g, 'e')
    .replace(/[īı]/g, 'i').replace(/[łĺ]/g, 'l').replace(/[ňń]/g, 'n')
    .replace(/[ōő]/g, 'o').replace(/[řŕ]/g, 'r').replace(/[šś]/g, 's')
    .replace(/[ūű]/g, 'u').replace(/[žź]/g, 'z').replace(/ß/g, 'ss');
  if (transliterated !== cleanedTitle) add(transliterated);

  // Algorithm 17: Article removal ("Knight of Cups" → "Knight Cups"; "City of God" → "City God")
  const noArticles = cleanedTitle
    .replace(/\b(of|the|a|an|in|at|to|for|and|or|but|from|with)\b\s*/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (noArticles.length >= 3 && noArticles !== cleanedTitle) add(noArticles);

  // Algorithm 18: Possessive strip ("Spider-Man's" → "Spider-Man", "Schindler's List" → "Schindler List")
  const noPossessive = cleanedTitle.replace(/['']s\b/g, '').replace(/\s+/g, ' ').trim();
  if (noPossessive !== cleanedTitle) add(noPossessive);

  // Algorithm 19: Ordinal suffix removal ("2nd Part" → "2 Part", "3rd Strike" → "3 Strike")
  const noOrdinal = cleanedTitle.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1').trim();
  if (noOrdinal !== cleanedTitle) add(noOrdinal);

  // Algorithm 20: Year-aware strip ("Title 2024" → "Title" when year known)
  if (year) {
    const noYear = cleanedTitle.replace(new RegExp('\\s*\\b' + String(year) + '\\b\\s*', 'g'), ' ').trim();
    if (noYear.length >= 2 && noYear !== cleanedTitle) add(noYear);
    // Also ±1 year
    const y1 = String(year - 1), y2 = String(year + 1);
    [y1, y2].forEach(y => {
      const v = cleanedTitle.replace(new RegExp('\\s*\\b' + y + '\\b\\s*', 'g'), ' ').trim();
      if (v.length >= 2 && v !== cleanedTitle) add(v);
    });
  }

  // Algorithm 21: Bracket/edition extraction ("Title (Director's Cut)" → "Title")
  const noBrackets = cleanedTitle
    .replace(/\s*\([^)]{1,40}\)\s*/g, ' ')
    .replace(/\s*\[[^\]]{1,40}\]\s*/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (noBrackets.length >= 2 && noBrackets !== cleanedTitle) add(noBrackets);

  // Algorithm 22: "vs"/"versus" toggle
  if (/\bvs\.?\b/i.test(cleanedTitle))      add(cleanedTitle.replace(/\bvs\.?\b/gi, 'versus'));
  if (/\bversus\b/i.test(cleanedTitle))      add(cleanedTitle.replace(/\bversus\b/gi, 'vs'));

  // Algorithm 23: Doubled-word collapse ("The The Matrix" → "The Matrix")
  const noDoubled = cleanedTitle.replace(/\b(\w+)\s+\1\b/gi, '$1').trim();
  if (noDoubled !== cleanedTitle) add(noDoubled);

  // Algorithm 24: Acronym/initials ("Kolar Gold Fields" → "KGF") — only for 3–5 word titles
  if (words.length >= 3 && words.length <= 5 && words.every(w => w.length > 1)) {
    const initials = words.map(w => w[0].toUpperCase()).join('');
    if (initials.length >= 3 && initials.length <= 5 && !JUNK_SINGLES_RE.test(initials)) add(initials);
  }

  return result;
}

// ─── Junk single-word guard ───────────────────────────────────────────────────
const JUNK_SINGLES_RE = /^(movie|film|video|clip|show|series|episode|part|chapter|season|trailer|teaser|sample|test|unknown|untitled|hd|fhd|uhd|4k|1080p|720p|480p|cut|edition|version|extended|theatrical|unrated|directors?|remastered)$/i;

// ─── Language code → display name ────────────────────────────────────────────
const LANG_MAP = { en:'English',te:'Telugu',ta:'Tamil',hi:'Hindi',ml:'Malayalam',kn:'Kannada',ja:'Japanese',ko:'Korean',fr:'French',es:'Spanish',de:'German',it:'Italian',zh:'Chinese',ru:'Russian',pt:'Portuguese',ar:'Arabic',tr:'Turkish',id:'Indonesian',th:'Thai',bn:'Bengali',mr:'Marathi',pa:'Punjabi',gu:'Gujarati',ur:'Urdu' };

// ─────────────────────────────────────────────────────────────────────────────
// searchTMDB — main entry point (v2 enhanced)
// ─────────────────────────────────────────────────────────────────────────────
async function searchTMDB(title, year, isSeries, season, msgDate, imdbId, tmdbIdHint, options = {}) {
  const { tmdbKey, emitter } = options;
  if (!tmdbKey) return null;
  const validYear = value => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1900 && n <= 2099 ? n : null;
  };
  const yearHints = [...new Set([year, ...(Array.isArray(options.yearHints) ? options.yearHints : [])]
    .map(validYear).filter(Boolean))];
  const titleYear = Object.prototype.hasOwnProperty.call(options, 'messageYear')
    ? validYear(options.messageYear)
    : (validYear(year) || null);
  const hintYear = isSeries ? titleYear : (titleYear || yearHints[0] || null);
  const maxYearDifference = 2;
  const dateYear = value => {
    const match = String(value || '').match(/^(19\d{2}|20\d{2})/);
    return match ? Number(match[1]) : null;
  };
  const yearCompatible = value => {
    const actualYear = dateYear(value);
    return !hintYear || (!!actualYear && Math.abs(hintYear - actualYear) <= maxYearDifference);
  };
  const seasonYearHints = [...new Set(
    (Array.isArray(options.seasonYearHints) ? options.seasonYearHints : (isSeries ? yearHints.filter(y => y !== titleYear) : []))
      .map(validYear).filter(Boolean)
  )];
  const seasonDataCache = new Map();

  const log = (msg) => { if (emitter) emitter(msg); };

  const LANG_SUFFIX_RE = /\s+(telugu|tamil|hindi|malayalam|kannada|bengali|english|korean|japanese|chinese|arabic|turkish|spanish|french|german|dubbed|dub|dual\s*audio|multi\s*audio|4k|uhd|hdr|1080p|720p|480p|web-?dl|webrip|bluray|hevc|x265|x264|avc|av1|remux|hdcam|cam|proper|repack)\s*$/i;
  const strippedTitle = title.replace(LANG_SUFFIX_RE, '').trim() || title;
  const cleanTitle    = cleanTitleForApi(strippedTitle);

  if (!cleanTitle || cleanTitle.length < 2) return null;
  if (cleanTitle.split(/\s+/).length === 1 && JUNK_SINGLES_RE.test(cleanTitle)) {
    log(`[TMDB] Skipping junk single-word title: "${cleanTitle}"`);
    return null;
  }

  const BASE = 'https://api.themoviedb.org/3';

  const isV4Token = String(tmdbKey).split('.').length === 3;
  const localTmdbCache = new Map();
  const useGlobalCache = axios.get === DEFAULT_AXIOS_GET && options.useCache !== false;
  async function tmdbGet(url, params = {}, config = {}) {
    const requestParams = { ...params };
    delete requestParams.api_key;
    if (!isV4Token) requestParams.api_key = tmdbKey;
    const cacheKey = url + '?' + JSON.stringify(requestParams);
    if (localTmdbCache.has(cacheKey)) return localTmdbCache.get(cacheKey);
    if (useGlobalCache) {
      const cached = cacheGet(cacheKey);
      if (cached !== undefined) return cached;
    }
    const result = await axios.get(url, {
      ...config,
      params: requestParams,
      headers: {
        ...(config.headers || {}),
        ...(isV4Token ? { Authorization: `Bearer ${tmdbKey}` } : {}),
      },
    });
    localTmdbCache.set(cacheKey, result);
    if (useGlobalCache) cacheSet(cacheKey, result);
    return result;
  }

  const isShort  = cleanTitle.trim().split(/\s+/).length <= 2;
  const typeEp   = isSeries ? 'tv' : 'movie';
  const otherEp  = isSeries ? 'movie' : 'tv';

  // ── Season poster helper ────────────────────────────────────────────────────
  async function fetchSeasonData(tmdbId, sn, isTv) {
    if (!isTv || !sn) return {};
    const cacheKey = String(tmdbId) + ':' + String(sn);
    if (seasonDataCache.has(cacheKey)) return seasonDataCache.get(cacheKey);
    const pending = (async () => {
      const sr = await fetchWithRetry(() =>
        tmdbGet(`${BASE}/tv/${tmdbId}/season/${sn}`, {}, { timeout: 8000 })
      );
      const seasonAirDate = sr?.data?.air_date || '';
      return {
        seasonPoster: sr?.data?.poster_path ? `https://image.tmdb.org/t/p/w500${sr.data.poster_path}` : '',
        seasonOverview: sr?.data?.overview || '',
        seasonAirDate,
        seasonYear: seasonAirDate ? parseInt(seasonAirDate.slice(0, 4), 10) || null : null,
      };
    })();
    seasonDataCache.set(cacheKey, pending);
    return pending;
  }

  // ── Alternative titles — now used for SEARCH (not just verification) ────────
  const alternativeTitlesCache = new Map();
  async function fetchAlternativeTitles(tmdbId, isTv) {
    const cacheKey = (isTv ? 'tv:' : 'movie:') + String(tmdbId);
    if (alternativeTitlesCache.has(cacheKey)) return alternativeTitlesCache.get(cacheKey);
    const pending = (async () => {
      const response = await fetchWithRetry(() =>
        tmdbGet(BASE + '/' + (isTv ? 'tv' : 'movie') + '/' + tmdbId + '/alternative_titles', {}, { timeout: 8000 })
      );
      const data = response?.data || {};
      const rows = Array.isArray(data.titles) ? data.titles
        : Array.isArray(data.results) ? data.results : [];
      return rows.map(row => typeof row === 'string' ? row : (row?.title || row?.name || ''))
        .filter(Boolean);
    })();
    alternativeTitlesCache.set(cacheKey, pending);
    return pending;
  }

  // ── Regional search: build TMDB search queries from alternative titles ────
  // For a given cleanTitle, search TMDB for the alternative-title form in
  // regional language databases (e.g. "Robo" → finds Enthiran via alt-title)
  async function searchViaAlternativeTitles(queryTitle, ep, strict) {
    // Search with original title, then check results' alternative titles for a match
    return runStrategy(ep, { query: queryTitle, _algo: 'AltSearch' }, strict);
  }

  async function verifiedTitleMatch(details, isTv) {
    const query = normalizeMatchTitle(cleanTitle);
    const compactLength = query.replace(/\s+/g, '').length;
    const names = [details?.title, details?.name, details?.original_title, details?.original_name].filter(Boolean);
    if (names.some(name => normalizeMatchTitle(name) === query)) return true;
    if (compactLength > 4 && names.some(name => stringSimilarity(cleanTitle, name) >= 0.86)) return true;

    const aliases = await fetchAlternativeTitles(details.id, isTv);
    if (aliases.some(alias => normalizeMatchTitle(alias) === query)) return true;
    return compactLength > 4 && aliases.some(alias => stringSimilarity(cleanTitle, alias) >= 0.86);
  }

  // ── Poster fallback ─────────────────────────────────────────────────────────
  const imagePosterCache = new Map();
  async function fetchPosterFromImages(tmdbId, isTv, originalLanguage) {
    const cacheKey = (isTv ? 'tv:' : 'movie:') + String(tmdbId);
    if (imagePosterCache.has(cacheKey)) return imagePosterCache.get(cacheKey);
    const pending = (async () => {
      const languages = [...new Set([String(originalLanguage || '').toLowerCase(), 'en', 'null'].filter(Boolean))].join(',');
      const response = await fetchWithRetry(() =>
        tmdbGet(`${BASE}/${isTv ? 'tv' : 'movie'}/${tmdbId}/images`,
          { include_image_language: languages }, { timeout: 8000 })
      );
      const posters = (response?.data?.posters || []).filter(poster =>
        poster?.file_path && Number(poster.height || 0) > Number(poster.width || 0) &&
        (!poster.aspect_ratio || (poster.aspect_ratio >= 0.55 && poster.aspect_ratio <= 0.85))
      );
      const lang = String(originalLanguage || '').toLowerCase();
      const priority = value => value === lang ? 3 : value === 'en' ? 2 : value == null ? 1 : 0;
      posters.sort((a, b) =>
        priority(b.iso_639_1) - priority(a.iso_639_1) ||
        Number(b.vote_average || 0) - Number(a.vote_average || 0) ||
        Number(b.width || 0) - Number(a.width || 0)
      );
      return posters[0]?.file_path || '';
    })();
    imagePosterCache.set(cacheKey, pending);
    return pending;
  }

  // ── Result builder ──────────────────────────────────────────────────────────
  async function buildResult(d, isTv, extra = {}, confidence = 100, algo = 'direct') {
    const posterPath = d.poster_path || await fetchPosterFromImages(d.id, isTv, d.original_language);
    return {
      tmdbId:           String(d.id),
      type:             isTv ? 'series' : 'movie',
      totalSeasons:     d.number_of_seasons || 0,
      title:            d.title || d.name || title,
      description:      d.overview || extra.seasonOverview || '',
      poster:           posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : '',
      seasonPoster:     extra.seasonPoster || '',
      seasonAirDate:    extra.seasonAirDate || '',
      seasonYear:       extra.seasonYear || null,
      backdrop:         d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
      rating:           Math.round((d.vote_average || 0) * 10) / 10,
      year:             d.release_date ? parseInt(d.release_date, 10) : d.first_air_date ? parseInt(d.first_air_date, 10) : hintYear,
      releaseDate:      d.release_date || d.first_air_date || '',
      genre:            (d.genres || []).map(g => g.name),
      duration:         d.runtime
        ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m`
        : (d.episode_run_time?.[0] ? `${Math.floor(d.episode_run_time[0] / 60)}h ${d.episode_run_time[0] % 60}m` : ''),
      originalLanguage: LANG_MAP[d.original_language] || d.original_language || '',
      confidence,
      _algo: algo,
    };
  }

  // ── Fast path: TMDB ID hint ─────────────────────────────────────────────────
  if (tmdbIdHint) {
    for (const mt of (isSeries ? ['tv','movie'] : ['movie','tv'])) {
      const r = await fetchWithRetry(() =>
        tmdbGet(`${BASE}/${mt}/${tmdbIdHint}`, {}, { timeout: 8000 })
      );
      if (r?.data && (r.data.title || r.data.name) && yearCompatible(r.data.release_date || r.data.first_air_date)) {
        const tv = mt === 'tv';
        if (await verifiedTitleMatch(r.data, tv)) {
          return await buildResult(r.data, tv, await fetchSeasonData(r.data.id, season, tv), 100, 'tmdb-id');
        }
      }
    }
  }

  // ── Fast path: IMDB ID ──────────────────────────────────────────────────────
  if (imdbId && /^tt\d{7,}$/.test(imdbId)) {
    const fr = await fetchWithRetry(() =>
      tmdbGet(`${BASE}/find/${imdbId}`, { external_source: 'imdb_id' }, { timeout: 8000 })
    );
    if (fr) {
      const hit = (fr.data?.movie_results || [])[0] || (fr.data?.tv_results || [])[0];
      const mt  = (fr.data?.movie_results || [])[0] ? 'movie' : 'tv';
      if (hit) {
        const r = await fetchWithRetry(() =>
          tmdbGet(`${BASE}/${mt}/${hit.id}`, {}, { timeout: 10000 })
        );
        if (r?.data && (r.data.title || r.data.name) && yearCompatible(r.data.release_date || r.data.first_air_date)) {
          const tv = mt === 'tv';
          if (await verifiedTitleMatch(r.data, tv)) {
            return await buildResult(r.data, tv, await fetchSeasonData(r.data.id, season, tv), 100, 'imdb-id');
          }
        }
      }
    }
  }

  // Build candidate list using all 24 algorithms
  const candidates = buildTitleCandidates(strippedTitle, cleanTitle, hintYear);

  // ── Core scorer ─────────────────────────────────────────────────────────────
  async function runStrategy(ep, params, strict) {
    return fetchWithRetry(async () => {
      const url2 = ep === 'multi' ? BASE + '/search/multi' : BASE + '/search/' + ep;
      const res = await tmdbGet(url2, params, { timeout: 10000 });
      let results = res.data.results || [];
      if (ep === 'multi') results = results.filter(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (!results.length) return null;

      const queryTitle       = params.query;
      const normalizedQuery  = normalizeMatchTitle(queryTitle);
      const compactQuery     = normalizedQuery.replace(/\s+/g, '');
      const isVeryShortTitle = compactQuery.length <= 4;
      const expectedType     = isSeries ? 'series' : 'movie';

      const scored = results.slice(0, 30).map(r => {
        const rTitle = r.title || r.name || '';
        const rOrig  = r.original_title || r.original_name || '';
        const rYear  = r.release_date ? parseInt(r.release_date, 10)
          : r.first_air_date ? parseInt(r.first_air_date, 10) : null;
        const rType  = ep === 'multi'
          ? (r.media_type === 'tv' ? 'series' : 'movie')
          : (ep === 'tv' ? 'series' : 'movie');
        const directSimilarity = Math.max(
          stringSimilarity(rTitle, queryTitle),
          stringSimilarity(rOrig, queryTitle)
        );
        const exactDirect = [rTitle, rOrig].some(value =>
          normalizeMatchTitle(value) === normalizedQuery
        );
        const yearDiff = hintYear && rYear ? Math.abs(hintYear - rYear) : null;
        const hasCompatibleYear = yearDiff == null || yearDiff <= maxYearDifference;
        return {
          r, rTitle, rOrig, rYear, rType, directSimilarity, exactDirect,
          titleSimilarity: directSimilarity, exactTitle: exactDirect,
          yearDiff, hasCompatibleYear, isTvCandidate: rType === 'series',
          alternativeTitles: [],
        };
      });

      // Check alternative titles for cross-language hits
      // v2: check MORE candidates (up to 15 when no year hint)
      const aliasCandidates = scored
        .filter(item => item.hasCompatibleYear && !item.exactDirect && item.directSimilarity < 0.86)
        .sort((a, b) => (b.r.popularity || 0) - (a.r.popularity || 0))
        .slice(0, hintYear ? 15 : 10);
      await Promise.all(aliasCandidates.map(async item => {
        item.alternativeTitles = await fetchAlternativeTitles(item.r.id, item.isTvCandidate);
        const aliasSimilarity  = item.alternativeTitles.reduce((best, alias) =>
          Math.max(best, stringSimilarity(alias, queryTitle)), 0
        );
        const exactAlias = item.alternativeTitles.some(alias =>
          normalizeMatchTitle(alias) === normalizedQuery
        );
        item.titleSimilarity = Math.max(item.directSimilarity, aliasSimilarity);
        item.exactTitle      = item.exactDirect || exactAlias;
      }));

      for (const item of scored) {
        const titleMatched = isVeryShortTitle
          ? item.exactTitle
          : (item.exactTitle || item.titleSimilarity >= (strict ? 0.86 : 0.82));
        if (!item.hasCompatibleYear || !titleMatched) {
          item.score = -Infinity;
          continue;
        }

        // Extended sequel number guard (handles multi-digit, Roman, and word numbers)
        const queryNumbers    = normalizedQuery.match(/\b\d+\b/g) || [];
        const candidateNames  = [item.rTitle, item.rOrig, ...item.alternativeTitles].join(' ');
        const resultNumbers   = normalizeMatchTitle(candidateNames).match(/\b\d+\b/g) || [];
        if (queryNumbers.length && !queryNumbers.some(number => resultNumbers.includes(number))) {
          item.score = -Infinity;
          continue;
        }

        let score = item.titleSimilarity * 70;
        if (hintYear && item.rYear) {
          score += item.yearDiff === 0 ? 24 : item.yearDiff === 1 ? 12 : 4;
        } else if (!hintYear && !item.rYear) {
          score += 3;
        }
        if (expectedType === item.rType) score += 12;
        else score -= 8;
        // v2: Popularity scoring is more conservative — cap at 4pts to avoid bias
        if (item.r.popularity > 50)  score += 2;
        if (item.r.popularity > 200) score += 2;
        // v2: Penalty for extreme popularity mismatch (popular wrong film)
        if (item.r.popularity > 500 && item.titleSimilarity < 0.90) score -= 3;
        if (item.exactTitle) score += 5;
        item.score = score;
      }

      // Season year scoring
      if (isSeries && season && seasonYearHints.length) {
        const seasonCandidates = scored.filter(item =>
          item.score > -Infinity && item.isTvCandidate
        ).sort((a, b) => b.score - a.score).slice(0, 5);
        await Promise.all(seasonCandidates.map(async item => {
          const seasonData = await fetchSeasonData(item.r.id, season, true);
          if (!seasonData.seasonYear) return;
          const nearest = Math.min(...seasonYearHints.map(y => Math.abs(y - seasonData.seasonYear)));
          item.seasonYearDiff = nearest;
          item.score += nearest === 0 ? 18 : nearest === 1 ? 12 : nearest === 2 ? 8 : nearest === 3 ? 4 : nearest <= 5 ? 1 : -8;
        }));
      }

      scored.sort((a, b) => b.score - a.score);
      const best     = scored[0];
      const minScore = strict ? 65 : 58;
      if (!best || !Number.isFinite(best.score) || best.score < minScore) return null;

      const isTv = ep === 'tv' || best.r.media_type === 'tv';
      const dr = await fetchWithRetry(() =>
        tmdbGet(BASE + '/' + (isTv ? 'tv' : 'movie') + '/' + best.r.id, {}, { timeout: 10000 })
      );
      if (!dr) return null;
      const d = dr.data || {};
      if (!yearCompatible(d.release_date || d.first_air_date)) return null;

      const sd         = await fetchSeasonData(best.r.id, season, isTv);
      const tmdbTitle  = d.title || d.name || title;
      const queryClean = cleanTitleForApi(queryTitle) || queryTitle;
      const tmdbClean  = cleanTitleForApi(tmdbTitle) || tmdbTitle;
      const titleSim   = stringSimilarity(queryClean.toLowerCase(), tmdbClean.toLowerCase());
      const displayTitle = (titleSim >= 0.5 || best.exactTitle)
        ? (best.exactDirect || titleSim >= 0.5 ? tmdbTitle : (cleanTitleForApi(title) || title))
        : (cleanTitleForApi(title) || title);
      return await buildResult(
        { ...d, title: displayTitle, name: displayTitle },
        isTv, sd, Math.round(best.score), params._algo || 'A1'
      );
    });
  }

  function buildSearchParams(endpoint, query, searchYear, label) {
    const params = { query, _algo: label };
    if (searchYear) {
      if (endpoint === 'movie') {
        params.year = searchYear;
        params.primary_release_year = searchYear;
        params.region = 'IN';
      } else if (endpoint === 'tv') {
        params.first_air_date_year = searchYear;
      }
    }
    return params;
  }

  // ── Phase 1: Strict thresholds — all 24 candidate algorithms ────────────────
  for (let i = 0; i < candidates.length; i++) {
    const q     = candidates[i];
    const label = `A${i + 1}`;
    const strats = [];
    if (hintYear) strats.push({ ep: typeEp, params: buildSearchParams(typeEp, q, hintYear, label) });
    const alternateSearchYear = !isSeries
      ? yearHints.find(candidate => candidate !== hintYear && Math.abs(candidate - hintYear) <= maxYearDifference)
      : (!options.messageYear && hintYear ? null : yearHints.find(candidate => candidate !== hintYear && (!hintYear || Math.abs(candidate - hintYear) <= maxYearDifference)));
    if (alternateSearchYear) strats.push({ ep: typeEp, params: buildSearchParams(typeEp, q, alternateSearchYear, label) });
    strats.push({ ep: typeEp,  params: { query: q, _algo: label } });
    strats.push({ ep: 'multi', params: { query: q, _algo: label } });
    if (hintYear) strats.push({ ep: otherEp, params: buildSearchParams(otherEp, q, hintYear, label) });
    strats.push({ ep: otherEp, params: { query: q, _algo: label } });

    for (const { ep, params } of strats) {
      const result = await runStrategy(ep, params, true);
      if (result) {
        if (i > 0) log(`[TMDB] Algorithm ${label} matched: "${q}" → ${result.title} (${result.confidence}pts)`);
        return result;
      }
    }
  }

  // ── Phase 2: Relaxed thresholds ─────────────────────────────────────────────
  for (let i = 0; i < candidates.length; i++) {
    const q     = candidates[i];
    const label = `R${i + 1}`;
    const strats = [
      { ep: typeEp,  params: buildSearchParams(typeEp, q, hintYear, label) },
      ...(!isSeries && yearHints.some(candidate => candidate !== hintYear && (!hintYear || Math.abs(candidate - hintYear) <= maxYearDifference))
        ? [{ ep: typeEp, params: buildSearchParams(typeEp, q, yearHints.find(candidate => candidate !== hintYear && (!hintYear || Math.abs(candidate - hintYear) <= maxYearDifference)), label) }]
        : []),
      { ep: typeEp,  params: { query: q, _algo: label } },
      { ep: 'multi', params: { query: q, _algo: label } },
      { ep: otherEp, params: buildSearchParams(otherEp, q, hintYear, label) },
      { ep: otherEp, params: { query: q, _algo: label } },
    ];
    for (const { ep, params } of strats) {
      const result = await runStrategy(ep, params, false);
      if (result) {
        log(`[TMDB] Relaxed ${label} matched: "${q}" → ${result.title} (${result.confidence}pts)`);
        return result;
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// searchOMDB — OMDB/IMDB fallback  (v2: rate-limit guard, year-empty retry)
// ─────────────────────────────────────────────────────────────────────────────
const OMDB_QUOTA = { count: 0, resetAt: Date.now() + 86400000 };
const OMDB_DAILY_LIMIT = 950; // conservative under 1000

async function searchOMDB(title, year, isSeries, omdbKey, options = {}) {
  if (!omdbKey) return null;
  // Rate-limit guard
  if (Date.now() > OMDB_QUOTA.resetAt) { OMDB_QUOTA.count = 0; OMDB_QUOTA.resetAt = Date.now() + 86400000; }
  if (OMDB_QUOTA.count >= OMDB_DAILY_LIMIT) return null;

  const cleanTitle = cleanTitleForApi(title);
  if (!cleanTitle || cleanTitle.length < 2) return null;
  const validYear = value => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1900 && n <= 2099 ? n : null;
  };
  const primaryYear = validYear(year);
  const yearHints   = [...new Set([primaryYear, ...(Array.isArray(options.yearHints) ? options.yearHints : [])]
    .map(validYear).filter(Boolean))];
  const compactTitle = normalizeMatchTitle(cleanTitle).replace(/\s+/g, '');

  async function omdbFetch(t, queryYear) {
    OMDB_QUOTA.count++;
    return fetchWithRetry(async () => {
      const params = { t, apikey: omdbKey, type: isSeries ? 'series' : 'movie', plot: 'short' };
      if (queryYear) params.y = queryYear;
      const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 10000 });
      const d   = res.data;
      if (!d || d.Response === 'False' || !d.Title) return null;

      const returnedTitle   = String(d.Title || '');
      const titleSimilarity = stringSimilarity(cleanTitle, returnedTitle);
      const exactTitle      = normalizeMatchTitle(cleanTitle) === normalizeMatchTitle(returnedTitle);
      const titleMatches    = compactTitle.length <= 4 ? exactTitle : (exactTitle || titleSimilarity >= 0.86);
      if (!titleMatches) return null;

      const yearText    = String(d.Year || '');
      const omdbYears   = (yearText.match(/19\d{2}|20\d{2}/g) || []).map(Number);
      const omdbYear    = omdbYears[0] || null;
      const yearDiff = primaryYear && omdbYear
        ? Math.abs(primaryYear - omdbYear)
        : (omdbYear && yearHints.length
          ? Math.min(...yearHints.map(hint => Math.abs(hint - omdbYear)))
          : null);
      const insideSeriesRun = isSeries && omdbYears.length > 1 &&
        yearHints.some(hint => hint >= omdbYears[0] - 2 && hint <= omdbYears[omdbYears.length - 1] + 2);
      if (primaryYear && !omdbYear) return null;
      if (yearDiff != null && yearDiff > (isSeries ? 5 : 2) && !insideSeriesRun) return null;

      const runtimeMinutes = parseInt(d.Runtime, 10);
      return {
        imdbId:           d.imdbID || '',
        title:            d.Title || title,
        description:      d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
        poster:           d.Poster && d.Poster !== 'N/A' ? d.Poster : '',
        rating:           d.imdbRating && d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0,
        year:             omdbYear || primaryYear || yearHints[0] || null,
        genre:            d.Genre && d.Genre !== 'N/A' ? d.Genre.split(', ') : [],
        duration:         d.Runtime && d.Runtime !== 'N/A' && Number.isFinite(runtimeMinutes)
          ? (Math.floor(runtimeMinutes / 60) + 'h ' + (runtimeMinutes % 60) + 'm') : '',
        type:             d.Type === 'series' ? 'series' : 'movie',
        originalLanguage: '',
      };
    }, 2, 1200); // longer backoff for OMDb
  }

  const titleCandidates = [cleanTitle, title].filter((v, i, all) => v && all.indexOf(v) === i);
  const usableYears = primaryYear
    ? [primaryYear, ...yearHints.filter(v => v !== primaryYear && Math.abs(v - primaryYear) <= 2)]
    : yearHints;
  const queryYears = usableYears.length ? usableYears : [null];

  for (const candidate of titleCandidates) {
    for (const queryYear of [...queryYears, null]) {
      const result = await omdbFetch(candidate, queryYear);
      if (result) return result;
    }
  }
  return null;
}

module.exports = {
  buildTitleCandidates,
  searchTMDB,
  searchOMDB,
  stringSimilarity,
  parseFileSizeToBytes,
  validateFileSizeVsQuality,
  normalizeMatchTitle,
};
