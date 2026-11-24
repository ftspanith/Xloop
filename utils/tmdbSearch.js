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
  const hintYear = year ? Number(year) : null;
  const isShort  = cleanTitle.trim().split(/\s+/).length <= 2;
  const typeEp   = isSeries ? 'tv' : 'movie';
  const otherEp  = isSeries ? 'movie' : 'tv';

  // ── Season poster helper ────────────────────────────────────────────────────
  async function fetchSeasonData(tmdbId, sn, isTv) {
    if (!isTv || !sn) return {};
    const sr = await fetchWithRetry(() =>
      tmdbGet(`${BASE}/tv/${tmdbId}/season/${sn}`, {}, { timeout: 8000 })
    );
    return {
      seasonPoster:   sr?.data?.poster_path ? `https://image.tmdb.org/t/p/w500${sr.data.poster_path}` : '',
      seasonOverview: sr?.data?.overview || '',
    };
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

  // Resolve localized/dubbed names against TMDB's alternate-title catalogue.
  // Cache by media type + ID because the search cascade can revisit the same result.
  const alternativeTitleCache = new Map();
  async function fetchAlternativeTitles(mediaType, tmdbId) {
    const key = mediaType + ':' + tmdbId;
    if (!alternativeTitleCache.has(key)) {
      alternativeTitleCache.set(key, fetchWithRetry(async () => {
        const response = await tmdbGet(
          BASE + '/' + mediaType + '/' + tmdbId + '/alternative_titles',
          {},
          { timeout: 8000 }
        );
        const data = response?.data || {};
        const entries = [
          ...(Array.isArray(data.titles) ? data.titles : []),
          ...(Array.isArray(data.results) ? data.results : []),
        ];
        return [...new Set(entries.map(entry =>
          typeof entry === 'string' ? entry : (entry?.title || entry?.name || '')
        ).map(value => String(value).trim()).filter(Boolean))];
      }));
    }
    const value = await alternativeTitleCache.get(key);
    return Array.isArray(value) ? value : [];
  }
  // ── Core scorer ─────────────────────────────────────────────────────────────
  async function runStrategy(ep, params, strict) {
    return fetchWithRetry(async () => {
      const url2 = ep === 'multi' ? BASE + '/search/multi' : BASE + '/search/' + ep;
      const res = await tmdbGet(url2, params, { timeout: 10000 });
      let results = res.data.results || [];
      if (ep === 'multi') results = results.filter(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (!results.length) return null;

      const queryTitle = params.query;
      const normalizedQuery = normalizeMatchTitle(queryTitle);
      const ultraShortTitle = normalizedQuery.split(' ').length === 1 && normalizedQuery.length <= 4;
      // A known release year is a guardrail, not a small scoring preference.
      // A title hit nine years away must never outrank the correct film.
      const yearCompatible = results.slice(0, 30).filter(r => {
        const candidateYear = r.release_date ? parseInt(r.release_date, 10)
          : r.first_air_date ? parseInt(r.first_air_date, 10) : null;
        return !(hintYear && candidateYear && Math.abs(hintYear - candidateYear) > 1);
      });
      if (!yearCompatible.length) return null;

      const scored = await Promise.all(yearCompatible.map(async r => {
        const rTitle = r.title || r.name || '';
        const rOrig = r.original_title || r.original_name || '';
        const rYear = r.release_date ? parseInt(r.release_date, 10)
          : r.first_air_date ? parseInt(r.first_air_date, 10) : null;
        const candidateMediaType = ep === 'multi' ? r.media_type : ep;
        const rType = candidateMediaType === 'tv' ? 'series' : 'movie';
        let simMain = Math.max(
          stringSimilarity(rTitle, queryTitle),
          stringSimilarity(rOrig, queryTitle)
        );
        // Very short names such as "Robo" are too collision-prone for fuzzy
        // substring-like matches (for example, "Robo" vs "Robot").
        if (ultraShortTitle) {
          simMain = [rTitle, rOrig].some(value => normalizeMatchTitle(value) === normalizedQuery) ? 1 : 0;
        }

        let aliasSim = 0;
        let aliasTitles = [];
        if (hintYear && rYear && Math.abs(hintYear - rYear) <= 1 && simMain < 0.999) {
          aliasTitles = await fetchAlternativeTitles(candidateMediaType, r.id);
          if (ultraShortTitle) {
            aliasSim = aliasTitles.some(value => normalizeMatchTitle(value) === normalizedQuery) ? 1 : 0;
          } else {
            aliasSim = aliasTitles.reduce((best, value) => Math.max(best, stringSimilarity(value, queryTitle)), 0);
            const aliasThreshold = normalizedQuery.split(' ').length === 1 ? 0.90 : 0.82;
            if (aliasSim < aliasThreshold) aliasSim = 0;
          }
        }

        const queryNumbers = normalizedQuery.match(/\b\d+\b/g) || [];
        const resultNumbers = normalizeMatchTitle([rTitle, rOrig, ...aliasTitles].join(' ')).match(/\b\d+\b/g) || [];
        // Keep sequels distinct across both canonical and localized titles.
        if (queryNumbers.length && !queryNumbers.some(number => resultNumbers.includes(number))) {
          simMain *= 0.72;
          aliasSim *= 0.72;
        }
        const effectiveSimilarity = Math.max(simMain, aliasSim);
        let score = effectiveSimilarity * 70;
        if (hintYear && rYear) {
          const yearDifference = Math.abs(hintYear - rYear);
          score += yearDifference === 0 ? 20 : 10;
        } else if (!hintYear && !rYear) score += 3;
        if ((isSeries ? 'series' : 'movie') === rType) score += 12; else score -= 8;
        if (r.popularity > 50) score += 3;
        if (r.popularity > 200) score += 2;
        return { r, score, simMain: Math.max(simMain, aliasSim) };
      }));

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (!best) return null;
      const simThresh = strict ? (isShort ? 0.70 : 0.55) : (isShort ? 0.45 : 0.30);
      const scoreThresh = strict ? (isShort ? 65 : 55) : (isShort ? 47 : 37);
      if (best.score < scoreThresh || best.simMain < simThresh) return null;

      const isTv = ep === 'tv' || best.r.media_type === 'tv';
      const dr = await fetchWithRetry(() =>
        tmdbGet(BASE + '/' + (isTv ? 'tv' : 'movie') + '/' + best.r.id, {}, { timeout: 10000 })
      );
      if (!dr) return null;
      const d = dr.data;
      const detailYear = d.release_date ? parseInt(d.release_date, 10)
        : d.first_air_date ? parseInt(d.first_air_date, 10) : null;
      if (hintYear && detailYear && Math.abs(hintYear - detailYear) > 1) {
        log('[TMDB] Rejected title match "' + (d.title || d.name || best.r.id) +
          '" — release year ' + detailYear + ' does not match ' + hintYear);
        return null;
      }
      const sd = await fetchSeasonData(best.r.id, season, isTv);

      // Prefer TMDB title when similar; keep a localized/dubbed query title otherwise.
      const tmdbTitle = d.title || d.name || title;
      const queryClean = cleanTitleForApi(queryTitle) || queryTitle;
      const tmdbClean = cleanTitleForApi(tmdbTitle) || tmdbTitle;
      const titleSim = stringSimilarity(queryClean.toLowerCase(), tmdbClean.toLowerCase());
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
async function searchOMDB(title, year, isSeries, omdbKey) {
  if (!omdbKey) return null;
  const cleanTitle = cleanTitleForApi(title);
  if (!cleanTitle || cleanTitle.length < 2) return null;

  async function omdbFetch(t, y) {
    return fetchWithRetry(async () => {
      const params = { t, apikey: omdbKey, type: isSeries ? 'series' : 'movie', plot: 'short' };
      if (y) params.y = y;
      const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 10000 });
      const d   = res.data;
      if (!d || d.Response === 'False') return null;
      const omdbYear = d.Year ? parseInt(d.Year) : year;
      if (year && omdbYear && Math.abs(year - omdbYear) > 3) return null;
      return {
        imdbId:      d.imdbID || '',
        title:       d.Title  || title,
        description: d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
        poster:      d.Poster && d.Poster !== 'N/A' ? d.Poster : '',
        rating:      d.imdbRating && d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0,
        year:        omdbYear,
        genre:       d.Genre && d.Genre !== 'N/A' ? d.Genre.split(', ') : [],
        duration:    d.Runtime && d.Runtime !== 'N/A'
          ? (() => { const m = parseInt(d.Runtime); return `${Math.floor(m/60)}h ${m%60}m`; })()
          : '',
        type: d.Type === 'series' ? 'series' : 'movie',
        originalLanguage: '',
      };
    });
  }

  return (await omdbFetch(cleanTitle, year))
    || (year ? await omdbFetch(cleanTitle, null) : null)
    || await omdbFetch(title, year);
}

module.exports = { buildTitleCandidates, searchTMDB, searchOMDB, stringSimilarity };
