'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');

test('global stylesheet prevents automatic mobile text inflation', () => {
  assert.match(css, /-webkit-text-size-adjust:\s*100%/);
  assert.match(css, /text-size-adjust:\s*100%/);
});

test('fixed mobile navigation overlay fits the viewport without 100vw overflow', () => {
  const viewportFix = css.indexOf('/* Fixed-viewport guarantee:');
  const start = css.indexOf('#mobileNavOverlay {', viewportFix);
  const end = css.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'mobile navigation overlay rule should exist');
  const rule = css.slice(start, end);
  assert.match(rule, /inset:\s*0/);
  assert.match(rule, /width:\s*auto\s*!important/);
  assert.doesNotMatch(rule, /width:\s*100vw/);
});

test('public and admin entry pages keep the device-width viewport declaration', () => {
  const pages = [
    'public/index.html',
    'public/movies.html',
    'public/shows.html',
    'public/anime.html',
    'public/watch.html',
    'public/search.html',
    'public/admin/login.html',
    'public/admin/dashboard.html',
    'public/admin/orchestrator.html',
    'public/admin/scraper.html',
  ];

  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(
      html,
      /\<meta\s+name=["']viewport["']\s+content=["']width=device-width,\s*initial-scale=1(?:\.0)?(?:,[^"']*)?["']/i,
      page + ' should use the device viewport'
    );
  }
});
