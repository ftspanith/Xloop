'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pages = [
  "public/index.html",
  "public/movies.html",
  "public/shows.html",
  "public/anime.html",
  "public/search.html",
  "public/watch.html",
  "public/invite-denied.html",
  "public/admin/add-manual.html",
  "public/admin/add-movie.html",
  "public/admin/add-series.html",
  "public/admin/bulk-import.html",
  "public/admin/collection.html",
  "public/admin/dashboard.html",
  "public/admin/fix-posters.html",
  "public/admin/localhost.html",
  "public/admin/login.html",
  "public/admin/manager.html",
  "public/admin/orchestrator.html",
  "public/admin/scraper.html"
];

function count(text, token) {
  return text.split(token).length - 1;
}

for (const relativePath of pages) {
  const fullPath = path.join(__dirname, '..', relativePath);
  assert.ok(fs.existsSync(fullPath), 'missing page: ' + relativePath);
  const html = fs.readFileSync(fullPath, 'utf8');

  const vanillaPathCount = count(html, 'src="/_vercel/insights/script.js"');
  const queueInitCount = count(html, 'window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };');
  const moduleImportCount = count(html, 'import { inject } from "https://esm.sh/@vercel/analytics@2.0.1";');
  const injectCallCount = count(html, 'inject();');

  assert.equal(vanillaPathCount + moduleImportCount, 1, 'exactly one analytics integration must exist: ' + relativePath);
  assert.equal(queueInitCount, vanillaPathCount, 'vanilla queue initializer must match the loader: ' + relativePath);
  if (moduleImportCount) assert.equal(injectCallCount, 1, 'module inject call must appear once: ' + relativePath);
}

console.log('Vercel Analytics HTML checks passed for ' + pages.length + ' pages.');
