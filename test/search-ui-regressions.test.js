const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/search.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
const searchApi = fs.readFileSync(path.join(root, 'routes/search.js'), 'utf8');

const inlineScripts = [...html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/g)].map(match => match[1]);
const activeSearchScript = inlineScripts.find(script => script.includes('function runSearch'));
assert.ok(activeSearchScript, 'active search page script should be present');

function getRunSearchSource() {
  const start = activeSearchScript.indexOf('async function runSearch');
  const end = activeSearchScript.indexOf('// ── Pagination', start);
  assert.notEqual(start, -1, 'runSearch function should exist');
  assert.notEqual(end, -1, 'pagination block should follow runSearch');
  return activeSearchScript.slice(start, end);
}

test('typing cannot be overwritten by an older search request', () => {
  const runSearch = getRunSearchSource();
  assert.doesNotMatch(runSearch, /mainInput\\.value\\s*=/);
  assert.match(activeSearchScript, /searchRequestId\\+\\+/);
  assert.match(activeSearchScript, /requestId !== searchRequestId/);
});

test('new searches abort superseded network requests', () => {
  assert.match(activeSearchScript, /searchAbortController\\.abort\\(\\)/);
  assert.match(activeSearchScript, /new AbortController\\(\\)/);
  assert.match(activeSearchScript, /fetch\\(url, \\{ signal: controller\\.signal \\}\\)/);
});

test('search suggestions are cancellable and report expanded state', () => {
  assert.match(activeSearchScript, /suggestionAbortController\\.abort\\(\\)/);
  assert.match(activeSearchScript, /mainInput\\.setAttribute\\('aria-expanded', 'true'\\)/);
  assert.match(activeSearchScript, /mainInput\\.setAttribute\\('aria-expanded', 'false'\\)/);
  assert.match(html, /role="listbox"/);
});

test('search UI exposes status and busy state to assistive technology', () => {
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /id="searchResults" aria-busy="false"/);
});

test('search animations stay lightweight and respect reduced motion', () => {
  assert.match(html, /searchProgress/);
  assert.match(html, /searchCardIn \.28s/);
  assert.match(css, /@media \\(prefers-reduced-motion: reduce\\)/);
  assert.match(css, /@media \\(max-width: 420px\\)/);
  assert.match(css, /content-grid > \.card \\{ width: 100%; min-width: 0; \\}/);
});

test('backend search remains normalized, typo-tolerant, and relevance-ranked', () => {
  assert.match(searchApi, /function normalize\\(/);
  assert.match(searchApi, /function levenshtein\\(/);
  assert.match(searchApi, /function relevanceScore\\(/);
  assert.match(searchApi, /Movie\\.find\\(searchFilter\\)/);
});
