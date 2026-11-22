#!/usr/bin/env node
'use strict';

// Rebuild existing Telegram exports without contacting Telegram.
// The canonical main export is validated and preserved byte-for-data;
// only JSON whitespace and the derived review sidecar schema are optimized.

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { createExportArtifacts } = require('../utils/telegram-intelligence');

const accountArg = process.argv.find(arg => arg.startsWith('--account='));
const account = accountArg ? accountArg.split('=')[1] : '1';
if (!['1', '2'].includes(account)) {
  throw new Error('Use --account=1 or --account=2.');
}

const suffix = account === '2' ? '_2' : '';
const accountName = `acc${account}`;
const root = path.resolve(__dirname, '..');
const mainName = `telegram_export${suffix}.json`;
const reviewName = `telegram_review${suffix}.json`;
const shortlinksName = `telegram_shortlinks${suffix}.json`;
const reportName = `telegram_scan_report${suffix}.json`;

function readJson(filePath, required = true) {
  if (!fs.existsSync(filePath)) {
    if (!required) return null;
    throw new Error(`Required export not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stageWrite(filePath, value, staged) {
  const tempPath = `${filePath}.optimize.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value), { mode: 0o600 });
  staged.push({ tempPath, filePath });
}

function commitStagedWrites(staged) {
  try {
    staged.forEach(({ tempPath, filePath }) => fs.renameSync(tempPath, filePath));
  } catch (error) {
    staged.forEach(({ tempPath }) => {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    });
    throw error;
  }
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch (_) { return 0; }
}

const mainPath = path.join(root, mainName);
const reportPath = path.join(root, reportName);
const originalMain = readJson(mainPath);
const oldReport = readJson(reportPath, false);

if (!Array.isArray(originalMain.messages)) {
  throw new Error(`${mainName} has no messages array; refusing to modify files.`);
}

const messages = originalMain.messages;
const artifacts = createExportArtifacts(messages, {
  account: originalMain.account || account,
  modeLabel: originalMain.scrape_mode || 'full',
  exportedAt: originalMain.exported_at,
  scanStats: {
    scanned: oldReport && oldReport.scanned_messages,
    skipped: oldReport && oldReport.skipped_messages,
    skippedReasons: oldReport && oldReport.skipped_reasons,
    channelErrors: oldReport && oldReport.channel_errors,
    relatedMetadataEnrichments: oldReport && oldReport.related_metadata_enrichments,
  },
});

// Guard against accidental changes to any canonical message or main-export field.
assert.deepStrictEqual(artifacts.main, originalMain, 'Main export content/schema changed; refusing optimization.');

const targets = [
  [mainPath, artifacts.main],
  [path.join(root, shortlinksName), artifacts.shortlinks],
  [path.join(root, reviewName), artifacts.review],
  [reportPath, artifacts.report],
];

const downloadsDir = path.join(require('os').homedir(), 'storage', 'downloads');
if (fs.existsSync(downloadsDir)) {
  const expectedPrefix = `xloop_${originalMain.scrape_mode || 'full'}_${accountName}_`;
  const expectedSuffix = `_${messages.length}msgs.json`;
  const backupName = fs.readdirSync(downloadsDir).find(name =>
    name.startsWith(expectedPrefix) && name.endsWith(expectedSuffix)
  );
  if (backupName) {
    targets.push([path.join(downloadsDir, backupName), artifacts.main]);
    for (const name of [shortlinksName, reviewName, reportName]) {
      const copyPath = path.join(downloadsDir, name);
      if (fs.existsSync(copyPath)) {
        const value = name === shortlinksName ? artifacts.shortlinks
          : name === reviewName ? artifacts.review : artifacts.report;
        targets.push([copyPath, value]);
      }
    }
  }
}

const before = new Map(targets.map(([filePath]) => [filePath, fileSize(filePath)]));
const staged = [];
try {
  targets.forEach(([filePath, value]) => stageWrite(filePath, value, staged));
  commitStagedWrites(staged);
} catch (error) {
  staged.forEach(({ tempPath }) => {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  });
  throw error;
}

console.log(`Account ${account} export optimization complete (no Telegram requests made).`);
console.log(`Messages preserved: ${messages.length}`);
console.log('Main export content and schema: unchanged; JSON whitespace compacted.');
console.log('Review sidecar: compact schema v2; complete messages remain in the main export.');
targets.forEach(([filePath]) => {
  const oldSize = before.get(filePath) || 0;
  const newSize = fileSize(filePath);
  const delta = oldSize ? ((oldSize - newSize) / 1024 / 1024).toFixed(2) : 'new';
  console.log(`${path.relative(root, filePath)}: ${(newSize / 1024 / 1024).toFixed(2)} MB (saved ${delta} MB)`);
});
