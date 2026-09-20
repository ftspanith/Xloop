#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// pipeline.js  — ONE COMMAND FRESH START
//
// Does everything in sequence:
//   1. Wipe MongoDB (all movies/series/episodes)
//   2. Parse telegram_export.json  →  links_for_bypasser.json
//   3. Import all DIRECT links     →  MongoDB (with TMDB/IMDB posters)
//   4. Run heal_db.js              →  fills remaining gaps
//
// Usage:
//   node pipeline.js              — wipe + extract + import + heal
//   node pipeline.js --no-wipe    — skip wipe (add new data only)
//   node pipeline.js --no-heal    — skip the healer pass
//   node pipeline.js --extract-only  — just parse, no import
//
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config();
const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');

const args     = process.argv.slice(2);
const WIPE     = !args.includes('--no-wipe');
const HEAL     = !args.includes('--no-heal');
const ONLY_EXT = args.includes('--extract-only');
const ROOT     = __dirname;

const C = {
  reset:  '\x1b[0m', bold: '\x1b[1m',
  green:  '\x1b[32m', yellow: '\x1b[33m',
  red:    '\x1b[31m', cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

const log  = msg => console.log(`${C.bold}${C.cyan}▶${C.reset}  ${msg}`);
const ok   = msg => console.log(`${C.green}✅ ${msg}${C.reset}`);
const warn = msg => console.log(`${C.yellow}⚠️  ${msg}${C.reset}`);
const err  = msg => console.log(`${C.red}❌ ${msg}${C.reset}`);
const sep  = ()  => console.log(`\n${C.gray}${'─'.repeat(60)}${C.reset}\n`);

function runScript(scriptPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit',
    });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Exited ${code}: ${path.basename(scriptPath)}`)));
    child.on('error', reject);
  });
}

async function main() {
  const t0 = Date.now();
  console.log();
  console.log(`${C.bold}${C.cyan}╔═══════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║      XLOOP — FRESH IMPORT PIPELINE         ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚═══════════════════════════════════════════════╝${C.reset}`);
  console.log();

  if (!fs.existsSync(path.join(ROOT, 'telegram_export.json'))) { err('telegram_export.json not found!'); process.exit(1); }
  if (!process.env.TMDB_API_KEY && !process.env.TMDB_KEY) warn('TMDB_API_KEY not set — posters will be blank!');
  if (!process.env.MONGODB_URI)  warn('MONGODB_URI not set — using mongodb://localhost:27017/xloop');

  // ── STEP 1: Wipe ────────────────────────────────────────────────────────────
  sep();
  if (WIPE) {
    log('STEP 1/4 — Wiping database...');
    await runScript(path.join(ROOT, 'wipe_db.js'));
    ok('Database wiped clean');
  } else {
    warn('STEP 1/4 — Skipping wipe (--no-wipe)');
  }

  // ── STEP 2: Extract / Parse ──────────────────────────────────────────────────
  sep();
  log('STEP 2/4 — Parsing telegram_export.json...');
  await runScript(path.join(ROOT, 'extract_links.js'));
  ok('Parsing complete → links_for_bypasser.json');

  const linksFile = path.join(ROOT, 'links_for_bypasser.json');
  if (!fs.existsSync(linksFile)) { err('links_for_bypasser.json not created — abort'); process.exit(1); }
  const allLinks    = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
  const directLinks = allLinks.filter(l => l.host !== 'Shortlink');
  const shortLinks  = allLinks.filter(l => l.host === 'Shortlink');
  log(`${allLinks.length} entries: ${directLinks.length} direct | ${shortLinks.length} shortlinks (skipped)`);

  if (ONLY_EXT) { sep(); ok('--extract-only done.'); process.exit(0); }

  // ── STEP 3: Import ──────────────────────────────────────────────────────────
  sep();
  log('STEP 3/4 — Importing direct links → MongoDB...');
  log('           TMDB/IMDB direct ID lookup = instant ✅  |  fuzzy fallback for rest');
  console.log();
  await runScript(path.join(ROOT, 'import_bypassed.js'), { IMPORT_SOURCE: linksFile });
  ok('Import complete');

  // ── STEP 4: Heal ────────────────────────────────────────────────────────────
  sep();
  if (HEAL) {
    log('STEP 4/4 — Healing remaining gaps (poster/description/rating)...');
    console.log();
    await runScript(path.join(ROOT, 'heal_db.js'));
    ok('Healing complete');
  } else {
    warn('STEP 4/4 — Skipping healer (--no-heal)');
  }

  // ── Done ────────────────────────────────────────────────────────────────────
  sep();
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`${C.bold}${C.green}🎉 Pipeline complete in ${Math.floor(s/60)}m ${s%60}s${C.reset}\n`);
  console.log(`  Website: ${C.cyan}http://localhost:3000${C.reset}`);
  if (shortLinks.length) {
    console.log();
    warn(`${shortLinks.length} shortlinks skipped.`);
    warn('Run bypasser later, then: node import_bypassed.js');
  }
  console.log();
}

main().catch(e => { err(`Pipeline failed: ${e.message}`); process.exit(1); });
