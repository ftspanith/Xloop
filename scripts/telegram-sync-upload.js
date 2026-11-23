#!/usr/bin/env node
'use strict';

// Termux-only Telegram export sync. Uploads extracted links in small batches.
// Requires the local dry-run parser helper created during the export validation.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { readExport, extractLinksFromMessages } = require('../.telegram-import-dry-run.js');

const EXPORT_DIR = path.resolve(__dirname, '../../Xloop-local-safe');
const EXPECTED = { account1: 37455, account2: 32216, total: 69671 };
const CHUNK_SIZE = 300;

function comparableUrl(value) {
  const raw = String(value || '').trim().replace(/^http:\/\//i, 'https://');
  try {
    const parsed = new URL(raw);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return raw;
  }
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, value => { rl.close(); resolve(value.trim()); });
  });
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      return ask(question + ' (input hidden mode unavailable): ').then(resolve, reject);
    }
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    let value = '';
    const onData = chunk => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          reject(new Error('Cancelled.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on('data', onData);
  });
}

async function requestJson(base, route, token, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || ('HTTP ' + response.status));
  return data;
}

async function main() {
  const file1 = path.join(EXPORT_DIR, 'telegram_export.json');
  const file2 = path.join(EXPORT_DIR, 'telegram_export_2.json');
  for (const file of [file1, file2]) {
    if (!fs.existsSync(file)) throw new Error('Missing export: ' + file);
  }

  console.log('[1/4] Parsing latest Account 1 export...');
  const export1 = readExport(file1, '1');
  const parsed1 = extractLinksFromMessages(export1.messages, '1');
  const account1 = parsed1.links.map(link => ({ ...link, sourceAccount: '1' }));
  console.log('Account 1 extracted:', account1.length.toLocaleString());

  console.log('[2/4] Parsing latest Account 2 export and removing cross-account duplicates...');
  const export2 = readExport(file2, '2');
  const parsed2 = extractLinksFromMessages(export2.messages, '2');
  const seen = new Set(account1.map(link => comparableUrl(link.url)));
  const account2 = [];
  for (const link of parsed2.links) {
    const key = comparableUrl(link.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    account2.push({ ...link, sourceAccount: '2' });
  }
  const links = account1.concat(account2);
  console.log('Account 2 unique additions:', account2.length.toLocaleString());
  console.log('Combined unique total:', links.length.toLocaleString());

  if (account1.length !== EXPECTED.account1 ||
      account2.length !== EXPECTED.account2 ||
      links.length !== EXPECTED.total) {
    throw new Error(
      'Export counts changed. Expected A1=' + EXPECTED.account1 +
      ', A2=' + EXPECTED.account2 + ', total=' + EXPECTED.total +
      '; got A1=' + account1.length + ', A2=' + account2.length +
      ', total=' + links.length + '. Nothing uploaded.'
    );
  }

  const baseInput = process.env.XLOOP_API_BASE ||
    await ask('Xloop site base URL (e.g. https://your-site.vercel.app): ');
  const base = baseInput.replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/i.test(base)) throw new Error('Use the HTTPS site origin only.');
  const token = process.env.XLOOP_ADMIN_TOKEN || await askHidden('Paste Admin token (hidden): ');
  if (!token) throw new Error('Admin token is required.');

  const current = await requestJson(base, '/api/scrape/telegram-sync/status');
  let syncId;
  if (current.status === 'uploading' &&
      current.expected &&
      current.expected.total === EXPECTED.total &&
      current.expected.account1 === EXPECTED.account1 &&
      current.expected.account2 === EXPECTED.account2) {
    syncId = current.syncId;
    console.log('Resuming existing staged sync:', syncId);
  } else {
    syncId = 'termux_' + Date.now();
    await requestJson(base, '/api/scrape/telegram-sync/start', token, {
      syncId,
      expectedTotal: EXPECTED.total,
      account1Count: EXPECTED.account1,
      account2Count: EXPECTED.account2,
    });
    console.log('Started staged sync:', syncId);
  }

  console.log('[3/4] Uploading in ' + CHUNK_SIZE + '-link batches...');
  const totalChunks = Math.ceil(links.length / CHUNK_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    const chunk = links.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await requestJson(base, '/api/scrape/telegram-sync/chunk', token, { syncId, links: chunk });
        if ((i + 1) % 10 === 0 || i + 1 === totalChunks) {
          const n = result.received || {};
          process.stdout.write(
            '\rChunks ' + (i + 1) + '/' + totalChunks +
            ' | A1 ' + (n.account1 || 0) + ' | A2 ' + (n.account2 || 0) +
            ' | Total ' + (n.total || 0) + '     '
          );
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
      }
    }
    if (lastError) throw new Error('Chunk ' + (i + 1) + ' failed: ' + lastError.message + '. Rerun this script to resume safely.');
  }
  process.stdout.write('\n');

  console.log('[4/4] Verifying staged counts and replacing active collection...');
  const done = await requestJson(base, '/api/scrape/telegram-sync/finalize', token, { syncId });
  console.log('\n[SYNC COMPLETE]');
  console.log('Account 1:', done.counts.account1);
  console.log('Account 2:', done.counts.account2);
  console.log('Total:', done.counts.total);
  console.log('Only the ExtractedLink collection was replaced. No pipeline was started.');
}

main().catch(err => {
  console.error('\n[SYNC STOPPED]', err.message);
  process.exitCode = 1;
});
