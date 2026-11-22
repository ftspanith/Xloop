'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pages = [
  'public/index.html',
  'public/movies.html',
  'public/shows.html',
  'public/anime.html',
  'public/search.html',
  'public/watch.html',
  'public/series.html',
  'public/invite-denied.html',
  'public/admin/add-manual.html',
  'public/admin/add-movie.html',
  'public/admin/add-series.html',
  'public/admin/bulk-import.html',
  'public/admin/collection.html',
  'public/admin/dashboard.html',
  'public/admin/fix-posters.html',
  'public/admin/localhost.html',
  'public/admin/login.html',
  'public/admin/manager.html',
  'public/admin/orchestrator.html',
  'public/admin/scraper.html',
];

const scriptPath = /<script\s+defer\s+src=["']\/_vercel\/insights\/script\.js["']\s*>\s*<\/script>/gi;
const queueInit = /window\.va\s*=\s*window\.va\s*\|\|\s*function\s*\(\)\s*\{\s*\(window\.vaq\s*=\s*window\.vaq\s*\|\|\s*\[\]\)\.push\(arguments\);\s*\};/g;

for (const relativePath of pages) {
  const fullPath = path.join(__dirname, '..', relativePath);
  assert.ok(fs.existsSync(fullPath), 'missing page: ' + relativePath);
  const html = fs.readFileSync(fullPath, 'utf8');
  assert.equal((html.match(scriptPath) || []).length, 1, 'analytics script must appear exactly once: ' + relativePath);
  assert.equal((html.match(queueInit) || []).length, 1, 'analytics queue init must appear exactly once: ' + relativePath);
}

console.log('Vercel Analytics HTML checks passed for ' + pages.length + ' pages.');
