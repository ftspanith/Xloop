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
const {
  cleanTitleForApi, detectHost, detectCodec, detectHDR, extractAudio,
  detectBitDepth, detectAudioChannels, detectSource, detectContainer,
  normalizeQuality, extractSize, detectAllLanguages, extractSeasonEpisode,
  classifyLanguages, extractMediaMetadata,
} = require('./utils/parser');
const sharedMetadataSearch = require('./utils/tmdbSearch');
const { analyzeVariantSet, rankVariantsForDisplay } = require('./utils/variant-intelligence');

// ─── CLI args (only used when run directly, not when require()'d) ─────────────
const IS_MAIN = require.main === module;
const _argv        = IS_MAIN ? process.argv.slice(2) : [];

const ROOT             = __dirname;
const IS_VERCEL        = !!process.env.VERCEL;
const TMP              = IS_VERCEL ? '/tmp' : ROOT;
const EXPORT_FILE      = path.join(TMP, 'telegram_export.json');
const LINKS_FILE       = path.join(TMP, 'links_for_bypasser.json');
const SHORTLINKS_FILE  = path.join(TMP, 'shortlinks_report.json');
const BYPASSED_FILE    = path.join(TMP, 'bypassed_links.json');
const CHECKPOINT_FILE  = path.join(TMP, 'import_checkpoint.json');
const TMDB_KEY         = process.env.TMDB_API_KEY  || '';
const OMDB_KEY         = process.env.OMDB_API_KEY  || '';
const GOOGLE_API_KEY   = process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_ID    = process.env.GOOGLE_CSE_ID  || '';

// ─── Terminal colors ──────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
// emitter: function(line:string) — injected by orchestrator route for SSE streaming
// When running as CLI, emitter simply prints to stdout
let _emitter = line => process.stdout.write(line + '\n');
const log  = msg => _emitter(`[LOG] ${msg}`);
const ok   = msg => _emitter(`[OK] ${msg}`);
const warn = msg => _emitter(`[WARN]  ${msg}`);
const fail = msg => _emitter(`[ERR] ${msg}`);
const sep  = ()  => _emitter('─'.repeat(64));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Canonical URL normalizer ──────────────────────────────────────────────────
// All GDFlix mirrors → gdflix.dev  |  All HubCloud mirrors → hubcloud.one
// Preserves the full path + query string so the link still works.
const GDFLIX_RE    = /^https?:\/\/gdflix\.(dev|to|one|link|net|dad|cfd|xyz)/i;
const GDLINK_RE    = /^https?:\/\/gdlink\.dev/i;
const HUBCLOUD_RE  = /^https?:\/\/hubcloud\.(foo|one|art|cx|lol|bz|club|in|to|work|zone|dev|me|best)/i;
const DRIVEHUB_RE  = /^https?:\/\/drivehub\.(dev|to|in|online)/i;

function normalizeUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    // GDFlix family → gdflix.dev
    if (GDFLIX_RE.test(url) || GDLINK_RE.test(url)) {
      return `https://gdflix.dev${parsed.pathname}${parsed.search}`;
    }
    // HubCloud / DriveHub family → hubcloud.one
    if (HUBCLOUD_RE.test(url) || DRIVEHUB_RE.test(url)) {
      return `https://hubcloud.one${parsed.pathname}${parsed.search}`;
    }
  } catch (_) {}
  return url;
}

// Only accept these as valid bypassed direct URLs (reliable cloud hosts only)
const DIRECT_HOST_RE = /gdflix|hubcloud|tmbcloud|1fichier|filemoon|streamtape|pixeldrain|krakenfiles|buzzheavier|doodstream|mixdrop/i;

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
async function phaseBypass(allEntries, existingBypassed, CONCURRENCY = 3, isStopRequested = () => false) {
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
        process.stdout.write(`\r  ${C.green}[OK]${C.reset} [${item.title || '?'}] → ${bypassed.slice(0, 50)}\n`);
      } else {
        item.bypassedUrl = null; failed++;
        process.stdout.write(`\r  ${C.yellow}[WARN]${C.reset} No direct URL: ${item.url.slice(0, 55)}\n`);
      }
    } catch (err) {
      item.bypassedUrl = null; failed++;
      process.stdout.write(`\r  ${C.red}[ERR]${C.reset} ${item.url.slice(0, 50)}: ${err.message.slice(0, 35)}\n`);
    }
    done++;
    process.stdout.write(`\r  Progress: ${done}/${pending.length} | [OK] ${succeeded} | [ERR] ${failed}  `);
  }

  while (queue.length > 0 || active.size > 0) {
    if (isStopRequested()) { _emitter('\n  [WARN] Bypass aborted by user stop request.'); break; }
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
  console.log(`\n  [SAVE] Checkpoint saved → ${path.basename(BYPASSED_FILE)}`);
  console.log(`  [OK] ${succeeded} bypassed | [ERR] ${failed} failed`);
}

// ═══════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════
let _lastApiCall = 0;
async function apiThrottle() {
  const wait = 500 - (Date.now() - _lastApiCall);
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
        console.log(`\n... TMDB rate limit. Waiting ${ra}s...`);
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
  return detectCodec(fn || '') || 'Other';
}
function seasonFromFilename(fn) {
  if (!fn) return null;
  const m = fn.match(/[._\s-]S(\d{1,2})[._\s\[\.-]/i) || fn.match(/\bS(\d{1,2})\b(?!\d)/i) || fn.match(/Season[\s._]?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

async function searchOMDB(title, year, isSeries) {
  return sharedMetadataSearch.searchOMDB(title, year, isSeries, OMDB_KEY);
}

// ─────────────────────────────────────────────────────────────────────────
// GOOGLE IMAGE SEARCH
// ─────────────────────────────────────────────────────────────────────────
// Falls back to Google Custom Search API when TMDB + OMDB both return no poster.
// Requires GOOGLE_API_KEY and GOOGLE_CSE_ID in env.
// Returns a direct image URL string or null.
async function searchGoogleImage(title, year, isSeries) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) return null;
  const cleanT = cleanTitleForApi(title) || title;
  const type   = isSeries ? 'TV show' : 'movie';
  const q = year ? `"${cleanT}" ${year} ${type} official poster` : `"${cleanT}" ${type} official poster`;
  try {
    const res = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID,
        q, searchType: 'image',
        imgType: 'photo', imgSize: 'large',
        num: 5, safe: 'off',
      },
      timeout: 8000,
    });
    const items = res.data?.items || [];
    // Prefer portrait-ratio images (poster shape) over landscape
    for (const item of items) {
      const w = item.image?.width  || 0;
      const h = item.image?.height || 0;
      const url = item.link || '';
      if (!url) continue;
      // Accept portrait (h > w) or near-square — skip wide banners
      if (h >= w * 0.9) return url;
    }
    // Fallback: just return first image URL
    return items[0]?.link || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────
// POSTER VALIDATION
// ─────────────────────────────────────────────────────────────────────────
// HEAD request to confirm a poster URL is reachable (returns 200).
// Returns the url if valid, null otherwise.
async function validatePoster(url) {
  if (!url) return null;
  // TMDB CDN images are always reachable — skip expensive HEAD round-trip
  if (/image\.tmdb\.org/i.test(url)) return url;
  try {
    const r = await axios.head(url, { timeout: 6000, maxRedirects: 3 });
    return r.status >= 200 && r.status < 400 ? url : null;
  } catch { return null; }
}

function recomputeAggregates(doc) {
  const dls = doc.downloads || [];
  const QUALITY_ORDER = ['8K', '4K', '1440p', '1080p', '720p', '576p', '540p', '480p', '360p', '240p', 'SD', 'HD'];

  // Preserve the catalogue's quality-first order. Inside each quality group,
  // use cross-account variant intelligence to rank close-size encodes by
  // source, codec, HDR, audio and metadata completeness. No link is removed.
  const qualityKeys = [...new Set(dls.map(download => download.quality || ''))]
    .sort((a, b) => {
      const ai = QUALITY_ORDER.indexOf(a);
      const bi = QUALITY_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  const sortedDownloads = [];
  for (const quality of qualityKeys) {
    const group = dls.filter(download => (download.quality || '') === quality);
    const ranked = rankVariantsForDisplay(group.map((download, index) => ({
      ...(typeof download.toObject === 'function' ? download.toObject() : download),
      title: doc.title || '',
      year: doc.year || null,
      _rankIndex: index,
    })), { sizeTolerance: 0.08 });
    sortedDownloads.push(...ranked.map(item => group[item._rankIndex]).filter(Boolean));
  }
  // Keep original Mongoose subdocuments; only change their display order.
  dls.splice(0, dls.length, ...sortedDownloads);

  doc.formats = [...new Set(dls.map(d => d.quality))].filter(Boolean);
  doc.codecs  = [...new Set(dls.map(d => d.codec || detectCodecLocal(d.filename)))].filter(c => c && c !== 'Other');
  const allLangs = [];
  dls.forEach(d => {
    if (!d.language) return;
    d.language.split(',').forEach(l => {
      const c = l.trim();
      if (c && !/^(?:single|dual|multi)(?:\s+audio)?$/i.test(c)) {
        allLangs.push(c.charAt(0).toUpperCase() + c.slice(1).toLowerCase());
      }
    });
  });
  doc.languages = [...new Set(allLangs)].filter(Boolean);
  // Root language is derived from stored downloads, never TMDB/OMDb original language.
  doc.language = doc.languages.join(', ');
  const primaryDownload = dls.find(download =>
    (download.language && !/^(?:single|dual|multi)(?:\s+audio)?$/i.test(String(download.language).trim()))
    || Number(download.languageCount) > 0
  ) || dls.find(download => download.languageType || download.language);
  const primaryLanguageInfo = primaryDownload
    ? classifyLanguages(primaryDownload.language || '', primaryDownload.filename || '')
    : classifyLanguages(doc.languages || [], '');
  doc.languageType = primaryDownload?.languageType || primaryLanguageInfo.languageType || '';
  const best = QUALITY_ORDER.find(q => doc.formats.includes(q));
  if (best) doc.quality = best;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2: IMPORT TO MONGODB
// ═══════════════════════════════════════════════════════════════════════════
async function phaseImport(allEntries, RESUME = false, isStopRequested = () => false) {
  // Accept: direct links OR shortlinks that were successfully bypassed
  const valid = allEntries.filter(e => {
    if (e.host !== 'Shortlink') return true;
    return e.bypassedUrl && DIRECT_HOST_RE.test(e.bypassedUrl);
  });
  const stillShort = allEntries.length - valid.length;

  // PRE-DEDUP: collapse entries that resolve to the same final URL.
  // This catches the case where a direct GDFlix entry AND a shortlink-bypassed-to-GDFlix
  // entry both exist in the list — they'd produce identical finalUrls and cause duplicates.
  const seenFinalUrls = new Set();
  const deduped = valid.filter(e => {
    const resolved = normalizeUrl(
      (e.bypassedUrl || e.url || '').replace(/^http:\/\//i,'https://').replace(/\/$/, '')
    );
    if (!resolved || seenFinalUrls.has(resolved)) return false;
    seenFinalUrls.add(resolved);
    return true;
  });
  const preDedupRemoved = valid.length - deduped.length;

  _emitter(`\n  Importable entries : ${C.green}${valid.length}${C.reset}`);
  if (preDedupRemoved > 0) _emitter(`  Pre-dedup removed  : ${C.yellow}${preDedupRemoved}${C.reset} (same URL from direct+bypass)`);
  if (stillShort > 0)      _emitter(`  Skipped (no bypass): ${C.yellow}${stillShort}${C.reset}`);

  let added = 0, updated = 0, skipped = 0, noMeta = 0;

  // ── Group by title+year for TMDB efficiency ───────────────────────────────────────
  const groups = {};
  for (const item of deduped) {
    const key = `${(item.title || '').toLowerCase().trim()}__${item.year || ''}`;
    if (!groups[key]) groups[key] = { items: [], msgDate: item.date || null };
    if (item.date && (!groups[key].msgDate || item.date < groups[key].msgDate)) groups[key].msgDate = item.date;
    groups[key].items.push(item);
  }
  _emitter(`  Unique title groups: ${Object.keys(groups).length}`);

  // ── Checkpoint: load already-processed groups for --resume ────────────────────────
  let processedKeys = new Set();
  if (RESUME) {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      try {
        processedKeys = new Set(JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')));
      } catch(_) {}
    }
    if (processedKeys.size === 0) {
      try {
        const PipelineCache = require('./models/PipelineCache');
        const cpDoc = await PipelineCache.findOne({ key: '_import_checkpoint' }).lean();
        if (cpDoc && Array.isArray(cpDoc.data)) {
          processedKeys = new Set(cpDoc.data);
        }
      } catch(_) {}
    }
    if (processedKeys.size > 0) {
      _emitter(`  [SKIP]  Resuming: ${processedKeys.size} groups already done — skipping them`);
    }
  } else {
    // Clean checkpoint on fresh run
    try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE); } catch(_) {}
    try {
      const PipelineCache = require('./models/PipelineCache');
      PipelineCache.deleteOne({ key: '_import_checkpoint' }).exec().catch(() => {});
    } catch(_) {}
  }

  const groupEntries = Object.entries(groups).filter(([key]) => !processedKeys.has(key));
  _emitter(`  Processing: ${groupEntries.length} groups\n`);

  // Save checkpoint every N groups so crashes can resume from near where they stopped
  const CHECKPOINT_EVERY = 50;
  function saveCheckpoint(processedSoFar) {
    const allDone = [...processedKeys, ...processedSoFar];
    try { fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(allDone)); }
    catch(_) {}
    try {
      const PipelineCache = require('./models/PipelineCache');
      PipelineCache.findOneAndUpdate(
        { key: '_import_checkpoint' },
        { $set: { data: allDone, count: allDone.length, updatedAt: new Date() } },
        { upsert: true }
      ).exec().catch(() => {});
    } catch(_) {}
  }

  async function processGroup([, group]) {
    const rep   = group.items[0];
    const isSer = rep.isSeries || rep.contentType === 'series' || rep.contentType === 'anime';

    // Advisory cross-account variant analysis: reports close-size/metadata
    // candidates but never drops a link or treats size as proof of identity.
    const variantAnalysis = analyzeVariantSet(group.items, { sizeTolerance: 0.01 });
    if (variantAnalysis.nearDuplicates.length) {
      _emitter(`[VARIANT] "${rep.title}": ${variantAnalysis.nearDuplicates.length} possible near-duplicate group(s) flagged for review; no variants removed.`);
    }

    let cleanTitle = cleanTitleForApi(rep.title || '', rep.year);

    const esc = (cleanTitle || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let existing = null;
    // PRIMARY dedup: tmdbId hint from parser (fastest, avoids all title-variation duplicates)
    if (rep.tmdbIdHint) existing = await Movie.findOne({ tmdbId: String(rep.tmdbIdHint) });
    // SECONDARY: title+year exact match
    if (!existing && rep.year && cleanTitle)  existing = await Movie.findOne({ title: { $regex: `^${esc}$`, $options: 'i' }, year: rep.year });
    // TERTIARY: title-only match (different years, same franchise name)
    if (!existing && cleanTitle) existing = await Movie.findOne({ title: { $regex: `^${esc}$`, $options: 'i' } });

    let meta = existing ? {
      tmdbId: existing.tmdbId || '', imdbId: existing.imdbId || '',
      title: existing.title || cleanTitle, type: existing.type || (isSer ? 'series' : 'movie'),
      totalSeasons: existing.totalSeasons || 0,
      description: existing.description || '', poster: existing.poster || '',
      posterFallback: existing.posterFallback || '', backdrop: existing.backdrop || '',
      rating: existing.rating || 0, year: existing.year || rep.year || null,
      genre: existing.genre || [], duration: existing.duration || '',
      runtimeMinutes: existing.runtimeMinutes ?? rep.runtimeMinutes ?? null,
      certification: existing.certification || rep.certification || '',
      isIMAX: !!existing.isIMAX || !!rep.isIMAX,
      aspectRatio: existing.aspectRatio || rep.aspectRatio || '',
      languageType: existing.languageType || rep.languageType || '',
      seasonPosters: existing.seasonPosters || {},
      seasonPoster: rep.season && existing.seasonPosters?.[`s${rep.season}`]
        ? existing.seasonPosters[`s${rep.season}`] : '',
    } : {};

    const needsMetadata = !existing || !existing.tmdbId || !existing.imdbId ||
      !existing.poster || !existing.backdrop || !existing.description ||
      !existing.rating || !existing.genre?.length || !existing.year ||
      !existing.duration || (isSer && !existing.totalSeasons) ||
      (rep.season && !existing.seasonPosters?.[`s${rep.season}`]);

    if (cleanTitle && needsMetadata) {
      const tmdb = await searchTMDB(
        rep.rawTitle || rep.title || cleanTitle, rep.year, isSer, rep.season, group.msgDate,
        rep.imdbId || null, rep.tmdbIdHint || null
      );
      if (tmdb) {
        // Keep existing catalogue values; fill missing fields from the shared
        // 14-algorithm TMDB matcher (including direct IMDb/TMDB-ID matches).
        for (const [key, value] of Object.entries(tmdb)) {
          const current = meta[key];
          const missing = current == null || current === '' || current === 0 ||
            (Array.isArray(current) && current.length === 0);
          if (missing && value != null && value !== '') meta[key] = value;
        }
      }

      // OMDb supplies IMDb ID, rating, plot, runtime and poster fallback.
      const omdb = await searchOMDB(rep.title, rep.year, isSer);
      if (omdb) {
        for (const key of ['imdbId', 'description', 'duration', 'rating', 'year', 'title', 'type']) {
          if (!meta[key] && omdb[key]) meta[key] = omdb[key];
        }
        if ((!meta.genre || !meta.genre.length) && omdb.genre?.length) meta.genre = omdb.genre;
        if (omdb.poster && omdb.poster !== meta.poster && !meta.posterFallback) {
          meta.posterFallback = omdb.poster;
        }
        if (!meta.tmdbId) meta.tmdbId = '';
      }

      // Validate primary poster; then try OMDb and Google Images as fallbacks.
      if (meta.poster) {
        const validPoster = await validatePoster(meta.poster);
        if (!validPoster) meta.poster = '';
      }
      if (!meta.poster && meta.posterFallback) {
        const validFallback = await validatePoster(meta.posterFallback);
        if (validFallback) {
          meta.poster = validFallback;
          meta.posterFallback = '';
        } else {
          meta.posterFallback = '';
        }
      }
      if (!meta.poster) {
        const gImg = await searchGoogleImage(rep.title, rep.year, isSer);
        if (gImg) {
          meta.poster = gImg;
          _emitter(`[IMG] Google image used for: ${rep.title}`);
        }
      }
    }

    if (!meta.title) {
      if (!cleanTitle) { noMeta += group.items.length; return; }
      meta = { title: cleanTitle, year: rep.year || null, type: isSer ? 'series' : 'movie', tmdbId: '', imdbId: '', poster: '', backdrop: '', rating: 0, description: '', genre: [], duration: '' };
      _emitter(`[WARN]  No TMDB — raw title: "${meta.title}"`);
    }

    // Carry Telegram-extracted CBFC/runtime/IMAX data even when TMDB/OMDb omit it.
    if (!meta.certification && rep.certification) meta.certification = rep.certification;
    if (!meta.runtimeMinutes && rep.runtimeMinutes) meta.runtimeMinutes = rep.runtimeMinutes;
    if (!meta.duration && rep.duration) meta.duration = rep.duration;
    if (!meta.aspectRatio && rep.aspectRatio) meta.aspectRatio = rep.aspectRatio;
    if (!meta.isIMAX && rep.isIMAX) meta.isIMAX = true;
    if (!meta.languageType && rep.languageType) meta.languageType = rep.languageType;

    // Preserve an IMDb ID explicitly parsed from Telegram even when OMDb is not configured.
    if (!meta.imdbId && rep.imdbId) meta.imdbId = rep.imdbId;

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
      // KEY FIX: use bypassedUrl for shortlinks, direct url otherwise.
      // DEDUP FIX: if bypass produced a *different* URL, only store the bypassed URL —
      // never store both the shortlink AND the direct URL as separate entries.
      let finalUrl = item.bypassedUrl || item.url;
      finalUrl = finalUrl.replace(/^http:\/\//i, 'https://').replace(/\/$/, '');
      finalUrl = normalizeUrl(finalUrl);  // Canonicalize GDFlix → gdflix.dev, HubCloud → hubcloud.one
      const host = detectHost(finalUrl);

      // If we skipped the bypasser, do NOT insert unresolved shortlinks!
      if (host === 'Shortlink' && !item.bypassedUrl) {
        skipped++;
        continue;
      }
      const filename = item.filename || '';
      const fileTags = extractSeasonEpisode(filename);
      const quality  = item.quality || normalizeQuality(filename) || 'HD';
      const size     = item.size || extractSize(filename) || '';
      const language = item.language || detectAllLanguages(filename).join(', ') || '';
      const codec    = item.codec || detectCodec(filename) || 'Other';
      const hdr      = item.hdr || detectHDR(filename) || null;
      const audio    = item.audio || extractAudio(filename) || null;
      const source   = item.source || detectSource(filename) || null;
      const container = item.container || detectContainer(filename) || null;
      const bitDepth = item.bitDepth || detectBitDepth(filename) || null;
      const audioChannels = item.audioChannels || detectAudioChannels(filename) || null;
      const parsedFileMetadata = extractMediaMetadata([filename, item.rawTitle || ''].filter(Boolean).join(' '));
      const isRepack = !!item.isRepack || /repack|rerip/i.test(String(item.releaseType || '')) || parsedFileMetadata.isRepack;
      const releaseType = isRepack ? 'Repack' : (item.releaseType || parsedFileMetadata.releaseType || 'Original');
      const isIMAX = !!item.isIMAX || parsedFileMetadata.isIMAX;
      const aspectRatio = item.aspectRatio || parsedFileMetadata.aspectRatio || rep.aspectRatio || '';
      const languageInfo = classifyLanguages(item.language || detectAllLanguages(filename), filename);
      const languageType = item.languageType || languageInfo.languageType;
      const languageCount = item.languageCount ?? languageInfo.languageCount;
      const correctSeason = seasonFromFilename(filename) ?? item.season ?? fileTags.season ?? null;
      const correctEpisode = item.episode ?? fileTags.episode ?? null;

      let dbRec = existing;
      // Re-check by tmdbId in case meta search found a different record than initial lookup
      if (!dbRec && meta.tmdbId) dbRec = await Movie.findOne({ tmdbId: String(meta.tmdbId) });
      // Last resort: title+year again (in case race condition between items in same group)
      if (!dbRec && cleanTitle && rep.year) dbRec = await Movie.findOne({ title: { $regex: `^${esc}$`, $options: 'i' }, year: rep.year });
      if (!dbRec && cleanTitle) dbRec = await Movie.findOne({ title: { $regex: `^${esc}$`, $options: 'i' } });

      const newDl = {
        quality, size, filename, language, codec, hdr, audio, source, container, bitDepth, audioChannels,
        isRepack, releaseType, isIMAX, aspectRatio, languageType, languageCount,
        sourceDate: item.date || '',
        season: correctSeason, episode: correctEpisode,
        links: [{ host, url: finalUrl, isFast: /gdflix|hubcloud|gdlink|tmbcloud/i.test(finalUrl) }],
      };

      if (dbRec) {
        if (dbRec.downloads?.some(d => d.links?.some(l => l.url === finalUrl))) { skipped++; continue; }
        const newMB = toMB(size);
        let matchedIdx = -1;
        for (let j = 0; j < dbRec.downloads.length; j++) {
          const ex = dbRec.downloads[j];

          // Series/anime: season+episode must match
          const seasOk = (finalType === 'series' || finalType === 'anime')
            ? (ex.season == correctSeason && ex.episode == correctEpisode)
            : true;
          if (!seasOk) continue;

          // Never merge a repack with its older main/original release. They remain
          // separate download rows, and the display ranking puts repacks first.
          if (!!ex.isRepack !== !!newDl.isRepack) continue;

          // TIER 1 — Filename match: same .mkv/.mp4 name = definitely same file
          const exFn  = (ex.filename  || '').trim().toLowerCase();
          const newFn = filename.trim().toLowerCase();
          if (exFn && newFn && exFn === newFn) {
            matchedIdx = j; break;
          }

          const qualOk  = ex.quality === quality;
          const exMB    = toMB(ex.size);
          const bothKnown = newMB > 0 && exMB > 0;
          const pct       = bothKnown ? Math.abs(newMB - exMB) / Math.max(newMB, exMB) : 1;
          // Within 5%: definitely the same encode (was 3%, loosened further)
          const sizeClose = bothKnown && pct < 0.05;
          const exCodec   = (ex.codec || '').toLowerCase().trim();
          const newCodec  = (codec    || '').toLowerCase().trim();
          const codecOk   = !exCodec || !newCodec || exCodec === newCodec;

          // TIER 2 — Quality + size + codec: same quality, size within 5%, same codec
          if (qualOk && sizeClose && codecOk) {
            matchedIdx = j;
            if (language && language !== 'Multi' && (!ex.language || ex.language === 'Multi')) {
              ex.language = language;
            }
            break;
          }

          // TIER 3 — Quality + language + both sizes unknown + filename prefix matches
          // Requires 60%+ filename similarity so we don't collapse two different no-size rips
          const langNorm    = (s) => (s||'').toLowerCase().replace(/\s+/g,'');
          const langOk      = langNorm(ex.language) === langNorm(language);
          const bothUnknown = !size && !ex.size;
          const fnPrefixOk  = (() => {
            if (!exFn || !newFn) return false;
            const shorter = Math.min(exFn.length, newFn.length);
            if (shorter < 6) return false;
            // Count matching leading characters
            let common = 0;
            while (common < shorter && exFn[common] === newFn[common]) common++;
            return common / shorter >= 0.6;
          })();
          if (qualOk && langOk && bothUnknown && fnPrefixOk) {
            matchedIdx = j; break;
          }

          // TIER 4 — Quality + host + size bucket: same quality, same host, same size bracket
          // "Same size bracket" = both sizes unknown OR sizes within 5%.
          // This prevents 1080p GDFlix and 720p GDFlix from being collapsed.
          // Also prevents two DIFFERENT 1080p GDFlix rips with different sizes from collapsing.
          const exHostsInGroup = (ex.links || []).map(l => detectHost(l.url));
          const hostMatch = qualOk && exHostsInGroup.includes(host);
          const sizeBracketOk = bothKnown ? sizeClose : (!size && !ex.size);
          if (hostMatch && sizeBracketOk) {
            matchedIdx = j; break;
          }
        }
        const metaSet = {};
        if (!dbRec.backdrop       && meta.backdrop)       metaSet.backdrop       = meta.backdrop;
        if (!dbRec.poster         && meta.poster)         metaSet.poster         = meta.poster;
        if (!dbRec.posterFallback && meta.posterFallback) metaSet.posterFallback = meta.posterFallback;
        if (!dbRec.tmdbId         && meta.tmdbId)         metaSet.tmdbId         = meta.tmdbId;
        if (!dbRec.imdbId         && meta.imdbId)         metaSet.imdbId         = meta.imdbId;
        if (!dbRec.rating         && meta.rating)         metaSet.rating         = meta.rating;
        if (!dbRec.description    && meta.description)    metaSet.description    = meta.description;
        if (!dbRec.year && meta.year) metaSet.year = meta.year;
        if (!dbRec.duration && (meta.duration || item.duration || rep.duration)) metaSet.duration = meta.duration || item.duration || rep.duration;
        if (!dbRec.runtimeMinutes && (meta.runtimeMinutes || item.runtimeMinutes || rep.runtimeMinutes)) metaSet.runtimeMinutes = meta.runtimeMinutes || item.runtimeMinutes || rep.runtimeMinutes;
        if (!dbRec.certification && (meta.certification || item.certification || rep.certification)) metaSet.certification = meta.certification || item.certification || rep.certification;
        if (!dbRec.isIMAX && (meta.isIMAX || item.isIMAX)) metaSet.isIMAX = true;
        if (!dbRec.aspectRatio && (meta.aspectRatio || item.aspectRatio || rep.aspectRatio)) metaSet.aspectRatio = meta.aspectRatio || item.aspectRatio || rep.aspectRatio;
        if (!dbRec.languageType && (meta.languageType || item.languageType || rep.languageType)) metaSet.languageType = meta.languageType || item.languageType || rep.languageType;
        if (!dbRec.totalSeasons && meta.totalSeasons) metaSet.totalSeasons = meta.totalSeasons;
        if ((!dbRec.genre || !dbRec.genre.length) && meta.genre?.length) metaSet.genre = meta.genre;
        if (dbRec.type !== finalType) metaSet.type = finalType;
        if (rep.season && meta.seasonPoster && !dbRec.seasonPosters?.[`s${rep.season}`]) {
          metaSet[`seasonPosters.s${rep.season}`] = meta.seasonPoster;
        }

        if (matchedIdx >= 0) {
          const matchedDownload = dbRec.downloads[matchedIdx] || {};
          for (const field of ['source', 'container', 'bitDepth', 'audioChannels', 'codec', 'hdr', 'audio', 'filename', 'isIMAX', 'aspectRatio', 'languageType', 'languageCount', 'releaseType', 'sourceDate']) {
            if (!matchedDownload[field] && newDl[field]) {
              metaSet[`downloads.${matchedIdx}.${field}`] = newDl[field];
            }
          }
          if (dbRec.downloads[matchedIdx].language) {
              metaSet[`downloads.${matchedIdx}.language`] = dbRec.downloads[matchedIdx].language;
          }
          const existLinks = dbRec.downloads[matchedIdx]?.links || [];
          // Skip: exact same URL already stored
          if (existLinks.some(l => l.url === finalUrl)) { skipped++; continue; }
          // Skip: same host already in this group AND sizes also match (true duplicate mirror).
          // If sizes differ, the new link is a different rip from the same host — keep it.
          const sameHostInGroup = existLinks.some(l => detectHost(l.url) === host);
          const sizesMatchExisting = existLinks.some(l => {
            const lMB = toMB(dbRec.downloads[matchedIdx]?.size);
            return detectHost(l.url) === host && bothKnownCheck(newMB, lMB);
          });
          function bothKnownCheck(a, b) {
            if (a <= 0 || b <= 0) return false;
            return Math.abs(a - b) / Math.max(a, b) < 0.05;
          }
          if (sameHostInGroup && sizesMatchExisting) { skipped++; continue; }
          // Cap: max 8 links per individual quality group
          if (existLinks.length >= 8) { skipped++; continue; }
          // Cap: max 30 total links per content
          const totalLinksInContent = dbRec.downloads.reduce((sum, d) => sum + (d.links?.length || 0), 0);
          if (totalLinksInContent >= 30) { skipped++; continue; }

          const op = { $addToSet: { [`downloads.${matchedIdx}.links`]: newDl.links[0] } };
          if (Object.keys(metaSet).length) op.$set = metaSet;
          const res = await Movie.findOneAndUpdate({ _id: dbRec._id, [`downloads.${matchedIdx}.links.url`]: { $ne: finalUrl } }, op, { new: true });
          if (res) {
            recomputeAggregates(res);
            // ACTUALLY save the sorted downloads array + aggregates back to DB
            existing = await Movie.findByIdAndUpdate(dbRec._id, {
              $set: {
                downloads: res.downloads,
                formats: res.formats, quality: res.quality,
                languages: res.languages, language: res.language, codecs: res.codecs, languageType: res.languageType,
              }
            }, { new: true });
            _emitter(`[MERGED] ${dbRec.title} | ${quality} -> ${host}`);
            updated++;
          } else skipped++;
        } else {
          // New download group — cap at 30 total links per content
          const totalLinksInContent2 = dbRec.downloads.reduce((sum, d) => sum + (d.links?.length || 0), 0);
          if (totalLinksInContent2 >= 30) { skipped++; continue; }
          const op = { $push: { downloads: newDl } };
          if (Object.keys(metaSet).length) op.$set = metaSet;
          const res = await Movie.findByIdAndUpdate(dbRec._id, op, { new: true });
          if (res) {
            recomputeAggregates(res);
            // ACTUALLY save the sorted downloads array + aggregates back to DB
            existing = await Movie.findByIdAndUpdate(dbRec._id, {
              $set: {
                downloads: res.downloads,
                formats: res.formats, quality: res.quality,
                languages: res.languages, language: res.language, codecs: res.codecs, languageType: res.languageType,
              }
            }, { new: true });
            _emitter(`[UPDATED] ${dbRec.title} | ${quality} -> ${host}`);
            updated++;
          }
        }
        continue;
      }

      try {
        // Only languages actually present in our Telegram download records belong here.
        // Do not add TMDB/OMDb original_language: it may not be available in any download.
        const allLangsSet = [...new Set(
          String(language || '').split(',')
            .map(l => l.trim())
            .filter(l => l && !/^(?:single|dual|multi)(?:\s+audio)?$/i.test(l))
        )];
        const displayLang = allLangsSet.join(', ');
        const newDoc = await Movie.create({
          title: meta.title, tmdbId: meta.tmdbId || '', imdbId: meta.imdbId || '',
          type: finalType, totalSeasons: meta.totalSeasons || 0,
          description: meta.description || '',
          poster: meta.poster || '', posterFallback: meta.posterFallback || '',
          backdrop: meta.backdrop || '',
          seasonPosters: rep.season && meta.seasonPoster
            ? { [`s${rep.season}`]: meta.seasonPoster } : {},
          rating: meta.rating || 0, year: meta.year || item.year || new Date().getFullYear(),
          genre: meta.genre || [], duration: meta.duration || item.duration || rep.duration || '',
          runtimeMinutes: meta.runtimeMinutes || item.runtimeMinutes || rep.runtimeMinutes || null,
          certification: meta.certification || item.certification || rep.certification || '',
          isIMAX: !!(meta.isIMAX || item.isIMAX), aspectRatio: meta.aspectRatio || item.aspectRatio || rep.aspectRatio || '',
          languageType: languageType || meta.languageType || '',
          quality, language: displayLang,
          formats: [quality].filter(Boolean), codecs: [codec].filter(c => c !== 'Other'),
          languages: allLangsSet,
          telegramMessageIds: item.messageId ? [item.messageId] : [],
          downloads: [newDl],
        });
        added++; existing = newDoc;
        _emitter(`[NEW] ${meta.title} (${meta.year || '?'}) | ${quality}${audio ? ' · '+audio : ''}${hdr ? ' · '+hdr : ''} -> ${host}`);
      } catch (e) {
        _emitter(`[ERR] DB error "${meta.title}": ${e.message}`);
        skipped++;
      }
    }
  }

  let gi = 0;
  const active2 = [];
  const batchDoneKeys = [];
  for (const entry of groupEntries) {
    if (isStopRequested()) { _emitter('\n[WARN] Import aborted by user stop request.'); break; }
    if (active2.length >= 2) await Promise.race(active2);
    const p = processGroup(entry).finally(() => {
      active2.splice(active2.indexOf(p), 1);
      batchDoneKeys.push(entry[0]);
      // Checkpoint: save every CHECKPOINT_EVERY groups
      if (batchDoneKeys.length % CHECKPOINT_EVERY === 0) saveCheckpoint(batchDoneKeys);
    });
    active2.push(p); gi++;
    // Emit [PROGRESS] every 25 groups so orchestrator UI can track
    if (gi % 25 === 0) _emitter(`[PROGRESS] ${gi}/${groupEntries.length}`);
    await sleep(50);
  }
  await Promise.all(active2);
  saveCheckpoint(batchDoneKeys); // final checkpoint save
  _emitter(`   Importing: ${groupEntries.length}/${groupEntries.length} — Done!`);

  _emitter(`\n  ${C.green}[+] Added   : ${added}${C.reset}`);
  _emitter(`  ${C.cyan}[~] Updated : ${updated}${C.reset}`);
  _emitter(`  ${C.gray}[-] Skipped : ${skipped}${C.reset}`);
  if (noMeta) _emitter(`  ${C.yellow}[?] No meta : ${noMeta}${C.reset}`);
  // Clean checkpoint on full success
  try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE); } catch(_) {}
  try {
    const PipelineCache = require('./models/PipelineCache');
    PipelineCache.deleteOne({ key: '_import_checkpoint' }).exec().catch(() => {});
  } catch(_) {}
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

  const FROM_MONGODB = opts.fromMongoDB !== undefined ? !!opts.fromMongoDB : _argv.includes('--from-mongodb');
  // The dedicated MongoDB importer is deliberately read-only with respect to
  // the source collection: it never wipes, scrapes, bypasses, or runs the healer.
  const NO_WIPE     = FROM_MONGODB ? true : (opts.noWipe !== undefined ? opts.noWipe : _argv.includes('--no-wipe'));
  const NO_HEAL     = FROM_MONGODB ? true : (opts.noHeal !== undefined ? opts.noHeal : _argv.includes('--no-heal'));
  const NO_BYPASS   = FROM_MONGODB ? true : (opts.noBypass !== undefined ? opts.noBypass : _argv.includes('--no-bypass'));
  const RESUME      = opts.resume     !== undefined ? opts.resume     : _argv.includes('--resume');
  const CONCURRENCY = opts.concurrency || parseInt((_argv.find(a => a.startsWith('--concurrency=')) || '').replace('--concurrency=', '') || '3', 10);
  const IMPORT_SRC  = opts.importSrc  || (_argv.find(a => a.startsWith('--import-source=')) || '').replace('--import-source=', '') || null;
  const IS_STOP_REQUESTED = opts.isStopRequested || (() => false);

  if (FROM_MONGODB && IMPORT_SRC) {
    throw new Error('--from-mongodb cannot be combined with --import-source; choose one source.');
  }

  const t0 = Date.now();
  log(FROM_MONGODB ? 'XLOOP ─ DIRECT MONGODB IMPORT' : 'XLOOP ─ UNIFIED BYPASS + IMPORT PIPELINE');

  if (!TMDB_KEY) warn('TMDB_API_KEY not set — posters will be blank!');
  if (!process.env.MONGODB_URI) warn('MONGODB_URI not set — defaulting to localhost');

  // STEP 0.5: MongoDB connect (must happen BEFORE Wipe and Extract)
  sep();
  log('Connecting to MongoDB...');
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
  if (mongoose.connection.readyState === 1) {
    mongoConnected = true;
    ok('MongoDB already connected');
  } else {
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
  }

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

  // STEP 1: Extract / load existing source
  sep();
  if (FROM_MONGODB) {
    log('STEP 1 — Reading existing approved links directly from MongoDB ExtractedLink...');
    try {
      const ExtractedLink = require('./models/ExtractedLink');
      const PipelineCache = require('./models/PipelineCache');
      const { isAllowedTelegramDownloadUrl } = require('./utils/telegram-ingestion');
      const storedLinks = await ExtractedLink.find({}).lean();
      if (!storedLinks.length) {
        fail('MongoDB ExtractedLink collection is empty. Nothing to import.');
        throw new Error('No extracted links found in MongoDB');
      }

      const approvedLinks = storedLinks.filter((entry) =>
        isAllowedTelegramDownloadUrl(entry && entry.url)
      );
      const rejectedCount = storedLinks.length - approvedLinks.length;
      if (!approvedLinks.length) {
        fail('No approved GDFlix, HubCloud or TMBCloud links found in MongoDB. Existing catalogue was preserved.');
        throw new Error('No approved provider links found in MongoDB');
      }

      const clean = approvedLinks.map(({ _id, __v, uploadBatch, createdAt, updatedAt, ...rest }) => rest);
      // Force-refresh the local working file from MongoDB; never trust an older
      // links_for_bypasser.json, telegram_export.json, or shortlinks report.
      fs.writeFileSync(LINKS_FILE, JSON.stringify(clean));
      ok(`Loaded ${clean.length} approved links directly from MongoDB (rejected ${rejectedCount} unsupported links).`);
      await PipelineCache.findOneAndUpdate(
        { key: 'extracted_links' },
        { $set: { count: storedLinks.length, 'data.count': storedLinks.length } },
        { upsert: false }
      );
    } catch (err) {
      if (/No extracted links found|No approved provider links/.test(err.message)) throw err;
      fail(`MongoDB import source read failed: ${err.message}`);
      throw err;
    }
  } else if (!IMPORT_SRC) {
    // Check if already-extracted links are in /tmp (same Lambda invocation as upload)
    if (fs.existsSync(LINKS_FILE)) {
      warn('STEP 1 — Using pre-extracted links_for_bypasser.json from /tmp');
    } else {
      log('STEP 1 — Checking MongoDB for pre-extracted links...');
      try {
        const ExtractedLink = require('./models/ExtractedLink');
        const PipelineCache = require('./models/PipelineCache');
        const linkCount = await ExtractedLink.countDocuments({});
        if (linkCount > 0) {
          // Load all links from ExtractedLink collection (saved by scrape-and-upload.js)
          const links = await ExtractedLink.find({}).lean();
          const clean = links.map(({ _id, __v, uploadBatch, createdAt, updatedAt, ...rest }) => rest);
          fs.writeFileSync(LINKS_FILE, JSON.stringify(clean));
          ok(`Loaded ${clean.length} pre-extracted links from MongoDB — skipping extraction step.`);
          // Re-sync the PipelineCache count in case it was reset by wipe
          await PipelineCache.findOneAndUpdate(
            { key: 'extracted_links' },
            { $set: { count: clean.length, 'data.count': clean.length } },
            { upsert: false }
          );
        } else if (fs.existsSync(EXPORT_FILE)) {
          // No DB links — parse raw export from local filesystem (local dev mode)
          log('STEP 1 — Parsing telegram_export.json (inline)...');
          const { parseMessageBlock, classifyUrl } = require('./utils/parser');
          const rawExport = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
          const messages  = Array.isArray(rawExport) ? rawExport
            : (rawExport.messages || rawExport.data || []);
          const extracted = [];
          let msgIdx = 0;
          for (const msg of messages) {
            msgIdx++;
            const text = (typeof msg === 'string') ? msg
              : [msg.text, msg.caption, msg.message].filter(Boolean).join('\n');
            if (!text || text.length < 10) continue;
            try {
              const parsed = parseMessageBlock(text);
              if (!parsed || !parsed.downloads) continue;
              for (const dl of parsed.downloads) {
                for (const link of (dl.links || [])) {
                  if (!link.url) continue;
                  extracted.push({
                    url: link.url, host: link.host || classifyUrl(link.url),
                    title: parsed.title, year: parsed.year,
                    quality: dl.quality, size: dl.size, language: dl.language,
                    season: dl.season ?? null, episode: dl.episode ?? null,
                    type: parsed.type, contentType: parsed.contentType, isSeries: !!parsed.isSeries,
                    rawTitle: parsed.rawTitle || parsed.title, filename: dl.filename,
                    codec: dl.codec, hdr: dl.hdr, audio: dl.audio,
                    source: dl.source, container: dl.container,
                    bitDepth: dl.bitDepth, audioChannels: dl.audioChannels,
                    isRepack: !!dl.isRepack || (parsed.downloads.length === 1 && !!parsed.isRepack),
                    releaseType: dl.releaseType || (parsed.downloads.length === 1 ? parsed.releaseType : '') || 'Original',
                    isIMAX: !!dl.isIMAX || !!parsed.isIMAX,
                    aspectRatio: dl.aspectRatio || parsed.aspectRatio || '',
                    languageType: dl.languageType || parsed.languageType || '',
                    languageCount: dl.languageCount ?? parsed.languageCount ?? 0,
                    runtimeMinutes: parsed.runtimeMinutes ?? null, duration: parsed.duration || '',
                    certification: parsed.certification || '',
                    imdbId: parsed.imdbId || null, tmdbIdHint: parsed.tmdbIdHint || null,
                    messageId: msg.id || null, date: msg.date || msg.date_unixtime || null,
                  });
                }
              }
            } catch (_) { /* skip unparseable blocks */ }
            if (msgIdx % 5000 === 0) log(`  Parsed ${msgIdx}/${messages.length} messages, ${extracted.length} links so far...`);
          }
          fs.writeFileSync(LINKS_FILE, JSON.stringify(extracted));
          ok(`Extraction done — ${extracted.length} links from ${messages.length} messages → links_for_bypasser.json`);
        } else {
          // Try loading raw export from MongoDB PipelineCache
          const cached = await PipelineCache.findOne({ key: 'telegram_export' }).lean();
          if (cached && cached.data) {
            fs.writeFileSync(EXPORT_FILE, JSON.stringify(cached.data));
            log('STEP 1 — Loaded telegram_export.json from MongoDB cache. Re-run to parse.');
            fail('telegram_export.json restored from cache but no pre-extracted links found. Upload your export via scrape-and-upload.js first.');
            throw new Error('No export data found');
          } else {
            fail('No extracted links or telegram_export.json found. Run scrape-and-upload.js first.');
            throw new Error('No export data found');
          }
        }
      } catch (err) {
        if (err.message === 'No export data found') throw err;
        fail(`Pipeline step 1 failed: ${err.message}`);
        throw err;
      }
    }

  } else {
    warn(`STEP 1 — Using existing file: ${IMPORT_SRC}`);
  }
  // Merge all entries (direct + shortlinks from separate file)
  const sourceFile = IMPORT_SRC || LINKS_FILE;
  if (!fs.existsSync(sourceFile)) { fail(`Source file not found: ${sourceFile}`); throw new Error(`Source file not found: ${sourceFile}`); }
  let allEntries = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

  // Pull in shortlinks from shortlinks_report.json
  if (!IMPORT_SRC && !FROM_MONGODB && fs.existsSync(SHORTLINKS_FILE)) {
    const shortlinkData = JSON.parse(fs.readFileSync(SHORTLINKS_FILE, 'utf8'));
    if (shortlinkData.length > 0) {
      log(`Merging ${shortlinkData.length} shortlinks from shortlinks_report.json`);
      const existingUrls = new Set(allEntries.map(e => e.url));
      allEntries = [...allEntries, ...shortlinkData.filter(e => !existingUrls.has(e.url))];
    }
  }

  const existingBypassed = !FROM_MONGODB && fs.existsSync(BYPASSED_FILE) ? JSON.parse(fs.readFileSync(BYPASSED_FILE, 'utf8')) : [];

  log(`Total entries: ${allEntries.length} | Direct: ${allEntries.filter(e => e.host !== 'Shortlink').length} | Shortlinks: ${allEntries.filter(e => e.host === 'Shortlink').length} | Prev bypassed: ${existingBypassed.length}`);

  // STEP 2: Bypass
  sep();
  if (FROM_MONGODB) log('MongoDB-only import mode: scraper, uploader, bypasser, and healer are disabled.');
  if (!NO_BYPASS) {
    log(`STEP 2 — Bypassing shortlinks (concurrency=${CONCURRENCY})...`);
    await phaseBypass(allEntries, existingBypassed, CONCURRENCY, IS_STOP_REQUESTED);
    ok('Bypass phase complete');
  } else {
    warn('STEP 2 — Bypass skipped (--no-bypass)');
    const bmap = new Map(existingBypassed.map(e => [e.url, e.bypassedUrl]));
    for (const e of allEntries) { if (!e.bypassedUrl && bmap.has(e.url)) e.bypassedUrl = bmap.get(e.url); }
  }

  // STEP 3: Legacy DB Connection Step (Moved to top)
  sep();
  log('STEP 3 — MongoDB connection verified.');

  // STEP 4: Import
  sep();
  log('STEP 4 — Importing all entries → MongoDB...');

  // Save metadata to PipelineCache so Skip Scraper knows data is available.
  // NOTE: do NOT save data:allEntries — 47k+ entries would exceed MongoDB's 16MB doc limit.
  // The actual links are stored in the ExtractedLink collection (one doc per link).
  try {
    const PipelineCache = require('./models/PipelineCache');
    await PipelineCache.findOneAndUpdate(
      { key: 'bypassed_links' },
      { key: 'bypassed_links', data: { count: allEntries.length }, count: allEntries.length, savedAt: new Date() },
      { upsert: true, new: true }
    );
    log(`[SAVE] Saved ${allEntries.length} entries metadata to MongoDB cache (for Skip Scraper)`);
  } catch (cacheErr) {
    warn(`Cache save failed (non-fatal): ${cacheErr.message}`);
  }

  await phaseImport(allEntries, RESUME, IS_STOP_REQUESTED);
  ok('Import complete');
  try { await mongoose.disconnect(); } catch(_) {}

  // STEP 5: Heal
  sep();
  if (!NO_HEAL && !IS_STOP_REQUESTED()) {
    log('STEP 5 — Healing remaining metadata gaps...');
    await runScript(path.join(ROOT, 'heal_db.js'));
    ok('Healing complete');
  } else {
    warn('STEP 5 — Skipping healer (--no-heal)');
  }

  sep();
  const s = Math.round((Date.now() - t0) / 1000);
  ok(`[DONE] Pipeline complete in ${Math.floor(s/60)}m ${s%60}s`);
}

// ── When run directly from CLI ────────────────────────────────────────────────
if (IS_MAIN) {
  main().catch(e => { fail(`Pipeline failed: ${e.message}`); process.exit(1); });
}

// ── When require()'d by orchestrator route ────────────────────────────────────
module.exports = { runPipeline: main, searchTMDB, searchOMDB, searchGoogleImage, fetchWithRetry, toMB, detectCodecLocal, seasonFromFilename, recomputeAggregates };// ═════════════════════════════════════════════════════════════════════════
// TMDB SEARCH  —  Multi-Algorithm Title-Candidate Cascade
// ═════════════════════════════════════════════════════════════════════════
// Each of the 12 algorithms produces a different title variant.
// TMDB is tried with each variant in order until a confident match is found.
// Phase 1 = strict thresholds. Phase 2 = relaxed thresholds (same candidates).
// ═════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────
// Shared 14-algorithm metadata engine. Includes TMDB/IMDb ID fast paths,
// confidence scoring, relaxed title candidates, and season poster lookup.
// ─────────────────────────────────────────────────────────────────────────
async function searchTMDB(title, year, isSeries, season, msgDate, imdbId, tmdbIdHint) {
  if (!TMDB_KEY) return null;
  return sharedMetadataSearch.searchTMDB(
    title, year, isSeries, season, msgDate, imdbId, tmdbIdHint,
    { tmdbKey: TMDB_KEY, emitter: _emitter }
  );
}
