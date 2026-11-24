/**
 * utils/tmdbSearch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared TMDB search engine used by BOTH:
 *   • pipeline_full.js  — Telegram auto-import pipeline
 *   • routes/import.js  — Manual paste / bulk import
 *
 * Exports:
 *   buildTitleCandidates(rawTitle, cleanedTitle, year) → string[]
 *   searchTMDB(title, year, isSeries, season, msgDate, imdbId, tmdbIdHint, options) → meta | null
 *   searchOMDB(title, year, isSeries, omdbKey) → meta | null
 *
 * options for searchTMDB:
 *   { tmdbKey, omdbKey, emitter }
 *   emitter: optional function(msg) for live-log output
 */

'use strict';
const axios = require('axios');
const { cleanTitleForApi } = require('./parser');

// ─── Levenshtein string similarity (0–1) ─────────────────────────────────────
function normalizeMatchTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
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

// Similarity also tolerates punctuation/spacing variations ("Hanu-Man" vs
// "Hanu Man"), compact title spellings ("DJTillu" vs "DJ Tillu"), and a
// single misspelled word without throwing away sequel numbers.
function stringSimilarity(a, b) {
  const left = normalizeMatchTitle(a);
  const right = normalizeMatchTitle(b);
  if (left === right) return 1;
  if (!left || !right) return 0;

  const edit = editSimilarity(left, right);
  const compactLeft = left.replace(/\s+/g, '');
  const compactRight = right.replace(/\s+/g, '');
  const compact = editSimilarity(compactLeft, compactRight) * 0.97;

  const leftTokens = left.split(' ').filter(Boolean);
  const rightTokens = right.split(' ').filter(Boolean);
  const available = new Set(rightTokens.map((token, index) => index));
  let matched = 0;
  for (const token of leftTokens) {
    let bestIndex = -1;
    let bestScore = 0;
    for (const index of available) {
      const candidate = rightTokens[index];
      const score = editSimilarity(token, candidate);
      const minimum = Math.min(token.length, candidate.length);
      const threshold = minimum <= 3 ? 1 : (minimum <= 5 ? 0.8 : 0.72);
      if (score >= threshold && score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      matched++;
      available.delete(bestIndex);
    }
  }
  const tokenScore = (2 * matched) / (leftTokens.length + rightTokens.length);
  return Math.max(edit, compact, tokenScore * 0.92);
}

// ─── fetchWithRetry ───────────────────────────────────────────────────────────
async function fetchWithRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i < retries) await new Promise(r => setTimeout(r, 800 * (i + 1)));
      else return null;
    }
  }
}

// ─── Number-word conversion maps ─────────────────────────────────────────────
const NUM_WORDS_MAP = { one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9', ten:'10' };
const ROMAN_TO_NUM  = { 'I':'1','II':'2','III':'3','IV':'4','V':'5','VI':'6','VII':'7','VIII':'8','IX':'9','X':'10' };
const NUM_TO_ROMAN  = { '1':'I','2':'II','3':'III','4':'IV','5':'V','6':'VI','7':'VII','8':'VIII','9':'IX','10':'X' };

// ─────────────────────────────────────────────────────────────────────────────
// buildTitleCandidates — 14-algorithm title variant generator
//
// Each algorithm produces a different string form of the title.
// searchTMDB tries them in order stopping at first confident match.
//
// KEY BEHAVIORS:
//  • "Dune: Part Two"     → [Dune: Part Two, Dune: Part 2, Dune 2, Dune, …]
//  • "Pushpa 2 The Rule"  → [Pushpa 2 The Rule, …, Pushpa 2, Pushpa The Rule]
//  • "Pushpa 2"           → [Pushpa 2, Pushpa, Pushpa II, …]
//  • "Movie 1080p"        → cleanTitleForApi gives "Movie" → blocked by JUNK guard in searchTMDB
//  • "Hanu-Man"           → [Hanu-Man, Hanu Man, …]
//  • "RRR"                → [RRR]  (too short for "The" toggle)
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
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, m => NUM_WORDS_MAP[m.toLowerCase()] || m)
    .replace(/\b(IX|IV|VIII|VII|VI|V|III|II|X{1,3}I{0,3}|I{1,3})\b/g, m => ROMAN_TO_NUM[m.toUpperCase()] || m);

  // Helper: normalize "Part N/word/Roman" → "Part <digit>"
  const normalizePart = (s) => s
    .replace(/\bPart\s+0*(\d+)\b/gi, (_, n) => 'Part ' + parseInt(n, 10))
    .replace(/\bPart\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (_, w) => 'Part ' + (NUM_WORDS_MAP[w.toLowerCase()] || w))
    .replace(/\bPart\s+(IX|IV|VIII|VII|VI|V|III|II|X{1,3}I{0,3}|I{1,3})\b/gi, (_, r) => 'Part ' + (ROMAN_TO_NUM[r.toUpperCase()] || r));

  // Algorithm 1: Direct clean title
  add(cleanedTitle);

  // Algorithm 2: Strip residual language/quality suffixes
  // Guard: only add when ≥ 2 words remain (avoids "Movie" from "Movie 1080p")
  const suf2 = cleanedTitle
    .replace(/\s+(telugu|tamil|hindi|malayalam|kannada|bengali|english|korean|japanese|dubbed|dub|dual|multi|4k|uhd|hdr|1080p|720p|480p|360p|web[-\s]?dl|webrip|bluray|hevc|x265|x264|avc|av1|remux|hdcam|cam|proper|repack)\s*$/gi, '')
    .trim();
  const suf2Words = suf2.split(/\s+/).filter(Boolean).length;
  const origWords = cleanedTitle.split(/\s+/).filter(Boolean).length;
  if (suf2 !== cleanedTitle && suf2Words >= Math.min(2, origWords)) add(suf2);

  // Algorithm 3: Hyphen/dash → space  ("Hanu-Man" → "Hanu Man")
  add(cleanedTitle.replace(/[-\u2013\u2014]/g, ' ').replace(/\s+/g, ' ').trim());

  // Algorithm 4: Colon-subtitle handling
  // "Dune: Part Two" → "Dune: Part 2" + "Dune 2" + "Dune"
  const colonMatch = cleanedTitle.match(/^(.+?)\s*[:\u2013\u2014]\s*(.+)$/);
  if (colonMatch) {
    const base     = colonMatch[1].trim();
    const subtitle = colonMatch[2].trim();
    const normFull = base + ': ' + normalizePart(subtitle);
    add(normFull);
    // Extract part number → "Base N" format TMDB sometimes uses
    const partNum = subtitle.match(/\bPart\s*(\d+)/i)?.[1]
      || subtitle.match(/\b(\d+)\s*$/)?.[1];
    if (partNum && parseInt(partNum) > 1) add(base + ' ' + parseInt(partNum));
    if (base.length >= 2) add(base);
  }

  // Algorithm 5: Remove trailing sequel number  ("Pushpa 2" → "Pushpa")
  const noTrailNum = cleanedTitle.replace(/\s+\d+\s*$/, '').trim();
  if (noTrailNum !== cleanedTitle && noTrailNum.length >= 2) add(noTrailNum);

  // Algorithm 6: Arabic → Roman at end  ("Baahubali 2" → "Baahubali II")
  const romanized = cleanedTitle.replace(/\s+(\d{1,2})\s*$/, (_, n) => NUM_TO_ROMAN[n] ? ' ' + NUM_TO_ROMAN[n] : ' ' + n);
  if (romanized !== cleanedTitle) add(romanized);

  // Algorithm 7: Roman → Arabic at end  ("Baahubali II" → "Baahubali 2")
  const arabicized = cleanedTitle.replace(/\s+(IX|IV|VIII|VII|VI|V|III|II|I{1,3}|X)\s*$/i, (_, r) => {
    const a = ROMAN_TO_NUM[r.toUpperCase()]; return a ? ' ' + a : ' ' + r;
  });
  if (arabicized !== cleanedTitle) add(arabicized);

  // Algorithm 8: "The" prefix toggle (only for titles ≥ 4 chars — avoids "The RRR")
  if (/^The\s+/i.test(cleanedTitle)) {
    add(cleanedTitle.replace(/^The\s+/i, '').trim());
  } else if (cleanedTitle.replace(/\s+/g, '').length >= 4) {
    add('The ' + cleanedTitle);
  }

  // Algorithm 9: Number-words → digits  ("Dune Part Two" → "Dune Part 2")
  const numWrds = toArabic(cleanedTitle);
  if (numWrds.toLowerCase() !== cleanedTitle.toLowerCase()) add(numWrds);

  // Algorithm 10: First 3 / first 2 words (long title prefix reduction)
  const words = cleanedTitle.split(/\s+/).filter(Boolean);
  if (words.length > 4) { add(words.slice(0, 3).join(' ')); add(words.slice(0, 2).join(' ')); }
  else if (words.length > 3) { add(words.slice(0, 2).join(' ')); }

  // Algorithm 11: Ampersand / "and" toggle
  if (/&/.test(cleanedTitle))       add(cleanedTitle.replace(/\s*&\s*/g, ' and '));
  if (/ and /i.test(cleanedTitle))  add(cleanedTitle.replace(/\s+and\s+/gi, ' & '));

  // Algorithm 11b: Roman numeral in MIDDLE → Arabic
  // "Baahubali II The Conclusion" → "Baahubali 2 The Conclusion"
  const midArabic = cleanedTitle.replace(/\b(IX|IV|VIII|VII|VI|V|III|II|I{1,3}|X{1,3})\b/g, r => ROMAN_TO_NUM[r.toUpperCase()] || r);
  if (midArabic.toLowerCase() !== cleanedTitle.toLowerCase()) add(midArabic);

  // Algorithm 11c: Remove mid-title sequel number
  // "Pushpa 2 The Rule" → "Pushpa The Rule"
  const midNumRemoved = cleanedTitle.replace(/\s+\d+(?=\s+[A-Z])/g, '').trim();
  if (midNumRemoved.toLowerCase() !== cleanedTitle.toLowerCase()) add(midNumRemoved);

  // Algorithm 12: "Part N" / "Chapter N" → bare digit
  // "Baahubali Part 2" → "Baahubali 2"
  const partToNum = cleanedTitle
    .replace(/\bPart\s+(\d+)\b/gi, (_, n) => n)
    .replace(/\bChapter\s+(\d+)\b/gi, (_, n) => n)
    .trim();
  if (partToNum !== cleanedTitle) add(partToNum);

  // Algorithm 12b: punctuation/spacing-normalized title.
  const spacedTitle = cleanedTitle
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (spacedTitle.toLowerCase() !== cleanedTitle.toLowerCase()) add(spacedTitle);

  // Algorithm 12c: compact spelling variant (e.g. "DJ Tillu" → "DJTillu").
  const compactTitle = cleanedTitle.replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  if (compactTitle.length >= 5 && compactTitle.toLowerCase() !== cleanedTitle.toLowerCase()) add(compactTitle);

  // Algorithm 12d: raw unclean title (when cleanTitleForApi over-strips).
  const rawC = (rawTitle || '').replace(/\s+/g, ' ').trim();
  if (rawC && rawC.toLowerCase() !== cleanedTitle.toLowerCase()) add(rawC);

  return result;
}

// ─── Junk single-word guard ───────────────────────────────────────────────────
const JUNK_SINGLES_RE = /^(movie|film|video|clip|show|series|episode|part|chapter|season|trailer|teaser|sample|test|unknown|untitled|hd|fhd|uhd|4k|1080p|720p|480p)$/i;

// ─── Language code → display name ────────────────────────────────────────────
const LANG_MAP = { en:'English',te:'Telugu',ta:'Tamil',hi:'Hindi',ml:'Malayalam',kn:'Kannada',ja:'Japanese',ko:'Korean',fr:'French',es:'Spanish',de:'German',it:'Italian',zh:'Chinese',ru:'Russian',pt:'Portuguese',ar:'Arabic',tr:'Turkish',id:'Indonesian',th:'Thai',bn:'Bengali' };

// ─────────────────────────────────────────────────────────────────────────────
// searchTMDB — main entry point
//
// @param title     string   — raw title from parser
// @param year      number   — release year hint (may be null)
// @param isSeries  boolean
// @param season    number   — season number for TV (for season poster)
// @param msgDate   string   — ISO date of Telegram message
// @param imdbId    string   — tt-format IMDB ID if found in message
// @param tmdbIdHint string  — TMDB numeric ID if found in message
// @param options   { tmdbKey, emitter }
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
  // For TV, the message/title year describes the show's first air date.
  // A filename year usually describes a later season and must not be scored
  // against the show's first_air_date.
  const titleYear = Object.prototype.hasOwnProperty.call(options, 'messageYear')
    ? validYear(options.messageYear)
    : (validYear(year) || null);
  const hintYear = isSeries ? titleYear : (titleYear || yearHints[0] || null);
  // Filename years belong to individual TV seasons; compare them against
  // TMDB's season air_date, never against the show's first_air_date.
  const seasonYearHints = [...new Set(
    (Array.isArray(options.seasonYearHints) ? options.seasonYearHints : (isSeries ? yearHints.filter(y => y !== titleYear) : []))
      .map(validYear).filter(Boolean)
  )];
  const seasonDataCache = new Map();

  const log = (msg) => { if (emitter) emitter(msg); };

  // Strip language/quality suffixes
  const LANG_SUFFIX_RE = /\s+(telugu|tamil|hindi|malayalam|kannada|bengali|english|korean|japanese|chinese|arabic|turkish|spanish|french|german|dubbed|dub|dual\s*audio|multi\s*audio|4k|uhd|hdr|1080p|720p|480p|web-?dl|webrip|bluray|hevc|x265|x264|avc|av1|remux|hdcam|cam|proper|repack)\s*$/i;
  const strippedTitle = title.replace(LANG_SUFFIX_RE, '').trim() || title;
  const cleanTitle    = cleanTitleForApi(strippedTitle);

  if (!cleanTitle || cleanTitle.length < 2) return null;

  // Guard: single generic word → useless TMDB query
  if (cleanTitle.split(/\s+/).length === 1 && JUNK_SINGLES_RE.test(cleanTitle)) {
    log(`[TMDB] Skipping junk single-word title: "${cleanTitle}"`);
    return null;
  }

  const BASE     = 'https://api.themoviedb.org/3';

  // Accept both TMDB credential formats:
  // - v3 API key: api_key query parameter
  // - v4 Read Access Token (JWT): Authorization: Bearer header
  const isV4Token = String(tmdbKey).split('.').length === 3;
  async function tmdbGet(url, params = {}, config = {}) {
    const requestParams = { ...params };
    delete requestParams.api_key;
    if (!isV4Token) requestParams.api_key = tmdbKey;
    return axios.get(url, {
      ...config,
      params: requestParams,
      headers: {
        ...(config.headers || {}),
        ...(isV4Token ? { Authorization: `Bearer ${tmdbKey}` } : {}),
      },
    });
  }
  // Telegram upload date is not a release-year hint. Using it as one causes
  // false year penalties for older films posted in a newer channel message.
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

  // ── Result builder ──────────────────────────────────────────────────────────
  function buildResult(d, isTv, extra = {}, confidence = 100, algo = 'direct') {
    return {
      tmdbId:           String(d.id),
      type:             isTv ? 'series' : 'movie',
      totalSeasons:     d.number_of_seasons || 0,
      title:            d.title || d.name || title,
      description:      d.overview || extra.seasonOverview || '',
      poster:           d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : '',
      seasonPoster:     extra.seasonPoster || '',
      seasonAirDate:    extra.seasonAirDate || '',
      seasonYear:       extra.seasonYear || null,
      backdrop:         d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
      rating:           Math.round((d.vote_average || 0) * 10) / 10,
      // A series card keeps the show's first-air year; each season's own year
      // is returned separately as seasonYear instead of replacing the parent.
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
      if (r?.data && (r.data.title || r.data.name)) {
        const tv = mt === 'tv';
        return buildResult(r.data, tv, await fetchSeasonData(r.data.id, season, tv), 100, 'tmdb-id');
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
        if (r?.data && (r.data.title || r.data.name)) {
          const tv = mt === 'tv';
          return buildResult(r.data, tv, await fetchSeasonData(r.data.id, season, tv), 100, 'imdb-id');
        }
      }
    }
  }

  // Build candidate list using all 14 algorithms
  const candidates = buildTitleCandidates(strippedTitle, cleanTitle, hintYear);

  // ── Core scorer ─────────────────────────────────────────────────────────────
  async function runStrategy(ep, params, strict) {
    return fetchWithRetry(async () => {
      const url2  = ep === 'multi' ? `${BASE}/search/multi` : `${BASE}/search/${ep}`;
      const res   = await tmdbGet(url2, params, { timeout: 10000 });
      let results = res.data.results || [];
      if (ep === 'multi') results = results.filter(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (!results.length) return null;

      const queryTitle = params.query;
      const scored = results.slice(0, 30).map(r => {
        const rTitle   = r.title || r.name || '';
        const rOrig    = r.original_title || r.original_name || '';
        const rYear    = r.release_date ? parseInt(r.release_date, 10) : r.first_air_date ? parseInt(r.first_air_date, 10) : null;
        const rType    = ep === 'multi' ? (r.media_type === 'tv' ? 'series' : 'movie') : (ep === 'tv' ? 'series' : 'movie');
        let simMain = Math.max(
          stringSimilarity(rTitle, queryTitle),
          stringSimilarity(rOrig, queryTitle)
        );
        const queryNumbers = normalizeMatchTitle(queryTitle).match(/\b\d+\b/g) || [];
        const resultNumbers = normalizeMatchTitle(rTitle + ' ' + rOrig).match(/\b\d+\b/g) || [];
        // Keep sequels distinct: a candidate containing a sequel number should
        // not confidently resolve to the original title with that number absent.
        if (queryNumbers.length && !queryNumbers.some(number => resultNumbers.includes(number))) {
          simMain *= 0.72;
        }

        let score = simMain * 70;
        if (hintYear && rYear) {
          const d = Math.abs(hintYear - rYear);
          score += d === 0 ? 20 : d === 1 ? 10 : d <= 2 ? 4 : -8;
        } else if (!hintYear && !rYear) score += 3;
        if ((isSeries ? 'series' : 'movie') === rType) score += 12; else score -= 8;
        if (r.popularity > 50) score += 3;
        if (r.popularity > 200) score += 2;
        return { r, score, simMain, isTvCandidate: rType === 'series' };
      });

      // Where a TV search is ambiguous, compare the filename's year with the
      // selected season's actual TMDB air date. This distinguishes same-title
      // remakes and avoids penalizing later seasons against the series premiere.
      if (isSeries && season && seasonYearHints.length) {
        const seasonCandidates = scored.filter(item => item.isTvCandidate).slice(0, 8);
        await Promise.all(seasonCandidates.map(async item => {
          const seasonData = await fetchSeasonData(item.r.id, season, true);
          if (!seasonData.seasonYear) return;
          const nearest = Math.min(...seasonYearHints.map(y => Math.abs(y - seasonData.seasonYear)));
          item.seasonYearDiff = nearest;
          item.score += nearest === 0 ? 18 : nearest === 1 ? 12 : nearest === 2 ? 8 : nearest === 3 ? 4 : nearest <= 5 ? 1 : -8;
        }));
      }
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      const simThresh   = strict ? (isShort ? 0.70 : 0.55) : (isShort ? 0.45 : 0.30);
      const scoreThresh = strict ? (isShort ? 65  : 55)    : (isShort ? 47   : 37);
      if (best.score < scoreThresh || best.simMain < simThresh) return null;

      const isTv = ep === 'tv' || best.r.media_type === 'tv';
      const dr = await fetchWithRetry(() =>
        tmdbGet(`${BASE}/${isTv ? 'tv' : 'movie'}/${best.r.id}`, {}, { timeout: 10000 })
      );
      if (!dr) return null;
      const sd = await fetchSeasonData(best.r.id, season, isTv);
      const d  = dr.data;

      // Prefer TMDB title when similar; keep query title for dubbed names
      const tmdbTitle    = d.title || d.name || title;
      const queryClean   = cleanTitleForApi(queryTitle) || queryTitle;
      const tmdbClean    = cleanTitleForApi(tmdbTitle)  || tmdbTitle;
      const titleSim     = stringSimilarity(queryClean.toLowerCase(), tmdbClean.toLowerCase());
      const displayTitle = titleSim >= 0.5 ? tmdbTitle : (cleanTitleForApi(title) || title);
      return buildResult(
        { ...d, title: displayTitle, name: displayTitle },
        isTv, sd, Math.round(best.score), params._algo || 'A1'
      );
    });
  }

  // ── Phase 1: Strict thresholds — all 14 candidate algorithms ────────────────
  for (let i = 0; i < candidates.length; i++) {
    const q     = candidates[i];
    const label = `A${i + 1}`;
    const strats = [];
    if (hintYear) strats.push({ ep: typeEp,  params: { query: q, year: hintYear, _algo: label } });
    // A distinct filename year is a fallback search hint, but for a TV series
    // it is not treated as the show's premiere year by the scorer.
    const alternateSearchYear = !isSeries
      ? yearHints.find(candidate => candidate !== hintYear)
      : (!options.messageYear && hintYear ? null : yearHints.find(candidate => candidate !== hintYear));
    if (alternateSearchYear) strats.push({ ep: typeEp, params: { query: q, year: alternateSearchYear, _algo: label } });
    strats.push(          { ep: typeEp,  params: { query: q, _algo: label } });
    strats.push(          { ep: 'multi', params: { query: q, _algo: label } });
    if (hintYear) strats.push({ ep: otherEp, params: { query: q, year: hintYear, _algo: label } });
    strats.push(          { ep: otherEp, params: { query: q, _algo: label } });

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
      { ep: typeEp,  params: { query: q, ...(hintYear ? { year: hintYear } : {}), _algo: label } },
      ...(!isSeries && yearHints.some(candidate => candidate !== hintYear)
        ? [{ ep: typeEp, params: { query: q, year: yearHints.find(candidate => candidate !== hintYear), _algo: label } }]
        : []),
      { ep: typeEp,  params: { query: q, _algo: label } },
      { ep: 'multi', params: { query: q, _algo: label } },
      { ep: otherEp, params: { query: q, ...(hintYear ? { year: hintYear } : {}), _algo: label } },
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
// searchOMDB — OMDB/IMDB fallback
// ─────────────────────────────────────────────────────────────────────────────
async function searchOMDB(title, year, isSeries, omdbKey, options = {}) {
  if (!omdbKey) return null;
  const cleanTitle = cleanTitleForApi(title);
  if (!cleanTitle || cleanTitle.length < 2) return null;
  const validYear = value => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1900 && n <= 2099 ? n : null;
  };
  const yearHints = [...new Set([year, ...(Array.isArray(options.yearHints) ? options.yearHints : [])]
    .map(validYear).filter(Boolean))];

  async function omdbFetch(t, queryYear) {
    return fetchWithRetry(async () => {
      const params = { t, apikey: omdbKey, type: isSeries ? 'series' : 'movie', plot: 'short' };
      if (queryYear) params.y = queryYear;
      const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 10000 });
      const d = res.data;
      if (!d || d.Response === 'False') return null;
      const yearText = String(d.Year || '');
      const omdbYears = (yearText.match(/19\\d{2}|20\\d{2}/g) || []).map(Number);
      const omdbYear = omdbYears[0] || null;
      const yearDiff = omdbYear && yearHints.length
        ? Math.min(...yearHints.map(hint => Math.abs(hint - omdbYear)))
        : null;
      // IMDb often returns a series' complete run as "2018–2024".
      // A filename year inside that range is a valid season match, even though
      // the parent card must retain the first-air year.
      const insideSeriesRun = isSeries && omdbYears.length > 1 &&
        yearHints.some(hint => hint >= omdbYears[0] && hint <= omdbYears[omdbYears.length - 1]);
      if (yearDiff != null && yearDiff > (isSeries ? 5 : 3) && !insideSeriesRun) return null;
      return {
        imdbId:      d.imdbID || '',
        title:       d.Title || title,
        description: d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
        poster:      d.Poster && d.Poster !== 'N/A' ? d.Poster : '',
        rating:      d.imdbRating && d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0,
        year:        omdbYear || yearHints[0] || null,
        genre:       d.Genre && d.Genre !== 'N/A' ? d.Genre.split(', ') : [],
        duration:    d.Runtime && d.Runtime !== 'N/A'
          ? (() => { const m = parseInt(d.Runtime); return `${Math.floor(m/60)}h ${m%60}m`; })()
          : '',
        type: d.Type === 'series' ? 'series' : 'movie',
        originalLanguage: '',
      };
    });
  }

  const candidates = [cleanTitle, title].filter((value, index, all) => value && all.indexOf(value) === index);
  const queryYears = yearHints.length ? yearHints : [null];
  for (const candidate of candidates) {
    for (const queryYear of [...queryYears, null]) {
      const result = await omdbFetch(candidate, queryYear);
      if (result) return result;
    }
  }
  return null;
}

module.exports = { buildTitleCandidates, searchTMDB, searchOMDB, stringSimilarity };
