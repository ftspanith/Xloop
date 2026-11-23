const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('Content Manager exposes visible search/tabs and safe loading feedback', () => {
  const html = read('public/admin/manager.html');
  assert.match(html, /class="search-icon"[^>]*><svg/);
  assert.match(html, /switchTab\('search'\)/);
  assert.match(html, /switchTab\('add'\)/);
  assert.match(html, /async function loadSearch\(\)/);
  assert.match(html, /retry-load-search/);
});

test('admin mobile navigation controls are not empty', () => {
  const files = fs.readdirSync(path.join(root, 'public/admin'))
    .filter(file => file.endsWith('.html'));

  for (const file of files) {
    const html = read('public/admin/' + file);
    assert.doesNotMatch(
      html,
      /<button\b[^>]*class=["'][^"']*mobile-menu-btn[^"']*["'][^>]*>\s*<\/button>/i,
      file + ': empty mobile menu'
    );
    assert.doesNotMatch(
      html,
      /<button\b[^>]*class=["'][^"']*sidebar-close-btn[^"']*["'][^>]*>\s*<\/button>/i,
      file + ': empty sidebar close'
    );
  }
});

test('admin API calls use same-origin relative routes, not localhost', () => {
  const files = fs.readdirSync(path.join(root, 'public/admin'))
    .filter(file => file.endsWith('.html'));
  for (const file of files) {
    const html = read('public/admin/' + file);
    assert.doesNotMatch(html, /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/api\//i, file + ': hard-coded local API');
  }
});

test('scraper merge and replace safety guards remain explicit', () => {
  const route = read('routes/scrape.js');
  assert.match(route, /const mergeMode = req\.query\.merge === 'true'/);
  assert.match(route, /if \(mergeMode\)[\s\S]*?existingUrls/);
  assert.match(route, /if \(!mergeMode\)[\s\S]*?deleteMany\(\{ uploadBatch: \{ \$ne: batchId \} \}\)/);

  const runner = read('scrape-and-upload.js');
  assert.match(runner, /account === 'both'/);
  assert.match(runner, /runAccountChild\('1'\)[\s\S]*runAccountChild\('2'\)/);
});

test('series search keeps anime results in the legacy series category', () => {
  const route = read('routes/search.js');
  assert.match(route, /type === 'series'\\)\\s*filter\\.type = \\{\\s*\\$in: \\['series', 'anime'\\]\\s*\\}/);
});
