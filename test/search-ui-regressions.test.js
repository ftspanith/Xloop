const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/search.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
const searchApi = fs.readFileSync(path.join(root, 'routes/search.js'), 'utf8');

const inlineScripts = html.split('<script').slice(1).map(segment => {
  const start = segment.indexOf('>');
  const end = segment.indexOf('</script>');
  return start >= 0 && end > start ? segment.slice(start + 1, end) : '';
});
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
  assert.equal(runSearch.includes('mainInput.value = q'), false);
  assert.ok(activeSearchScript.includes('searchRequestId++'));
  assert.ok(activeSearchScript.includes('requestId !== searchRequestId'));
});

test('new searches abort superseded network requests', () => {
  assert.ok(activeSearchScript.includes('searchAbortController.abort()'));
  assert.ok(activeSearchScript.includes('new AbortController()'));
  assert.ok(activeSearchScript.includes('fetch(url, { signal: controller.signal })'));
});

test('search suggestions are cancellable and report expanded state', () => {
  assert.ok(activeSearchScript.includes('suggestionAbortController.abort()'));
  assert.ok(activeSearchScript.includes("mainInput.setAttribute('aria-expanded', 'true')"));
  assert.ok(activeSearchScript.includes("mainInput.setAttribute('aria-expanded', 'false')"));
  assert.ok(html.includes('role="listbox"'));
});

test('search UI exposes status and busy state to assistive technology', () => {
  assert.ok(html.includes('role="status" aria-live="polite"'));
  assert.ok(html.includes('id="searchResults" aria-busy="false"'));
});

test('mobile filters use four compact, accessible buttons', () => {
  assert.equal((html.match(/<button type="button" class="type-tab/g) || []).length, 4);
  assert.ok(html.includes('aria-pressed="true"'));
});

test('search animations stay lightweight and respect reduced motion', () => {
  assert.ok(html.includes('searchProgress'));
  assert.ok(html.includes('searchCardIn .28s'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(css.includes('@media (max-width: 420px)'));
  assert.ok(css.includes('.content-grid > .card { width: 100%; min-width: 0; }'));
});

test('backend search preserves Unicode scripts and typo-tolerant ranking', () => {
  const normalizeStart = searchApi.indexOf('function normalize(');
  const distanceStart = searchApi.indexOf('function levenshtein(');
  const scoreStart = searchApi.indexOf('function relevanceScore(');
  assert.ok(normalizeStart >= 0 && distanceStart > normalizeStart && scoreStart > distanceStart);
  const helpers = require('node:vm').runInNewContext(
    searchApi.slice(normalizeStart, scoreStart) + String.fromCharCode(10) + '({ normalize, levenshtein });'
  );
  assert.equal(helpers.normalize('తెలుగు సినిమా'), 'తెలుగు సినిమా');
  assert.equal(helpers.normalize('Beyoncé'), 'beyonce');
  assert.equal(helpers.levenshtein('映画', '映畫'), 1);
  assert.ok(searchApi.includes('function relevanceScore('));
  assert.ok(searchApi.includes('Movie.find(searchFilter)'));
});
