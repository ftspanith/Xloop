const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }

test('Content Manager has visible search, tab controls and resilient API loading', () => {
  const html = read('public/admin/manager.html');
  assert.match(html, /class="search-icon"[^>]*><svg/);
  assert.match(html, /switchTab\('search'\)/);
  assert.match(html, /switchTab\('add'\)/);
  assert.match(html, /async function loadSearch\(\)/);
  assert.match(html, /retry-load-search/);
  assert.match(html, /Cache-Control|cache:\s*'no-store'/);
});

test('admin mobile navigation controls are not empty', () => {
  const files = fs.readdirSync(path.join(root, 'public/admin')).filter(f => f.endsWith('.html'));
  for (const file of files) {
    const html = read('public/admin/' + file);
    assert.doesNotMatch(html, /<button class="mobile-menu-btn"[^>]*><\/button>/, file + ': empty mobile menu');
    assert.doesNotMatch(html, /<button class="sidebar-close-btn"[^>]*><\/button>/, file + ': empty sidebar close');
  }
});

test('scraper keeps replace and merge semantics explicit and protects existing data in merge mode', () => {
  const route = read('routes/scrape.js');
  assert.match(route, /const mergeMode = req\.query\.merge === 'true'/);
  assert.match(route, /if \(mergeMode\)[\s\S]*?existingUrls/);
  assert.match(route, /if \(!mergeMode\)[\s\S]*?deleteMany\(\{ uploadBatch: \{ \$ne: batchId \} \}\)/);
  const runner = read('scrape-and-upload.js');
  assert.match(runner, /account === 'both'/);
  assert.match(runner, /runAccountChild\('1'\)[\s\S]*runAccountChild\('2'\)/);
});
