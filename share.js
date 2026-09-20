// share.js — SSH tunnel via serveo.net with active health-check & auto-reconnect
'use strict';
require('dotenv').config();
const { execSync, spawn } = require('child_process');
const fs    = require('fs');
const http  = require('http');
const https = require('https');

const PORT        = process.env.PORT || 3000;
const TOKENS_FILE = './invite_tokens.json';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForServer(port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('Server did not start in time'));
        setTimeout(attempt, 200);
      });
      req.setTimeout(500, () => { req.destroy(); });
    };
    attempt();
  });
}

function killAll(pattern) {
  try { execSync(`pkill -f "${pattern}" 2>/dev/null`); } catch {}
}

/** Check if public URL is alive (resolves true/false) */
function checkUrl(url) {
  return new Promise(resolve => {
    try {
      const req = https.get(url, { timeout: 5000 }, res => { res.resume(); resolve(res.statusCode < 600); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

function openTunnel() {
  return new Promise((resolve, reject) => {
    const ssh = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=10',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=15',
      '-R', `80:localhost:${PORT}`,
      'nokey@localhost.run',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { ssh.kill(); reject(new Error('Tunnel URL not received in 20s')); }
    }, 20000);

    const onData = data => {
      const text  = data.toString();
      // localhost.run returns "domain.lhr.life tunneled with tls termination, https://domain.lhr.life"
      const match = text.match(/https?:\/\/[^\s]+\.lhr\.life/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ url: match[0], proc: ssh });
      }
    };

    ssh.stdout.on('data', onData);
    ssh.stderr.on('data', onData);
    ssh.on('close', code => { clearTimeout(timeout); if (!resolved) reject(new Error(`SSH exited (${code})`)); });
    ssh.on('error', err  => { clearTimeout(timeout); if (!resolved) reject(err); });
  });
}

function printBanner(publicUrl) {
  const config = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  console.log('\n🔗 ══════════════════════════════════════════ 🔗');
  console.log('   🚀  XLOOP IS LIVE');
  console.log('   🌍  Public URL:', publicUrl);
  console.log('🔗 ══════════════════════════════════════════ 🔗');
  console.log('\n  📨 Invite links (send one per member):\n');
  config.members.forEach(m => {
    console.log(`  ${m.name}: ${publicUrl}/?invite=${m.token}`);
  });
  console.log('\n  🛑 Stop sharing : Ctrl+C');
  console.log('  🔒 Disable access: set "enabled": false in invite_tokens.json\n');
}

async function main() {
  killAll('node server.js');
  killAll('ssh.*serveo');
  await sleep(300);

  console.log('⚡ Starting server...');
  const srv = spawn('node', ['server.js'], { stdio: 'inherit' });
  srv.on('exit', code => { if (code) process.exit(code); });

  await waitForServer(PORT);
  console.log('✅ Server ready');

  let tunnel = null;
  let currentUrl = '';
  let reconnecting = false;

  async function connect() {
    if (reconnecting) return;
    reconnecting = true;
    console.log('🌐 Opening SSH tunnel via localhost.run...');
    try {
      tunnel = await openTunnel();
      currentUrl = tunnel.url;
      printBanner(currentUrl);

      tunnel.proc.on('close', async () => {
        if (reconnecting) return;
        console.log('\n⚠️  SSH process closed — reconnecting...');
        await sleep(1500);
        connect().catch(err => { console.error('Reconnect failed:', err.message); process.exit(1); });
      });
    } catch (err) {
      console.error('Initial connect failed:', err.message);
    }
    reconnecting = false;
  }

  await connect();

  // Passive health-check every 30s
  setInterval(async () => {
    if (reconnecting || !currentUrl) return;
    const alive = await checkUrl(currentUrl);
    if (!alive && !reconnecting) {
      // Don't kill it immediately for lhr.life, just log it, as lhr.life might drop pings but keep websocket alive
      console.log('\n⚠️  Health check ping failed, but keeping tunnel open...');
    }
  }, 30000);

  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    if (tunnel && tunnel.proc) tunnel.proc.kill();
    srv.kill();
    process.exit(0);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
