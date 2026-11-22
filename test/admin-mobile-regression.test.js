'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const adminDir = path.join(root, 'public', 'admin');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Admin pages do not contain empty buttons that hide mobile menu icons', () => {
  const pages = fs.readdirSync(adminDir).filter(name => name.endsWith('.html'));
  assert.ok(pages.length > 0, 'admin HTML pages should exist');

  for (const page of pages) {
    const html = fs.readFileSync(path.join(adminDir, page), 'utf8');
    assert.doesNotMatch(
      html,
      /<button\b[^>]*>\s*<\/button>/i,
      page + ' contains a button with no visible label or icon'
    );
  }
});

test('Content Manager search, modal close, and remove actions have visible controls', () => {
  const manager = read('public/admin/manager.html');

  assert.match(manager, /class="search-icon"[^>]*>[\s\S]*?<svg\b/i);
  assert.match(manager, /class="modal-close"[^>]*aria-label="Close edit window"[^>]*>[\s\S]*?<svg\b/i);
  assert.match(manager, /class="title-icon"[^>]*>[\s\S]*?<svg\b/i);
  assert.match(manager, /aria-label="Remove this link row"/i);
  assert.match(manager, /aria-label="Remove this download file"/i);
});

test('Content Manager reports metadata, create, edit, and delete failures in the UI', () => {
  const manager = read('public/admin/manager.html');

  assert.match(manager, /Metadata lookup failed/);
  assert.match(manager, /Could not save this content/);
  assert.match(manager, /Could not save changes/);
  assert.match(manager, /Could not delete this content/);
  assert.match(manager, /Failed to load recent contents/);
});

test('Dashboard supports selecting and validating both account exports before upload', () => {
  const dashboard = read('public/admin/dashboard.html');
  const startAt = dashboard.indexOf('async function startPipeline2');
  const endAt = dashboard.indexOf('// Single resilient stream connection manager', startAt);
  assert.notEqual(startAt, -1, 'startPipeline2 should exist');
  assert.notEqual(endAt, -1, 'startPipeline2 should have a clear end boundary');
  const startFunction = dashboard.slice(startAt, endAt);

  assert.match(dashboard, /class="account-source-grid"/);
  assert.match(dashboard, /\.account-source-grid\{grid-template-columns:1fr;\}/);
  assert.match(dashboard, /Upload Selected Account\(s\) &amp; Run/);
  assert.match(dashboard, /async function parseAccountExport\(file, account\)/);
  assert.match(startFunction, /preparedUploads\.acc1 = await parseAccountExport/);
  assert.match(startFunction, /preparedUploads\.acc2 = await parseAccountExport/);
  assert.ok(
    startFunction.indexOf('preparedUploads.acc2 = await parseAccountExport') <
      startFunction.indexOf("fetch('/api/scrape/save-extracted?account=1'"),
    'both selected files must be parsed before Account 1 can replace stored data'
  );
  assert.match(startFunction, /save-extracted\?account=1/);
  assert.match(startFunction, /save-extracted\?merge=true&account=2/);
  assert.doesNotMatch(dashboard, /dashUploadBtn|dashUploadMsg|dashSafeClose|dashBothProgress/);
});

test('Server tags extracted-link uploads with the selected source account', () => {
  const route = read('routes/scrape.js');
  const model = read('models/ExtractedLink.js');

  assert.match(route, /const sourceAccount = \['1', '2'\]/);
  assert.match(route, /if \(sourceAccount\) e\.sourceAccount = sourceAccount/);
  assert.match(model, /sourceAccount:\s*\{\s*type:\s*String/);
});

test('Inline JavaScript on every admin page parses without syntax errors', () => {
  const pages = fs.readdirSync(adminDir).filter(name => name.endsWith('.html'));
  let checked = 0;

  for (const page of pages) {
    const html = fs.readFileSync(path.join(adminDir, page), 'utf8');
    const scripts = [...html.matchAll(/<script\\b(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)<\\/script>/gi)];

    scripts.forEach((match, index) => {
      checked += 1;
      assert.doesNotThrow(
        () => new vm.Script(match[1], { filename: page + ':inline-script-' + (index + 1) }),
        page + ' inline script ' + (index + 1) + ' must parse'
      );
    });
  }

  assert.ok(checked > 0, 'inline scripts should be checked');
});
