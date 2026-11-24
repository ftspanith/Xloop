'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const orchestrator = fs.readFileSync(path.join(root, 'routes/orchestrator.js'), 'utf8');
const pipeline = fs.readFileSync(path.join(root, 'pipeline_full.js'), 'utf8');

test('local child-process pipeline endpoint requires admin authentication', () => {
  assert.match(orchestrator, /router\\.get\\(['"]\\/start-local['"],\\s*auth\\s*,/);
});

test('GET and POST scoped pipeline starts force no-wipe', () => {
  const noWipeArg = /noWipe:\\s*!!skipScraper\\s*\\|\\|\\s*scope\\s*!==\\s*['"]all['"]\\s*\\|\\|\\s*!!resume/;
  assert.equal((orchestrator.match(new RegExp(noWipeArg.source, 'g')) || []).length, 2);
});

test('pipeline applies scope filtering and protects the catalogue on scoped/resume runs', () => {
  assert.match(pipeline, /filterEntriesByScope\\(allEntries/);
  assert.match(pipeline, /const NO_WIPE = requestedNoWipe \\|\\| scope !== 'all' \\|\\| RESUME/);
});

test('catalogue deletion happens after source/provider preflight', () => {
  const deleteAt = pipeline.indexOf('await Movie.deleteMany({})');
  const scopeAt = pipeline.indexOf('filterEntriesByScope(allEntries');
  const providerAt = pipeline.indexOf('isAllowedTelegramDownloadUrl(entry?.bypassedUrl || entry?.url)');
  const importAt = pipeline.indexOf('await phaseImport(allEntries');
  assert.ok(deleteAt > scopeAt, 'scope must be selected before catalogue deletion');
  assert.ok(deleteAt > providerAt, 'usable provider links must be validated before catalogue deletion');
  assert.ok(deleteAt < importAt, 'catalogue replacement must happen before importing selected entries');
});

test('zero-result and stop conditions abort before catalogue deletion', () => {
  const deleteAt = pipeline.indexOf('await Movie.deleteMany({})');
  const emptyScopeAt = pipeline.indexOf('No entries matched scope');
  const noUsableAt = pipeline.indexOf('No usable GDFlix, HubCloud or TMBCloud links remain');
  const stopAt = pipeline.indexOf('Pipeline stopped before catalogue import');
  assert.ok(emptyScopeAt >= 0 && emptyScopeAt < deleteAt);
  assert.ok(noUsableAt >= 0 && noUsableAt < deleteAt);
  assert.ok(stopAt >= 0 && stopAt < deleteAt);
});
