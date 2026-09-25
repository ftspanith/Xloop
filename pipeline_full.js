#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// pipeline_full.js  ─  UNIFIED BYPASS + IMPORT PIPELINE
//
// This replaces the disconnected bypass → import two-step process.
// It integrates:
//   1. Reads links_for_bypasser.json + shortlinks_report.json
//   2. Shortlinks are bypassed INLINE (same bypassSofturl logic as bypass_bot)
//   3. All entries (direct + newly bypassed) imported to MongoDB with TMDB
//   4. Heal DB for any remaining gaps
//
// Usage:
//   node pipeline_full.js                  — full pipeline
//   node pipeline_full.js --no-wipe        — skip DB wipe
//   node pipeline_full.js --no-heal        — skip healer
//   node pipeline_full.js --no-bypass      — skip bypass (import direct only)
//   node pipeline_full.js --concurrency=4  — bypass concurrency (default 3)
//   node pipeline_full.js --import-source=./bypassed_links.json
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');
const axios    = require('axios');
// axios-cookiejar-support is ESM-only ("type": "module") — lazy-loaded below
// to prevent Vercel's ncc bundler from crashing on it at build time
const { CookieJar } = require('tough-cookie');
const { spawn }     = require('child_process');
const Movie         = require('./models/Movie');
const { cleanTitleForApi, detectHost } = require('./utils/parser');

// ─── CLI args (only used when run directly, not when require()'d) ─────────────
const IS_MAIN = require.main === module;
const _argv        = IS_MAIN ? process.argv.slice(2) : [];

const ROOT             = __dirname;
const IS_VERCEL        = !!process.env.VERCEL;
const TMP              = IS_VERCEL ? '/tmp' : ROOT;
const LINKS_FILE       = path.join(TMP, 'links_for_bypasser.json');
const SHORTLINKS_FILE  = path.join(TMP, 'shortlinks_report.json');
const BYPASSED_FILE    = path.join(TMP, 'bypassed_links.json');
const CHECKPOINT_FILE  = path.join(TMP, 'import_checkpoint.json');
const TMDB_KEY         = process.env.TMDB_API_KEY || '';
const OMDB_KEY         = process.env.OMDB_API_KEY  || '';

// ─── Terminal colors ──────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
// emitter: function(line:string) — injected by orchestrator route for SSE streaming
// When running as CLI, emitter simply prints to stdout
let _emitter = line => process.stdout.write(line + '\n');
const log  = msg => _emitter(`▶  ${msg}`);
const ok   = msg => _emitter(`✅ ${msg}`);
const warn = msg => _emitter(`⚠️  ${msg}`);
const fail = msg => _emitter(`❌ ${msg}`);
const sep  = ()  => _emitter('─'.repeat(64));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Only accept these as valid bypassed direct URLs
const DIRECT_HOST_RE = /gdflix|hubcloud|drive\.google|gofile|terabox|mega\.nz|1fichier|filemoon|streamtape|pixeldrain|krakenfiles/i;

// ═══════════════════════════════════════════════════════════════════════════
// BYPASS ENGINE  (ported from bypass_bot.js — bypassSofturl)
// ═══════════════════════════════════════════════════════════════════════════
async function bypassSofturl(url) {
  const jar    = new CookieJar();
  const { wrapper } = await import('axios-cookiejar-support');
  const client = wrapper(axios.create({ jar, withCredentials: true }));
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const hdrs = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };
  const post = (u, body, ref) => client.post(u, body, {
    headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': ref || u },
    timeout: 25000, maxRedirects: 3,
  });
  const get = (u, ref) => client.get(u, {
    headers: { ...hdrs, 'Referer': ref || u },
    timeout: 25000, maxRedirects: 5,
  });
  const ex = (html, re) => html.match(re)?.[1] || null;

  const r1 = await get(url);
  const go1 = ex(r1.data, /name="go"\s+value="([^"]+)"/);
  const a1  = ex(r1.data, /action="([^"]+)"/);
  if (!go1 || !a1) throw new Error('Step 1: no go/action');

  const r2  = await post(a1, `go=${encodeURIComponent(go1)}`, url);
  const wp2 = ex(r2.data, /name="newwpsafelink"\s+value="([^"]+)"/);
  const a2  = ex(r2.data, /id="landing"[^>]*action="([^"]+)"/) || a1;
  if (!wp2) throw new Error('Step 2: no newwpsafelink');

  const r3  = await post(a2, `humanverification=1&newwpsafelink=${encodeURIComponent(wp2)}`, a1);
  const wp3 = ex(r3.data, /name="newwpsafelink"\s+value="([^"]+)"/) || wp2;
  const j3  = JSON.parse(Buffer.from(wp3, 'base64').toString());
  if (!j3.linkr) throw new Error('Step 3: no linkr');

  const r4  = await get(j3.linkr, a2);
  const go4 = ex(r4.data, /name="go"\s+value="([^"]+)"/);
  const a4  = ex(r4.data, /action="([^"]+)"/);
  if (!go4 || !a4) throw new Error('Step 4: no go/action');

  const r5  = await post(a4, `go=${encodeURIComponent(go4)}`, j3.linkr);
  const wp5 = ex(r5.data, /name="newwpsafelink"\s+value="([^"]+)"/);
  const a5  = ex(r5.data, /id="landing"[^>]*action="([^"]+)"/) || a4;
  if (!wp5) throw new Error('Step 5: no newwpsafelink');

  const r6  = await post(a5, `humanverification=1&newwpsafelink=${encodeURIComponent(wp5)}`, a4);
  const wp6 = ex(r6.data, /name="newwpsafelink"\s+value="([^"]+)"/) || wp5;
  const j6  = JSON.parse(Buffer.from(wp6, 'base64').toString());
  const delay = parseInt(j6.delay || '25', 10);
  if (!j6.linkr) throw new Error('Step 6: no linkr');

  await sleep((delay + 3) * 1000);  // Server-enforced ad timer

  const r7 = await get(j6.linkr, a5);
  let ad, csrf, tf, ga, refForFinal;
  ad   = ex(r7.data, /name="ad_form_data"\s+value="([^"]+)"/);
  csrf = ex(r7.data, /name="_csrfToken"[^>]+value="([^"]+)"/);
  tf   = ex(r7.data, /name="_Token\[fields\]"[^>]*value="([^"]+)"/);
  ga   = ex(r7.data, /id="go-link"[^>]*action="([^"]+)"/) || '/links/go';
  refForFinal = j6.linkr;

  if (!ad) {
    const go7 = ex(r7.data, /name="go"\s+value="([^"]+)"/);
    const a7  = ex(r7.data, /action="([^"]+)"/);
    if (!go7 || !a7) throw new Error('Step 7: no go/action and no ad_form_data');
    const r8 = await post(a7, `go=${encodeURIComponent(go7)}`, j6.linkr);
    ad   = ex(r8.data, /name="ad_form_data"\s+value="([^"]+)"/);
    csrf = ex(r8.data, /name="_csrfToken"[^>]+value="([^"]+)"/);
    tf   = ex(r8.data, /name="_Token\[fields\]"[^>]*value="([^"]+)"/);
    ga   = ex(r8.data, /id="go-link"[^>]*action="([^"]+)"/) || '/links/go';
    refForFinal = a7;
    if (!ad) throw new Error('Step 8: no ad_form_data');
  }

  const base        = new URL(url).origin;
  const finalAction = ga.startsWith('http') ? ga : base + ga;
  const parts       = ['_method=POST'];
  if (csrf) parts.push(`_csrfToken=${encodeURIComponent(csrf)}`);
  parts.push(`ad_form_data=${encodeURIComponent(ad)}`);
  if (tf) parts.push(`_Token[fields]=${encodeURIComponent(decodeURIComponent(tf))}`);

  const rFinal = await client.post(finalAction, parts.join('&'), {
    headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': refForFinal, 'X-Requested-With': 'XMLHttpRequest' },
    timeout: 25000, maxRedirects: 5, validateStatus: s => s < 500,
  });

  const loc      = rFinal.headers?.location || rFinal.request?.res?.responseUrl;
  if (loc && DIRECT_HOST_RE.test(loc)) return loc;
  const finalUrl = rFinal.request?.res?.responseUrl;
  if (finalUrl && DIRECT_HOST_RE.test(finalUrl)) return finalUrl;
  const allHrefs = [...(rFinal.data?.matchAll?.(/href="(https?:\/\/[^"]+)"/g) || [])].map(m => m[1]);
  const direct   = allHrefs.find(u => DIRECT_HOST_RE.test(u));
  if (direct) return direct;
  try {
    const json = typeof rFinal.data === 'string' ? JSON.parse(rFinal.data) : rFinal.data;
    if (json?.url  && DIRECT_HOST_RE.test(json.url))  return json.url;
    if (json?.link && DIRECT_HOST_RE.test(json.link)) return json.link;
  } catch {}
  throw new Error(`No download link. Status=${rFinal.status}`);
}

async function bypassGeneric(url) {
  const r = await axios.get(url, { maxRedirects: 15, timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  return r.request?.res?.responseUrl || url;
}

async function bypassUrl(url) {
  const host = new URL(url).hostname;
  if (host.includes('softurl.in')) return bypassSofturl(url);
  return bypassGeneric(url);
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1: BYPASS ALL SHORTLINKS
// ═══════════════════════════════════════════════════════════════════════════
async function phaseBypass(allEntries, existingBypassed) {
  const alreadyBypassed = new Map(existingBypassed.map(e => [e.url, e.bypassedUrl]));
  const pending = allEntries.filter(e => e.host === 'Shortlink' && !alreadyBypassed.has(e.url));

  console.log(`\n  Direct links    : ${C.green}${allEntries.filter(e => e.host !== 'Shortlink').length}${C.reset}`);
  console.log(`  Pending bypass  : ${C.yellow}${pending.length}${C.reset}`);
  console.log(`  Already bypassed: ${alreadyBypassed.size}`);

  // Restore cached bypassed URLs first
  for (const e of allEntries) {
    if (!e.bypassedUrl && alreadyBypassed.has(e.url)) e.bypassedUrl = alreadyBypassed.get(e.url);
  }

  if (pending.length === 0) { log('No new shortlinks — bypass phase skipped.'); return; }

  let done = 0, succeeded = 0, failed = 0;
  const queue = [...pending];
  const active = new Set();

  async function processOne(item) {
    try {
      const bypassed = await bypassUrl(item.url);
      if (bypassed && bypassed !== item.url && DIRECT_HOST_RE.test(bypassed)) {
        item.bypassedUrl = bypassed;
        item.host        = detectHost(bypassed);
        succeeded++;
        process.stdout.write(`\r  ${C.green}✅${C.reset} [${item.title || '?'}] → ${bypassed.slice(0, 50)}\n`);
      } else {
        item.bypassedUrl = null; failed++;
        process.stdout.write(`\r  ${C.yellow}⚠️${C.reset} No direct URL: ${item.url.slice(0, 55)}\n`);
      }
    } catch (err) {
      item.bypassedUrl = null; failed++;
      process.stdout.write(`\r  ${C.red}❌${C.reset} ${item.url.slice(0, 50)}: ${err.message.slice(0, 35)}\n`);
    }
    done++;
    process.stdout.write(`\r  Progress: ${done}/${pending.length} | ✅ ${succeeded} | ❌ ${failed}  `);
  }

  while (queue.length > 0 || active.size > 0) {
    while (active.size < CONCURRENCY && queue.length > 0) {
      const item = queue.shift();
      const p = processOne(item).finally(() => active.delete(p));
      active.add(p);
    }
    if (active.size > 0) await Promise.race(active);
  }
  process.stdout.write('\n');

  // Checkpoint save
  const toSave = allEntries.filter(e => e.host !== 'Shortlink' || e.bypassedUrl);
  fs.writeFileSync(BYPASSED_FILE, JSON.stringify(toSave, null, 2));
  console.log(`\n  💾 Checkpoint saved → ${path.basename(BYPASSED_FILE)}`);
  console.log(`  ✅ ${succeeded} bypassed | ❌ ${failed} failed`);
}

// ═══════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════
let _lastApiCall = 0;
async function apiThrottle() {
  const wait = 270 - (Date.now() - _lastApiCall);
  if (wait > 0) await sleep(wait);
  _lastApiCall = Date.now();
}
async function fetchWithRetry(fn, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { await apiThrottle(); return await fn(); }
    catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        const ra = parseInt(err.response?.headers?.['retry-after'] || '10', 10);
        console.log(`\n⏳ TMDB rate limit. Waiting ${ra}s...`);
        await sleep(ra * 1000); continue;
      }
      if (attempt < retries && (!status || status >= 500)) { await sleep(1000 * (attempt + 1)); continue; }
      return null;
    }
  }
  return null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}
function stringSimilarity(a, b) {
  a = (a||'').toLowerCase().trim(); b = (b||'').toLowerCase().trim();
  if (a === b) return 1;
  const lo = a.length > b.length ? a : b, sh = a.length > b.length ? b : a;
  if (!lo.length) return 1;
  return (lo.length - levenshtein(lo, sh)) / lo.length;
}
function toMB(s) { if (!s) return 0; const n = parseFloat(s); return /GB/i.test(s) ? n * 1024 : (n || 0); }
function detectCodecLocal(fn) {
  const s = (fn||'').toUpperCase();
  if (/\bAV1\b/.test(s)) return 'AV1';
  if (/HEVC|H\.265|X265/.test(s)) return 'HEVC';
  return 'Other';
}
function seasonFromFilename(fn) {
  if (!fn) return null;
  const m = fn.match(/[._\s-]S(\d{1,2})[._\s\[\.-]/i) || fn.match(/\bS(\d{1,2})\b(?!\d)/i) || fn.match(/Season[\s._]?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TMDB SEARCH
// ═══════════════════════════════════════════════════════════════════════════
async function searchTMDB(title, year, isSeries, season, msgDate, imdbId, tmdbIdHint) {
  if (!TMDB_KEY) return null;
  const cleanTitle = cleanTitleForApi(title);
  if (!cleanTitle || cleanTitle.length < 2) return null;
  const BASE = 'https://api.themoviedb.org/3';
  const langMap = { en:'English',te:'Telugu',ta:'Tamil',hi:'Hindi',ml:'Malayalam',kn:'Kannada',ja:'Japanese',ko:'Korean',fr:'French',es:'Spanish',de:'German',it:'Italian',zh:'Chinese',ru:'Russian',pt:'Portuguese',ar:'Arabic',tr:'Turkish',id:'Indonesian',th:'Thai',bn:'Bengali' };

  function buildResult(d, isTv, extra = {}) {
    return {
      tmdbId: String(d.id), type: isTv ? 'series' : 'movie', totalSeasons: d.number_of_seasons || 0,
      title: d.title || d.name || title,
      description: extra.seasonOverview || d.overview || '',
      poster: extra.seasonPoster || (d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : ''),
      backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
      rating: Math.round((d.vote_average || 0) * 10) / 10,
      year: d.release_date ? parseInt(d.release_date, 10) : d.first_air_date ? parseInt(d.first_air_date, 10) : year,
      releaseDate: d.release_date || d.first_air_date || '',
      genre: (d.genres || []).map(g => g.name),
      duration: d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m`
        : (d.episode_run_time?.[0] ? `${Math.floor(d.episode_run_time[0] / 60)}h ${d.episode_run_time[0] % 60}m` : ''),
      originalLanguage: langMap[d.original_language] || d.original_language || '',
      confidence: 100,
    };
  }

  async function fetchSeasonData(tmdbId, sn, isTv) {
    if (!isTv || !sn) return {};
    const sr = await fetchWithRetry(() => axios.get(`${BASE}/tv/${tmdbId}/season/${sn}`, { params: { api_key: TMDB_KEY }, timeout: 8000 }));
    return { seasonPoster: sr?.data?.poster_path ? `https://image.tmdb.org/t/p/w500${sr.data.poster_path}` : '', seasonOverview: sr?.data?.overview || '' };
  }

  // Fast path: TMDB ID
  if (tmdbIdHint) {
    for (const mt of (isSeries ? ['tv','movie'] : ['movie','tv'])) {
      const r = await fetchWithRetry(() => axios.get(`${BASE}/${mt}/${tmdbIdHint}`, { params: { api_key: TMDB_KEY }, timeout: 8000 }));
      if (r?.data && (r.data.title || r.data.name)) {
        const isTv = mt === 'tv';
        return buildResult(r.data, isTv, await fetchSeasonData(r.data.id, season, isTv));
      }
    }
  }
  // Fast path: IMDB ID
  if (imdbId && /^tt\d{7,}$/.test(imdbId)) {
    const fr = await fetchWithRetry(() => axios.get(`${BASE}/find/${imdbId}`, { params: { api_key: TMDB_KEY, external_source: 'imdb_id' }, timeout: 8000 }));
    if (fr) {
      const hit = (fr.data?.movie_results || [])[0] || (fr.data?.tv_results || [])[0];
      const mt  = (fr.data?.movie_results || [])[0] ? 'movie' : 'tv';
      if (hit) {
        const r = await fetchWithRetry(() => axios.get(`${BASE}/${mt}/${hit.id}`, { params: { api_key: TMDB_KEY }, timeout: 8000 }));
        if (r?.data && (r.data.title || r.data.name)) {
          const isTv = mt === 'tv';
          return buildResult(r.data, isTv, await fetchSeasonData(r.data.id, season, isTv));
        }
      }
    }
  }

  const hintYear = year || (msgDate ? new Date(msgDate).getFullYear() : null);
  const isShort  = cleanTitle.trim().split(/\s+/).length <= 2;
  const typeEp   = isSeries ? 'tv' : 'movie', otherEp = isSeries ? 'movie' : 'tv';
  const strategies = [];
  if (hintYear) {
    strategies.push({ ep: typeEp, params: { query: cleanTitle, year: hintYear } });
    strategies.push({ ep: typeEp, params: { query: cleanTitle, year: hintYear - 1 } });
    strategies.push({ ep: typeEp, params: { query: cleanTitle, year: hintYear + 1 } });
  }
  strategies.push({ ep: typeEp,  params: { query: cleanTitle } });
  if (hintYear) strategies.push({ ep: 'multi', params: { query: cleanTitle, year: hintYear } });
  strategies.push({ ep: 'multi', params: { query: cleanTitle } });
  if (hintYear) strategies.push({ ep: otherEp, params: { query: cleanTitle, year: hintYear } });
  strategies.push({ ep: otherEp, params: { query: cleanTitle } });

  for (const { ep, params } of strategies) {
    const result = await fetchWithRetry(async () => {
      const url2 = ep === 'multi' ? `${BASE}/search/multi` : `${BASE}/search/${ep}`;
      const res  = await axios.get(url2, { params: { api_key: TMDB_KEY, ...params }, timeout: 10000 });
      let results = res.data.results || [];
      if (ep === 'multi') results = results.filter(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (!results.length) return null;

      const scored = results.slice(0, 10).map(r => {
        const rTitle = r.title || r.name || '', rOrig = r.original_title || r.original_name || '';
        const rYear  = r.release_date ? parseInt(r.release_date, 10) : r.first_air_date ? parseInt(r.first_air_date, 10) : null;
        const rType  = ep === 'multi' ? (r.media_type === 'tv' ? 'series' : 'movie') : (ep === 'tv' ? 'series' : 'movie');
        let score = Math.max(stringSimilarity(cleanTitleForApi(rTitle), cleanTitle), stringSimilarity(cleanTitleForApi(rOrig), cleanTitle)) * 60;
        if (hintYear && rYear) {
          const d = Math.abs(hintYear - rYear);
          score += d === 0 ? 30 : d === 1 ? 15 : d <= 2 ? 5 : -20;
        } else if (!hintYear && !rYear) score += 5;
        if ((isSeries ? 'series' : 'movie') === rType) score += 15; else score -= 10;
        if (r.popularity > 50) score += 5; if (r.popularity > 200) score += 5;
        return { r, score, rTitle, rOrig };
      });
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      const titleSim = Math.max(stringSimilarity(cleanTitleForApi(best.rTitle), cleanTitle), stringSimilarity(cleanTitleForApi(best.rOrig), cleanTitle));
      if (best.score < (isShort ? 62 : 52) || titleSim < (isShort ? 0.65 : 0.40)) return null;

      const isTv = ep === 'tv' || best.r.media_type === 'tv';
      const dr = await fetchWithRetry(() => axios.get(`${BASE}/${isTv ? 'tv' : 'movie'}/${best.r.id}`, { params: { api_key: TMDB_KEY }, timeout: 10000 }));
      if (!dr) return null;
      const sd = await fetchSeasonData(best.r.id, season, isTv);
      const d  = dr.data;
      return {
        tmdbId: String(d.id), type: isTv ? 'series' : 'movie', totalSeasons: d.number_of_seasons || 0,
        title: d.title || d.name || title, description: sd.seasonOverview || d.overview || '',
        poster: sd.seasonPoster || (d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : ''),
        backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
        rating: Math.round((d.vote_average || 0) * 10) / 10,
        year: d.release_date ? parseInt(d.release_date, 10) : d.first_air_date ? parseInt(d.first_air_date, 10) : hintYear,
        releaseDate: d.release_date || d.first_air_date || '',
        genre: (d.genres || []).map(g => g.name),
        duration: d.runtime ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m` : (d.episode_run_time?.[0] ? `${Math.floor(d.episode_run_time[0] / 60)}h ${d.episode_run_time[0] % 60}m` : ''),
        originalLanguage: langMap[d.original_language] || d.original_language || '',
        confidence: Math.round(best.score),
      };
    });
    if (result) return result;
  }
  return null;
}

async function searchOMDB(title, year, isSeries) {
  if (!OMDB_KEY) return null;
  return fetchWithRetry(async () => {
    const params = { t: cleanTitleForApi(title), apikey: OMDB_KEY, type: isSeries ? 'series' : 'movie', plot: 'short' };
    if (year) params.y = year;
    const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 8000 });
    const d = res.data;
    if (!d || d.Response === 'False') return null;
    const m = d.Runtime ? parseInt(d.Runtime) : null;
    return { title: d.Title || title, description: d.Plot !== 'N/A' ? d.Plot : '', poster: d.Poster !== 'N/A' ? d.Poster : '', rating: d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0, year: d.Year ? parseInt(d.Year, 10) : year, genre: d.Genre !== 'N/A' ? d.Genre.split(', ') : [], duration: m ? `${Math.floor(m/60)}h ${m%60}m` : '', imdbId: d.imdbID || '' };
  });
}

function recomputeAggregates(doc) {
  const dls = doc.downloads || [];
  doc.formats = [...new Set(dls.map(d => d.quality))].filter(Boolean);
  doc.codecs  = [...new Set(dls.map(d => d.codec || detectCodecLocal(d.filename)))].filter(c => c && c !== 'Other');
  const allLangs = [];
  dls.forEach(d => { if (d.language) d.language.split(',').forEach(l => { const c = l.trim(); allLangs.push(c.charAt(0).toUpperCase() + c.slice(1).toLowerCase()); }); });
  doc.languages = [...new Set(allLangs)].filter(Boolean);
  const QUALITY_ORDER = ['4K', '1080p', '720p', '480p', '360p', 'HD'];
  const best = QUALITY_ORDER.find(q => doc.formats.includes(q));
  if (best) doc.quality = best;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2: IMPORT TO MONGODB
// ═══════════════════════════════════════════════════════════════════════════
async function phaseImport(allEntries) {
  // Accept: direct links OR shortlinks that were successfully bypassed
  const valid = allEntries.filter(e => {
    if (e.host !== 'Shortlink') return true;
    return e.bypassedUrl && DIRECT_HOST_RE.test(e.bypassedUrl);
  });
  const stillShort = allEntries.length - valid.length;
  console.log(`\n  Importable entries : ${C.green}${valid.length}${C.reset}`);
  if (stillShort > 0) console.log(`  Skipped (no bypass): ${C.yellow}${stillShort}${C.reset}`);

  let added = 0, updated = 0, skipped = 0, noMeta = 0;

  // ── Group by title+year for TMDB efficiency ───────────────────────────────────────
  const groups = {};
  for (const item of valid) {
    const key = `${(item.title || '').toLowerCase().trim()}__${item.year || ''}`;
    if (!groups[key]) groups[key] = { items: [], msgDate: item.date || null };
    if (item.date && (!groups[key].msgDate || item.date < groups[key].msgDate)) groups[key].msgDate = item.date;
    groups[key].items.push(item);
  }
  console.log(`  Unique title groups: ${Object.keys(groups).length}`);

  // ── Checkpoint: load already-processed groups for --resume ────────────────────────
  let processedKeys = new Set();
  if (RESUME && fs.existsSync(CHECKPOINT_FILE)) {
    try {
      processedKeys = new Set(JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')));
      console.log(`  ⏭️  Resuming: ${processedKeys.size} groups already done — skipping them`);
    } catch(_) { warn('Could not read checkpoint file — starting fresh'); }
  } else if (!RESUME && fs.existsSync(CHECKPOINT_FILE)) {
    // Clean checkpoint on fresh run
    try { fs.unlinkSync(CHECKPOINT_FILE); } catch(_) {}
  }

  const groupEntries = Object.entries(groups).filter(([key]) => !processedKeys.has(key));
  console.log(`  Processing: ${groupEntries.length} groups\n`);

  // Save checkpoint every N groups so crashes can resume from near where they stopped
  const CHECKPOINT_EVERY = 50;
  function saveCheckpoint(processedSoFar) {
    try { fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify([...processedKeys, ...processedSoFar])); }
    catch(_) {}
  }

  async function processGroup([, group]) {
    const rep   = group.items[0];
    const isSer = rep.isSeries || rep.contentType === 'series' || rep.contentType === 'anime';

    const esc = (rep.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let existing = null;
    if (rep.year)  existing = await Movie.findOne({ title: { $regex: `^${esc}$`, $options: 'i' }, year: rep.year });
    if (!existing) existing = await Movie.findOne({ title: { $regex: `^${esc}$`, $options: 'i' } });

    let meta = {};
    if (existing) {
      meta = { tmdbId: existing.tmdbId, title: existing.title, type: existing.type };
    } else if (rep.title) {
      const tmdb = await searchTMDB(rep.title, rep.year, isSer, rep.season, group.msgDate, rep.imdbId || null, rep.tmdbIdHint || null);
      if (tmdb) {
        Object.assign(meta, tmdb);
        if (!meta.poster || !meta.rating || !meta.imdbId) {
          const omdb = await searchOMDB(rep.title, rep.year, isSer);
          if (omdb) {
            if (!meta.poster      && omdb.poster)      meta.poster      = omdb.poster;
            if (!meta.rating      && omdb.rating)      meta.rating      = omdb.rating;
            if (!meta.description && omdb.description) meta.description = omdb.description;
            if (!meta.duration    && omdb.duration)    meta.duration    = omdb.duration;
            if (!meta.genre?.length && omdb.genre?.length) meta.genre   = omdb.genre;
            if (omdb.imdbId)                           meta.imdbId      = omdb.imdbId;
          }
        }
      } else {
        const omdb = await searchOMDB(rep.title, rep.year, isSer);
        if (omdb) Object.assign(meta, omdb, { tmdbId: '' });
      }
    }

    if (!meta.title) {
      if (!rep.title) { noMeta += group.items.length; return; }
      meta = { title: rep.title, year: rep.year || null, type: isSer ? 'series' : 'movie', tmdbId: '', imdbId: '', poster: '', backdrop: '', rating: 0, description: '', genre: [], duration: '' };
      console.log(`⚠️  No TMDB — raw title: "${meta.title}"`);
    }

    const tmdbGenres  = (meta.genre || []).map(g => (g||'').toLowerCase());
    const isAnimation = tmdbGenres.some(g => /animation|anime/i.test(g));
    const origLang    = (meta.originalLanguage || '').toLowerCase();
    const isEastAsian = /^(japanese|korean|chinese|mandarin|cantonese|ja|ko|zh)$/.test(origLang);
    const parserAnime = rep.contentType === 'anime';
    let finalType;
    if ((isAnimation && isEastAsian) || (parserAnime && (isAnimation || isEastAsian)) || parserAnime) finalType = 'anime';
    else if (meta.type === 'series' || isSer) finalType = 'series';
    else finalType = 'movie';

    for (const item of group.items) {
      // KEY FIX: use bypassedUrl for shortlinks, direct url otherwise
      let finalUrl = item.bypassedUrl || item.url;
      finalUrl = finalUrl.replace(/^http:\/\//i, 'https://').replace(/\/$/, '');
      const host     = detectHost(finalUrl);
      const quality  = item.quality  || 'HD';
      const size     = item.size     || '';
      const language = item.language || '';
      const codec    = item.codec    || detectCodecLocal(item.filename);
      const hdr      = item.hdr      || null;
      const correctSeason = seasonFromFilename(item.filename) ?? item.season ?? null;

      let dbRec = existing;
      if (!dbRec && meta.tmdbId) dbRec = await Movie.findOne({ tmdbId: meta.tmdbId });

      const newDl = {
        quality, size, filename: item.filename || '', language, codec, hdr,
        season: correctSeason, episode: item.episode ?? null,
        links: [{ host, url: finalUrl, isFast: /gdflix|hubcloud|gdlink/i.test(finalUrl) }],
      };

      if (dbRec) {
        if (dbRec.downloads?.some(d => d.links?.some(l => l.url === finalUrl))) { skipped++; continue; }
        const newMB = toMB(size);
        let matchedIdx = -1;
        for (let j = 0; j < dbRec.downloads.length; j++) {
          const ex = dbRec.downloads[j];
          const qualOk   = ex.quality === quality;
          const langOk   = (ex.language || '') === (language || '');
          const seasOk   = (finalType === 'series' || finalType === 'anime') ? (ex.season == correctSeason && ex.episode == (item.episode ?? null)) : true;
          const sizeOk   = ex.size === size || (newMB > 0 && toMB(ex.size) > 0 && Math.abs(newMB - toMB(ex.size)) < 2) || (!ex.size && !size);
          if (qualOk && langOk && seasOk && sizeOk) { matchedIdx = j; break; }
        }
        const metaSet = {};
        if (!dbRec.backdrop    && meta.backdrop)    metaSet.backdrop    = meta.backdrop;
        if (!dbRec.poster      && meta.poster)      metaSet.poster      = meta.poster;
        if (!dbRec.tmdbId      && meta.tmdbId)      metaSet.tmdbId      = meta.tmdbId;
        if (!dbRec.imdbId      && meta.imdbId)      metaSet.imdbId      = meta.imdbId;
        if (!dbRec.rating      && meta.rating)      metaSet.rating      = meta.rating;
        if (!dbRec.description && meta.description) metaSet.description = meta.description;
        if (finalType === 'anime' && dbRec.type === 'series') metaSet.type = 'anime';

        if (matchedIdx >= 0) {
          const existLinks = dbRec.downloads[matchedIdx]?.links || [];
          if (existLinks.length >= 3 || existLinks.map(l => l.host).includes(host)) { skipped++; continue; }
          const op = { $addToSet: { [`downloads.${matchedIdx}.links`]: newDl.links[0] } };
          if (Object.keys(metaSet).length) op.$set = metaSet;
          const res = await Movie.findOneAndUpdate({ _id: dbRec._id, [`downloads.${matchedIdx}.links.url`]: { $ne: finalUrl } }, op, { new: true });
          if (res) {
            recomputeAggregates(res);
            await Movie.findByIdAndUpdate(dbRec._id, { $set: { formats: res.formats, quality: res.quality, languages: res.languages, codecs: res.codecs } });
            console.log(`🔗 Merged: [${dbRec.title}] ${quality} → ${host}`);
            updated++;
          } else skipped++;
        } else {
          const op = { $push: { downloads: newDl } };
          if (Object.keys(metaSet).length) op.$set = metaSet;
          const res = await Movie.findByIdAndUpdate(dbRec._id, op, { new: true });
          if (res) {
            recomputeAggregates(res);
            await Movie.findByIdAndUpdate(dbRec._id, { $set: { formats: res.formats, quality: res.quality, languages: res.languages, codecs: res.codecs } });
            console.log(`🔄 Updated: [${dbRec.title}] ${quality} → ${host}`);
            updated++;
          }
        }
        continue;
      }

      try {
        const origLang2 = meta.originalLanguage || meta.language || '';
        const newDoc = await Movie.create({
          title: meta.title, tmdbId: meta.tmdbId || '', imdbId: meta.imdbId || '',
          type: finalType, totalSeasons: meta.totalSeasons || 0,
          description: meta.description || '', poster: meta.poster || '', backdrop: meta.backdrop || '',
          rating: meta.rating || 0, year: meta.year || item.year || new Date().getFullYear(),
          genre: meta.genre || [], duration: meta.duration || '', quality, language: origLang2,
          formats: [quality].filter(Boolean), codecs: [codec].filter(c => c !== 'Other'),
          languages: (language || origLang2).split(',').map(l => l.trim()).filter(Boolean),
          telegramMessageIds: item.messageId ? [item.messageId] : [],
          downloads: [newDl],
        });
        added++; existing = newDoc;
        console.log(`➕ Added: [${meta.title}] (${meta.year || '?'}) ${quality} → ${host}`);
      } catch (e) {
        console.error(`❌ DB error "${meta.title}": ${e.message}`);
        skipped++;
      }
    }
  }

  let gi = 0;
  const active2 = [];
  const batchDoneKeys = [];
  for (const entry of groupEntries) {
    if (active2.length >= 2) await Promise.race(active2);
    const p = processGroup(entry).finally(() => {
      active2.splice(active2.indexOf(p), 1);
      batchDoneKeys.push(entry[0]);
      // Checkpoint: save every CHECKPOINT_EVERY groups
      if (batchDoneKeys.length % CHECKPOINT_EVERY === 0) saveCheckpoint(batchDoneKeys);
    });
    active2.push(p); gi++;
    if (gi % 100 === 0) process.stdout.write(`\r   Importing: ${gi}/${groupEntries.length}...`);
    await sleep(50);
  }
  await Promise.all(active2);
  saveCheckpoint(batchDoneKeys); // final checkpoint save
  process.stdout.write(`\r   Importing: ${groupEntries.length}/${groupEntries.length} — Done!         \n`);

  console.log(`\n  ${C.green}➕ Added   : ${added}${C.reset}`);
  console.log(`  ${C.cyan}🔄 Updated : ${updated}${C.reset}`);
  console.log(`  ${C.gray}⏭️  Skipped : ${skipped}${C.reset}`);
  if (noMeta) console.log(`  ${C.yellow}❓ No meta : ${noMeta}${C.reset}`);
  // Clean checkpoint on full success
  try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE); } catch(_) {}
}

// ─── Spawn child script — pipe output through _emitter for SSE streaming ──────
function runScript(scriptPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],  // pipe stdout+stderr → _emitter
    });

    const rl_out = require('readline').createInterface({ input: child.stdout });
    const rl_err = require('readline').createInterface({ input: child.stderr });
    rl_out.on('line', line => { if (line.trim()) _emitter(line); });
    rl_err.on('line', line => { if (line.trim()) _emitter(`ERROR: ${line}`); });

    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}: ${path.basename(scriptPath)}`)));
    child.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main(opts = {}) {
  // Support both CLI and require() usage
  // opts.noWipe, opts.noHeal, opts.noBypass, opts.resume, opts.concurrency, opts.importSrc, opts.emitter
  if (opts.emitter) _emitter = opts.emitter;

  const NO_WIPE     = opts.noWipe     !== undefined ? opts.noWipe     : _argv.includes('--no-wipe');
  const NO_HEAL     = opts.noHeal     !== undefined ? opts.noHeal     : _argv.includes('--no-heal');
  const NO_BYPASS   = opts.noBypass   !== undefined ? opts.noBypass   : _argv.includes('--no-bypass');
  const RESUME      = opts.resume     !== undefined ? opts.resume     : _argv.includes('--resume');
  const CONCURRENCY = opts.concurrency || parseInt((_argv.find(a => a.startsWith('--concurrency=')) || '').replace('--concurrency=', '') || '3', 10);
  const IMPORT_SRC  = opts.importSrc  || (_argv.find(a => a.startsWith('--import-source=')) || '').replace('--import-source=', '') || null;

  const t0 = Date.now();
  log('XLOOP ─ UNIFIED BYPASS + IMPORT PIPELINE');

  if (!TMDB_KEY) warn('TMDB_API_KEY not set — posters will be blank!');
  if (!process.env.MONGODB_URI) warn('MONGODB_URI not set — defaulting to localhost');

  // STEP 0: Wipe
  sep();
  if (!NO_WIPE) {
    log('STEP 0 — Wiping database...');
    // Inline wipe — avoid spawning wipe_db.js (not available on Vercel serverless)
    const r = await Movie.deleteMany({});
    ok(`Database wiped — removed ${r.deletedCount} entries`);
  } else {
    warn('STEP 0 — Skipping wipe (--no-wipe)');
  }

  // STEP 1: Extract
  sep();
  if (!IMPORT_SRC) {
    if (!fs.existsSync(path.join(ROOT, 'telegram_export.json'))) { fail('telegram_export.json not found! Upload it first.'); throw new Error('telegram_export.json not found'); }
    log('STEP 1 — Parsing telegram_export.json...');
    await runScript(path.join(ROOT, 'extract_links.js'));
    ok('Extraction done → links_for_bypasser.json + shortlinks_report.json');
  } else {
    warn(`STEP 1 — Using existing file: ${IMPORT_SRC}`);
  }

  // Merge all entries (direct + shortlinks from separate file)
  const sourceFile = IMPORT_SRC || LINKS_FILE;
  if (!fs.existsSync(sourceFile)) { fail(`Source file not found: ${sourceFile}`); throw new Error(`Source file not found: ${sourceFile}`); }
  let allEntries = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

  // Pull in shortlinks from shortlinks_report.json
  if (!IMPORT_SRC && fs.existsSync(SHORTLINKS_FILE)) {
    const shortlinkData = JSON.parse(fs.readFileSync(SHORTLINKS_FILE, 'utf8'));
    if (shortlinkData.length > 0) {
      log(`Merging ${shortlinkData.length} shortlinks from shortlinks_report.json`);
      const existingUrls = new Set(allEntries.map(e => e.url));
      allEntries = [...allEntries, ...shortlinkData.filter(e => !existingUrls.has(e.url))];
    }
  }

  const existingBypassed = fs.existsSync(BYPASSED_FILE) ? JSON.parse(fs.readFileSync(BYPASSED_FILE, 'utf8')) : [];

  log(`Total entries: ${allEntries.length} | Direct: ${allEntries.filter(e => e.host !== 'Shortlink').length} | Shortlinks: ${allEntries.filter(e => e.host === 'Shortlink').length} | Prev bypassed: ${existingBypassed.length}`);

  // STEP 2: Bypass
  sep();
  if (!NO_BYPASS) {
    log(`STEP 2 — Bypassing shortlinks (concurrency=${CONCURRENCY})...`);
    await phaseBypass(allEntries, existingBypassed);
    ok('Bypass phase complete');
  } else {
    warn('STEP 2 — Bypass skipped (--no-bypass)');
    const bmap = new Map(existingBypassed.map(e => [e.url, e.bypassedUrl]));
    for (const e of allEntries) { if (!e.bypassedUrl && bmap.has(e.url)) e.bypassedUrl = bmap.get(e.url); }
  }

  // STEP 3: MongoDB connect
  sep();
  log('STEP 3 — Connecting to MongoDB...');
  const MONGO_OPTS = {
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS:         15_000,
    socketTimeoutMS:          60_000,
    heartbeatFrequencyMS:     10_000,
    family:                   4,
    maxPoolSize:              5,
    minPoolSize:              1,
    retryWrites:              true,
  };
  let mongoConnected = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop', MONGO_OPTS);
      mongoConnected = true;
      break;
    } catch (err) {
      warn(`MongoDB connect attempt ${attempt}/5 failed: ${err.message}`);
      if (attempt < 5) { log(`Retrying in ${attempt * 5}s...`); await sleep(attempt * 5000); }
    }
  }
  if (!mongoConnected) { fail('Could not connect to MongoDB after 5 attempts. Aborting.'); throw new Error('MongoDB connection failed'); }
  mongoose.connection.on('disconnected', async () => {
    warn('MongoDB disconnected mid-run — attempting reconnect...');
    for (let i = 1; i <= 5; i++) {
      try { await sleep(i * 3000); await mongoose.connect(process.env.MONGODB_URI, MONGO_OPTS); log('MongoDB reconnected.'); break; }
      catch(_) { warn(`Reconnect attempt ${i}/5 failed`); }
    }
  });
  ok('MongoDB connected');

  // STEP 4: Import
  sep();
  log('STEP 4 — Importing all entries → MongoDB...');
  await phaseImport(allEntries);
  ok('Import complete');
  try { await mongoose.disconnect(); } catch(_) {}

  // STEP 5: Heal
  sep();
  if (!NO_HEAL) {
    log('STEP 5 — Healing remaining metadata gaps...');
    await runScript(path.join(ROOT, 'heal_db.js'));
    ok('Healing complete');
  } else {
    warn('STEP 5 — Skipping healer (--no-heal)');
  }

  sep();
  const s = Math.round((Date.now() - t0) / 1000);
  ok(`🎉 Pipeline complete in ${Math.floor(s/60)}m ${s%60}s`);
}

// ── When run directly from CLI ────────────────────────────────────────────────
if (IS_MAIN) {
  main().catch(e => { fail(`Pipeline failed: ${e.message}`); process.exit(1); });
}

// ── When require()'d by orchestrator route ────────────────────────────────────
module.exports = { runPipeline: main };
