#!/usr/bin/env node
'use strict';

// Create a GramJS StringSession locally and store it in .env.
// The session string is never printed and should never be shared or committed.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const input = require('input');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

function setEnvValue(file, key, value) {
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const pattern = new RegExp('^\\s*' + key + '\\s*=.*$', 'm');
  const line = key + '=' + value;
  if (pattern.test(content)) content = content.replace(pattern, line);
  else content += (content.endsWith('\n') || !content ? '' : '\n') + line + '\n';
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

async function main() {
  const account = process.argv.find(arg => /^--account=/.test(arg));
  const profile = account ? account.split('=')[1] : '1';
  if (!['1', '2'].includes(profile)) throw new Error('Use --account=1 or --account=2.');

  const suffix = profile === '1' ? '' : '_2';
  const apiIdKey = 'TG_API_ID' + suffix;
  const apiHashKey = 'TG_API_HASH' + suffix;
  const sessionKey = 'TG_SESSION' + suffix;
  const apiId = Number(process.env[apiIdKey]);
  const apiHash = process.env[apiHashKey];

  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error(apiIdKey + ' and ' + apiHashKey + ' must be filled in your local .env first.');
  }

  const envPath = path.join(__dirname, '.env');
  console.log('\nXloop Telegram Account ' + profile + ' local sign-in');
  console.log('Your phone number and Telegram verification code stay on this device.');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 1500,
  });

  try {
    await client.start({
      phoneNumber: async () => input.text('Telegram phone number (with country code):'),
      phoneCode: async () => input.text('Telegram login code:'),
      password: async () => input.password('Telegram 2-step verification password (if enabled):'),
      onError: error => console.error('[Telegram login]', error.message || 'Login failed'),
    });

    const session = client.session.save();
    if (!session || session.length < 20) throw new Error('Telegram did not return a valid session string.');

    setEnvValue(envPath, sessionKey, session);
    process.env[sessionKey] = session;
    console.log('\n[OK] Account ' + profile + ' authenticated. Session saved privately in local .env.');
    console.log('Do not share the .env file or its session string.');
  } finally {
    try { await client.disconnect(); } catch (_) {}
  }
}

main().catch(error => {
  console.error('\n[LOGIN FAILED] ' + (error.message || error));
  process.exitCode = 1;
});
