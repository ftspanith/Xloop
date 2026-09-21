// ═══════════════════════════════════════════════════════════════════════════
// import_bypassed.js
// Reads bypassed_links.json and intelligently upserts each link into MongoDB.
//
// Features:
//  - Uses utils/parser.js for clean metadata
//  - Fetches TMDB with short-title fallback strategy
//  - Season-specific poster fetching for TV series
//  - Smart deduplication by tmdbId → title → fuzzy
//
// Run: node import_bypassed.js
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const fs       = require('fs');
const axios    = require('axios');
const Movie    = require('./models/Movie');
const { cleanTitleForApi, detectHost } = require('./utils/parser');

const path = require('path');
const isVercel = !!process.env.VERCEL;
const getPath = (file) => isVercel ? path.join('/tmp', file) : path.join(__dirname, file);

const BYPASSED_FILE = getPath('bypassed_links.json');
const TMDB_KEY      = process.env.TMDB_API_KEY || '';
const OMDB_KEY      = process.env.OMDB_API_KEY  || '';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Per-document mutex to prevent concurrent VersionError on same _id ─────────
const docLocks = new Map();
async function withDocLock(id, fn) {
  const key = String(id);
  while (docLocks.has(key)) { await docLocks.get(key); }
  let resolve;
  const lock = new Promise(r => { resolve = r; });
  docLocks.set(key, lock);
  try { return await fn(); } finally { docLocks.delete(key); resolve(); }
}

// ── Save with optimistic retry on VersionError ────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function stringSimilarity(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (a === b) return 1;
  const longer  = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (!longer.length) return 1;
  return (longer.length - levenshtein(longer, shorter)) / longer.length;
}

function detectCodec(filename) {
  const str = (filename || '').toLowerCase();
  if (/\bav1\b/i.test(str)) return 'AV1';
  if (/hevc|h\.265|x265/i.test(str)) return 'HEVC';
  return 'Other';
}

function toMB(s) {
  if (!s) return 0;
  const n = parseFloat(s);
  return /GB/i.test(s) ? n * 1024 : (n || 0);
}

// ─── TMDB SHORT-TITLE AWARE SEARCH ───────────────────────────────────────────
// Strategy: try with year first, then without. For very short titles (<= 4 chars),
// also try appending season/year as extra context to narrow results.
async function searchTMDB(title, year, isSeries, season) {
  if (!TMDB_KEY) return null;

  const cleanTitle = cleanTitleForApi(title);
  const type       = isSeries ? 'tv' : 'movie';
  const isShort    = cleanTitle.trim().split(' ').length <= 2; // ≤2 words = short title

  const attempts = [
    // 1. Exact search with year
    ...(year ? [{ query: cleanTitle, year }] : []),
    // 2. Without year
    { query: cleanTitle },
    // 3. For short titles: try appending the year to the query string
    ...(isShort && year ? [{ query: `${cleanTitle} ${year}` }] : []),
  ];

  for (const params of attempts) {
    try {
      const res = await axios.get('https://api.themoviedb.org/3/search/multi', {
        params: { api_key: TMDB_KEY, ...params },
        timeout: 10000,
      });
      let results = (res.data.results || []).filter(r =>
        r.media_type === 'movie' || r.media_type === 'tv'
      );

      if (results.length === 0) continue;

      // Score & rank
      const scored = results.slice(0, 8).map(r => {
        const rTitle = r.title || r.name || '';
        const rYear  = r.release_date
          ? parseInt(r.release_date, 10)
          : r.first_air_date
          ? parseInt(r.first_air_date, 10)
          : null;
        const rType  = r.media_type === 'tv' ? 'series' : 'movie';

        let score = stringSimilarity(cleanTitleForApi(rTitle), cleanTitle) * 50;

        // Year scoring
        if (year && rYear) {
          const diff = Math.abs(year - rYear);
          if (diff === 0)      score += 30;
          else if (diff === 1) score += 15;
          else if (diff <= 2)  score += 5;
          else                 score -= 15;
        } else {
          score += 8;
        }

        // Type scoring
        const parsedType = isSeries ? 'series' : 'movie';
        if (parsedType === rType) score += 20; else score -= 20;

        return { r, score, rTitle, rYear };
      });

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];

      // Minimum confidence thresholds — stricter for short titles to avoid false matches
      const minScore      = isShort ? 65 : 50;
      const titleSim      = stringSimilarity(cleanTitleForApi(best.rTitle), cleanTitle);
      const minTitleSim   = isShort ? 0.7 : 0.45;

      if (best.score < minScore || titleSim < minTitleSim) continue;

      // Fetch full details
      const isTv = best.r.media_type === 'tv';
      const detailRes = await axios.get(
        `https://api.themoviedb.org/3/${isTv ? 'tv' : 'movie'}/${best.r.id}`,
        { params: { api_key: TMDB_KEY }, timeout: 10000 }
      );
      const d = detailRes.data;

      // Fetch season-specific poster if this is a series with a known season
      let seasonPoster   = '';
      let seasonOverview = '';
      if (isTv && season) {
        try {
          const seasonRes = await axios.get(
            `https://api.themoviedb.org/3/tv/${best.r.id}/season/${season}`,
            { params: { api_key: TMDB_KEY }, timeout: 8000 }
          );
          if (seasonRes.data.poster_path) {
            seasonPoster = `https://image.tmdb.org/t/p/w500${seasonRes.data.poster_path}`;
          }
          if (seasonRes.data.overview) {
            seasonOverview = seasonRes.data.overview;
          }
        } catch (_) { /* season poster not critical */ }
      }

      return {
        tmdbId:        String(d.id),
        type:          isTv ? 'series' : 'movie',
        totalSeasons:  d.number_of_seasons || 0,
        title:         d.title || d.name || title,
        description:   seasonOverview || d.overview || '',
        // Use season-specific poster if available, else fall back to show poster
        poster:        seasonPoster || (d.poster_path   ? `https://image.tmdb.org/t/p/w500${d.poster_path}`   : ''),
        backdrop:      d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
        rating:        Math.round((d.vote_average || 0) * 10) / 10,
        year:          d.release_date
          ? parseInt(d.release_date, 10)
          : d.first_air_date
          ? parseInt(d.first_air_date, 10)
          : year,
        genre:         (d.genres || []).map(g => g.name),
        duration:      d.runtime
          ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m`
          : (d.episode_run_time?.[0]
            ? `${Math.floor(d.episode_run_time[0] / 60)}h ${d.episode_run_time[0] % 60}m`
            : ''),
        originalLanguage: (() => {
          const m = {
            'en': 'English', 'te': 'Telugu', 'ta': 'Tamil', 'hi': 'Hindi', 
            'ml': 'Malayalam', 'kn': 'Kannada', 'ja': 'Japanese', 'ko': 'Korean',
            'fr': 'French', 'es': 'Spanish', 'de': 'German', 'it': 'Italian',
            'zh': 'Chinese', 'ru': 'Russian', 'pt': 'Portuguese'
          };
          return m[d.original_language] || d.original_language;
        })(),
        confidence:    Math.round(best.score),
      };
    } catch (_) { await sleep(500); }
  }
  return null;
}

// ─── OMDB FALLBACK ────────────────────────────────────────────────────────────
async function searchOMDB(title, year, isSeries) {
  if (!OMDB_KEY) return null;
  try {
    const params = { t: cleanTitleForApi(title), apikey: OMDB_KEY, type: isSeries ? 'series' : 'movie', plot: 'short' };
    if (year) params.y = year;
    const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 8000 });
    const d   = res.data;
    if (!d || d.Response === 'False') return null;
    const m = d.Runtime ? parseInt(d.Runtime) : null;
    return {
      title:       d.Title  || title,
      description: d.Plot   !== 'N/A' ? d.Plot   : '',
      poster:      d.Poster !== 'N/A' ? d.Poster : '',
      rating:      d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0,
      year:        d.Year ? parseInt(d.Year, 10) : year,
      genre:       d.Genre !== 'N/A' ? d.Genre.split(', ') : [],
      duration:    m ? `${Math.floor(m/60)}h ${m%60}m` : '',
      imdbId:      d.imdbID || '',
    };
  } catch (_) { return null; }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function detectCodecLocal(filename) {
  const s = (filename || '').toUpperCase();
  if (/\bAV1\b/.test(s))               return 'AV1';
  if (/HEVC|H\.265|X265/.test(s))      return 'HEVC';
  // H.264 is the default codec — not worth showing as a badge
  return 'Other';
}

// Extract season from filename: Stranger.Things.S04.zip → 4
function seasonFromFilename(fn) {
  if (!fn) return null;
  const m = fn.match(/[._\s-]S(\d{1,2})[._\s\[\.-]/i) || fn.match(/\bS(\d{1,2})\b(?!\d)/i) || fn.match(/Season[\s._]?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(BYPASSED_FILE)) {
    console.error('❌  No bypassed_links.json found! Run the bypasser first.');
    process.exit(1);
  }

  const all   = JSON.parse(fs.readFileSync(BYPASSED_FILE, 'utf8'));
  const valid = all.filter(b => b.bypassedUrl || b.url);

  console.log(`\n📦 Total entries : ${all.length}`);
  console.log(`✅ Valid links   : ${valid.length}\n`);

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop');
  console.log('🗄️  MongoDB connected\n');

  let added = 0, updated = 0, skipped = 0, noMeta = 0, upgraded = 0;

  // ── Group by (title + year) for TMDB API efficiency ──────────────────────
  // Same title from multiple channels → one TMDB call, all links merged
  const groups = {};
  for (const item of valid) {
    const key = `${(item.title || '').toLowerCase().trim()}__${item.year || ''}`;
    if (!groups[key]) groups[key] = { items: [] };
    groups[key].items.push(item);
  }

  console.log(`🔑 Unique title groups: ${Object.keys(groups).length}\n`);

  // ── Concurrency pool: process N groups at a time (avoids 2hr sequential waits) ──
  const CONCURRENCY = 8; // 8 parallel TMDB calls — safe within TMDB's 40 req/10s limit
  const groupEntries = Object.entries(groups);

  async function processGroup([, group]) {
    const rep    = group.items[0];
    const isSer  = rep.isSeries || rep.contentType === 'series' || rep.contentType === 'anime';

    // ── 1. DB lookup — avoid burning TMDB quota on existing titles ──────────
    const titleEsc = (rep.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let existing = null;
    if (rep.year) {
      existing = await Movie.findOne({ title: { $regex: `^${titleEsc}$`, $options: 'i' }, year: rep.year });
    }
    if (!existing) {
      existing = await Movie.findOne({ title: { $regex: `^${titleEsc}$`, $options: 'i' } });
    }

    // ── 2. TMDB / OMDB fetch (only for genuinely new titles) ────────────────
    let meta = {};
    if (existing) {
      meta = { tmdbId: existing.tmdbId, title: existing.title, type: existing.type };
    } else if (rep.title) {
      const [tmdb, omdb] = await Promise.all([
        searchTMDB(rep.title, rep.year, isSer, rep.season),
        searchOMDB(rep.title, rep.year, isSer),
      ]);
      if (tmdb) {
        Object.assign(meta, tmdb);
        if (!meta.poster      && omdb?.poster)           meta.poster      = omdb.poster;
        if (!meta.rating      && omdb?.rating)           meta.rating      = omdb.rating;
        if (!meta.description && omdb?.description)      meta.description = omdb.description;
        if (!meta.duration    && omdb?.duration)         meta.duration    = omdb.duration;
        if (!meta.genre?.length && omdb?.genre?.length)  meta.genre       = omdb.genre;
        if (omdb?.imdbId)                                meta.imdbId      = omdb.imdbId;
      } else if (omdb) {
        Object.assign(meta, omdb, { tmdbId: '' });
      }
      // No sleep — concurrency pool handles rate limiting naturally
    }

    if (!meta.title) { noMeta += group.items.length; return; }

    // ── 3. Determine final content type ──────────────────────────────────────
    // Priority: 1) TMDB Animation genre + Japanese/Korean/Chinese origin = anime
    //           2) Parser contentType = anime = anime
    //           3) TMDB says TV = series
    //           4) Parser says series = series
    //           5) Else = movie
    const tmdbGenres  = (meta.genre || []).map(g => (g || '').toLowerCase());
    const isAnimation = tmdbGenres.some(g => /animation|anime/i.test(g));
    const origLang    = (meta.originalLanguage || '').toLowerCase();
    // Strict language match — avoids false positives on partial strings
    const isEastAsian = /^(japanese|korean|chinese|mandarin|cantonese|ja|ko|zh)$/.test(origLang);
    const parserAnime = rep.contentType === 'anime';

    // Anime detection priority:
    //  1. TMDB Animation genre + East Asian origin  → definitely anime
    //  2. Parser flagged anime + (Animation OR East Asian)  → anime
    //  3. Parser flagged anime alone  → treat as anime (e.g. well-known name match)
    let finalType;
    if ((isAnimation && isEastAsian) || (parserAnime && (isAnimation || isEastAsian)) || parserAnime) {
      finalType = 'anime';
    } else if (meta.type === 'series' || isSer) {
      finalType = 'series';
    } else {
      finalType = 'movie';
    }

    // ── 4. Process every link in this title group ────────────────────────────
    for (const item of group.items) {
      let finalUrl = item.bypassedUrl || item.url;
      // Normalize trailing slash and http/https to prevent near-duplicate URLs
      finalUrl = finalUrl.replace(/^http:\/\//i, 'https://').replace(/\/$/, '');
      const host     = detectHost(finalUrl);
      const quality  = item.quality  || 'HD';
      const size     = item.size     || '';
      const language = item.language || '';
      const codec    = item.codec    || detectCodecLocal(item.filename);
      const hdr      = item.hdr      || null;

      // Correct season from filename if the parser mis-assigned it
      const correctSeason = seasonFromFilename(item.filename) ?? item.season ?? null;

      // ── Find or create the DB record ────────────────────────────────────
      let dbRec = existing;
      if (!dbRec && meta.tmdbId) {
        dbRec = await Movie.findOne({ tmdbId: meta.tmdbId });
      }

      const newDl = {
        quality,
        size,
        filename: item.filename || '',
        language,
        codec,
        hdr,
        season:   correctSeason,
        episode:  item.episode ?? null,
        links: [{ host, url: finalUrl, isFast: /gdflix|hubcloud|gdlink/i.test(finalUrl) }],
      };

      if (dbRec) {
        // ── Dedup: skip if exact URL already stored ──────────────────────
        const hasUrl = dbRec.downloads?.some(d => d.links?.some(l => l.url === finalUrl));
        if (hasUrl) { skipped++; continue; }

        // ── Smart upsert: find a "slot" that's the same variant ──────────
        const similar = dbRec.downloads.filter(d =>
          d.quality === quality &&
          d.season  == correctSeason &&
          d.episode == (item.episode ?? null) &&
          d.language === language
        );

        let handled = false;
        const newMB  = toMB(size);

        for (const slot of similar) {
          const oldMB = toMB(slot.size);
          const sameSize = slot.size === size || (newMB > 0 && oldMB > 0 && Math.abs(newMB - oldMB) < 2);

          if (sameSize) {
            // Merge a new alternative link into existing slot
            let merged = false;
            for (const nl of newDl.links) {
              if (!slot.links.find(l => l.url === nl.url)) {
                slot.links.push(nl);
                merged = true;
              }
            }
            if (merged) {
              dbRec.markModified('downloads');
              console.log(`🔗 Merged link: [${dbRec.title}] ${quality} S${correctSeason}E${item.episode||'?'}`);
              updated++;
            } else {
              skipped++;
            }
            handled = true;
            break;
          }

          // If not same size, we just loop to the next similar slot.
          // If no slot matches sameSize, handled remains false and it gets added as a separate variant.
        }

        if (!handled) {
          // Truly new variant (different size = different file)
          dbRec.downloads.push(newDl);
          dbRec.markModified('downloads');
          updated++;
        }

        // Keep metadata fields up to date if we now have better data
        if (!dbRec.backdrop    && meta.backdrop)    dbRec.backdrop    = meta.backdrop;
        if (!dbRec.poster      && meta.poster)      dbRec.poster      = meta.poster;
        if (!dbRec.tmdbId      && meta.tmdbId)      dbRec.tmdbId      = meta.tmdbId;
        if (!dbRec.imdbId      && meta.imdbId)      dbRec.imdbId      = meta.imdbId;
        if (!dbRec.rating      && meta.rating)      dbRec.rating      = meta.rating;
        if (!dbRec.description && meta.description) dbRec.description = meta.description;
        // Upgrade type: if parser/TMDB now says anime but DB says series, fix it
        if (finalType === 'anime' && dbRec.type === 'series') {
          dbRec.type = 'anime';
          console.log(`   Type upgrade: [${dbRec.title}] series → anime`);
        }

        // Recompute aggregated fields from all downloads
        _recomputeAggregates(dbRec);

        // Serialise saves per document to prevent concurrent VersionError
        
        await withDocLock(dbRec._id, async () => {
          // Re-fetch inside lock to guarantee latest state and prevent VersionError completely
          const freshRec = await Movie.findById(dbRec._id).read('primary');
          if (!freshRec) return;
          
          let handledFresh = false;
          // Apply array modifications to freshRec
          if (finalType === 'series' || finalType === 'anime') {
            for (let j = 0; j < freshRec.downloads.length; j++) {
              const freshMB = toMB(freshRec.downloads[j].size);
              const newMB = toMB(newDl.size);
              const isSameSize = freshRec.downloads[j].size === newDl.size || (newMB > 0 && freshMB > 0 && Math.abs(newMB - freshMB) < 2);
              if (
                freshRec.downloads[j].season === newDl.season &&
                freshRec.downloads[j].episode === newDl.episode &&
                freshRec.downloads[j].quality === newDl.quality &&
                freshRec.downloads[j].language === newDl.language &&
                isSameSize
              ) {
                const existingUrls = freshRec.downloads[j].links.map(l => l.url);
                for (const nl of newDl.links) {
                  if (!existingUrls.includes(nl.url)) {
                    freshRec.downloads[j].links.push(nl);
                    freshRec.markModified('downloads');
                    updated++;
                  }
                }
                handledFresh = true;
                break;
              }
            }
          } else {
            for (let j = 0; j < freshRec.downloads.length; j++) {
              const freshMB = toMB(freshRec.downloads[j].size);
              const newMB = toMB(newDl.size);
              const isSameSize = freshRec.downloads[j].size === newDl.size || (newMB > 0 && freshMB > 0 && Math.abs(newMB - freshMB) < 2);
              if (
                freshRec.downloads[j].quality === newDl.quality &&
                freshRec.downloads[j].language === newDl.language &&
                isSameSize
              ) {
                const existingUrls = freshRec.downloads[j].links.map(l => l.url);
                for (const nl of newDl.links) {
                  if (!existingUrls.includes(nl.url)) {
                    freshRec.downloads[j].links.push(nl);
                    freshRec.markModified('downloads');
                    updated++;
                  }
                }
                handledFresh = true;
                break;
              }
            }
          }
          
          if (!handledFresh) {
            freshRec.downloads.push(newDl);
            freshRec.markModified('downloads');
            updated++;
          }
          
          if (!freshRec.backdrop && meta.backdrop) freshRec.backdrop = meta.backdrop;
          if (!freshRec.poster && meta.poster) freshRec.poster = meta.poster;
          if (!freshRec.tmdbId && meta.tmdbId) freshRec.tmdbId = meta.tmdbId;
          if (!freshRec.imdbId && meta.imdbId) freshRec.imdbId = meta.imdbId;
          if (!freshRec.rating && meta.rating) freshRec.rating = meta.rating;
          if (!freshRec.description && meta.description) freshRec.description = meta.description;
          if (finalType === 'anime' && freshRec.type === 'series') freshRec.type = 'anime';
          
          _recomputeAggregates(freshRec);
          await freshRec.save();
        });

        console.log(`🔄 Updated: [${dbRec.title}] ${quality} → ${host}`);
        continue;
      }

      // ── Brand-new title — create ─────────────────────────────────────────
      try {
        const originalLang = meta.originalLanguage || meta.language || '';
        const newDoc = await Movie.create({
          title:              meta.title,
          tmdbId:             meta.tmdbId   || '',
          imdbId:             meta.imdbId   || '',
          type:               finalType,
          totalSeasons:       meta.totalSeasons || 0,
          description:        meta.description  || '',
          poster:             meta.poster        || '',
          backdrop:           meta.backdrop      || '',
          rating:             meta.rating        || 0,
          year:               meta.year    || item.year || new Date().getFullYear(),
          genre:              meta.genre   || [],
          duration:           meta.duration || '',
          quality,
          language:           originalLang,
          formats:            [quality].filter(Boolean),
          codecs:             [codec].filter(c => c !== 'Other'),
          languages:          (language || originalLang).split(',').map(l => l.trim()).filter(Boolean),
          telegramMessageIds: item.messageId ? [item.messageId] : [],
          downloads: [newDl],
        });
        added++;
        existing = newDoc; // subsequent items in the group will reuse this
        console.log(`➕ Added: [${meta.title}] (${meta.year || '?'}) ${quality} → ${host}`);
      } catch (e) {
        console.error(`❌ DB error for "${meta.title}": ${e.message}`);
        skipped++;
      }
    }
  } // end processGroup

  // ── Run all groups through the concurrency pool ───────────────────────────
  let idx2 = 0;
  async function runPool() {
    const active = [];
    for (const entry of groupEntries) {
      if (active.length >= CONCURRENCY) {
        await Promise.race(active);
      }
      const p = processGroup(entry).finally(() => active.splice(active.indexOf(p), 1));
      active.push(p);
      idx2++;
      if (idx2 % 100 === 0) {
        process.stdout.write(`\r   Processing: ${idx2}/${groupEntries.length} title groups...`);
      }
    }
    await Promise.all(active);
    process.stdout.write(`\r   Processing: ${groupEntries.length}/${groupEntries.length} title groups... Done!\n`);
  }
  await runPool();

  console.log(`\n📊 Import Summary`);
  console.log(`  ➕ New records  : ${added}`);
  console.log(`  🔄 Updated     : ${updated}`);
  console.log(`  🔼 Upgraded    : ${upgraded}`);
  console.log(`  ⏭️  Skipped    : ${skipped}`);
  console.log(`  ❓ No metadata : ${noMeta}`);
  console.log(`\n🎉 Done!\n`);

  await mongoose.disconnect();
}

// ─── AGGREGATE RECOMPUTE ──────────────────────────────────────────────────────
function _recomputeAggregates(doc) {
  const dls = doc.downloads || [];
  // Unique quality formats
  doc.formats = [...new Set(dls.map(d => d.quality))].filter(Boolean);
  // Unique codecs (exclude generic "Other")
  doc.codecs  = [...new Set(dls.map(d => d.codec || detectCodecLocal(d.filename)))].filter(c => c && c !== 'Other');
  // All languages across all downloads
  const allLangs = [];
  dls.forEach(d => {
    if (d.language) {
      d.language.split(',').forEach(l => {
        let clean = l.trim();
        // Title case for consistency: "multi" -> "Multi", "tamil" -> "Tamil"
        clean = clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
        allLangs.push(clean);
      });
    }
  });
  doc.languages = [...new Set(allLangs)].filter(Boolean);
  // Best quality
  const QUALITY_ORDER = ['4K', '1080p', '720p', '480p', '360p', 'HD'];
  const best = QUALITY_ORDER.find(q => doc.formats.includes(q));
  if (best) doc.quality = best;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

