/**
 * fix_languages.js
 * 
 * Scans ALL movies in DB and upgrades each download entry's language field
 * by parsing the filename with the full multi-language detector.
 * Runs PARALLEL to the dev server (read-write on MongoDB, no server restart needed).
 * 
 * Usage: node fix_languages.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// ── Full language map (mirrors watch.js parseDlInfo) ──────────────────────────
const LANG_MAP = [
  { re: /\btelugu\b/i,          label: 'Telugu' },
  { re: /\btamil\b/i,           label: 'Tamil' },
  { re: /\bhindi\b/i,           label: 'Hindi' },
  { re: /\bmalayalam\b/i,       label: 'Malayalam' },
  { re: /\bkannada\b/i,         label: 'Kannada' },
  { re: /\benglish\b/i,         label: 'English' },
  { re: /\bmarathi\b/i,         label: 'Marathi' },
  { re: /\bbengali\b/i,         label: 'Bengali' },
  { re: /\bpunjabi\b/i,         label: 'Punjabi' },
  // Short codes
  { re: /\b(Tel|TEL)\b/,        label: 'Telugu' },
  { re: /\b(Tam|TAM)\b/,        label: 'Tamil' },
  { re: /\b(Hin|HIN)\b/,        label: 'Hindi' },
  { re: /\b(Mal|MAL|ML)\b/,     label: 'Malayalam' },
  { re: /\b(Kan|KAN)\b/,        label: 'Kannada' },
  { re: /\b(Eng|ENG)\b/,        label: 'English' },
  { re: /\b(Mar|MAR)\b/,        label: 'Marathi' },
  { re: /\b(Ben|BEN)\b/,        label: 'Bengali' },
  { re: /\b(Pun|PUN)\b/,        label: 'Punjabi' },
  // Unicode native scripts
  { re: /తెలుగు/,               label: 'Telugu' },
  { re: /தமிழ்/,                label: 'Tamil' },
  { re: /हिन्दी|हिंदी/,        label: 'Hindi' },
  { re: /മലയാളം/,               label: 'Malayalam' },
  { re: /ಕನ್ನಡ/,                label: 'Kannada' },
  { re: /বাংলা/,                 label: 'Bengali' },
  { re: /ਪੰਜਾਬੀ/,                label: 'Punjabi' },
  { re: /मराठी/,                 label: 'Marathi' },
  { re: /\bmulti\b/i,            label: 'Multi' },
];

function detectLanguages(filename, fallback) {
  const detected = [];
  for (const { re, label } of LANG_MAP) {
    if (re.test(filename) && !detected.includes(label)) {
      detected.push(label);
    }
  }
  if (detected.length === 0 && fallback) detected.push(fallback);
  const specific = detected.filter(l => l !== 'Multi');
  const isMulti  = detected.includes('Multi') || specific.length > 1;
  return isMulti && specific.length > 0
    ? `Multi (${specific.join('+')})`
    : (detected[0] || 'Unknown');
}

// ── Main ──────────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Movie = require('./models/Movie');
  const total = await Movie.countDocuments();
  console.log(`\n Fixing languages for ${total} movies...\n`);

  let cursor = Movie.find({}).cursor();
  let done = 0, updated = 0;

  for await (const movie of cursor) {
    let changed = false;
    const fallback = movie.language || '';

    for (const dl of (movie.downloads || [])) {
      const newLang = detectLanguages(dl.filename || '', fallback);
      if (newLang !== dl.language) {
        dl.language = newLang;
        changed = true;
      }
    }

    // Also fix movie-level language if it's wrong or generic
    const allLangs = new Set();
    for (const dl of (movie.downloads || [])) {
      const l = detectLanguages(dl.filename || '', '');
      if (l && l !== 'Unknown') {
        // Extract base lang from "Multi (Tel+Tam)" → ['Tel','Tam']
        if (l.startsWith('Multi (')) {
          l.replace('Multi (', '').replace(')', '').split('+').forEach(x => allLangs.add(x.trim()));
        } else {
          allLangs.add(l);
        }
      }
    }

    if (allLangs.size > 1) {
      const newMovieLang = `Multi (${[...allLangs].join('+')})`;
      if (movie.language !== newMovieLang) { movie.language = newMovieLang; changed = true; }
    } else if (allLangs.size === 1) {
      const l = [...allLangs][0];
      if (movie.language !== l) { movie.language = l; changed = true; }
    }

    if (changed) {
      try {
        await Movie.updateOne(
          { _id: movie._id },
          { $set: { downloads: movie.downloads, language: movie.language } }
        );
        updated++;
        process.stdout.write(`\r ${done}/${total} processed | ${updated} updated`);
      } catch (saveErr) {
        // Skip version conflicts silently — they'll be fixed on next run
        if (!saveErr.message.includes('No matching document')) {
          process.stderr.write(`\nSkip ${movie.title}: ${saveErr.message}\n`);
        }
      }
    }

    done++;
    if (done % 100 === 0) process.stdout.write(`\r ${done}/${total} processed | ${updated} updated`);
  }

  console.log(`\n\n Done! Processed ${done} movies, updated ${updated} entries.\n`);
  process.exit(0);
}).catch(err => {
  console.error('DB connection failed:', err.message);
  process.exit(1);
});
