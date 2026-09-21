const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const isVercel = !!process.env.VERCEL;
const getPath = (file) => isVercel ? path.join('/tmp', file) : path.join(__dirname, file);

const runCommand = (cmd, name, opts = {}) => {
  return new Promise((resolve, reject) => {
    console.log(`\n🚀 [ORCHESTRATOR] Starting: ${name}`);
    console.log(`----------------------------------------`);
    const child = exec(cmd, { cwd: __dirname, ...opts });

    child.stdout.on('data', data => process.stdout.write(data));
    child.stderr.on('data', data => process.stderr.write(data));

    child.on('close', (code, signal) => {
      // null code = killed by signal (SIGTERM from stop button or OS)
      // Treat null as success so the pipeline can do cleanup
      const effectiveCode = code ?? 0;
      if (effectiveCode !== 0) {
        console.log(`\n❌ [ORCHESTRATOR] ${name} failed with code ${code}`);
        reject(new Error(`${name} failed`));
      } else {
        if (signal) {
          console.log(`\n⚠️  [ORCHESTRATOR] ${name} exited via signal ${signal} — treating as complete.`);
        } else {
          console.log(`\n✅ [ORCHESTRATOR] ${name} completed successfully.`);
        }
        resolve();
      }
    });

    child.on('error', err => {
      console.error(`\n❌ [ORCHESTRATOR] ${name} spawn error:`, err.message);
      reject(err);
    });
  });
};

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=')];
  })
);

async function startOrchestrator() {
  console.log('🤖 Starting Xloop Master Orchestrator...');

  try {
    // Step 0: Scrape Telegram
    if ('skip-scraper' in args) {
      console.log('⏭️ [ORCHESTRATOR] Skipping Telegram Scraper (Manual Mode)');
    } else {
      let scrapeCmd = args['start-date'] ? 'node scrape_api.js --mode=3' : 'node scrape_api.js --mode=1';
      if (args['start-date']) scrapeCmd += ` --start-date=${args['start-date']}`;
      if (args['end-date'])   scrapeCmd += ` --end-date=${args['end-date']}`;
      if (args['channels'])   scrapeCmd += ` --channels=${args['channels']}`;
      else                    scrapeCmd += ` --channels=all`;
      
      await runCommand(scrapeCmd, 'Telegram Scraper');
    }

    // Step 1: Extract Links
    if (fs.existsSync(path.join(__dirname, 'telegram_export.json'))) {
      await runCommand('node extract_links.js', 'Link Extraction');
    } else {
      console.log('⚠️ [ORCHESTRATOR] telegram_export.json not found, skipping extraction.');
    }

    // Step 2: Bypass Links (DISABLED PER USER REQUEST - IMPORT DIRECTLY)
    if (fs.existsSync(getPath('links_for_bypasser.json'))) {
      const data = fs.readFileSync(getPath('links_for_bypasser.json'), 'utf8');
      const parsed = JSON.parse(data);
      if (parsed.length > 0) {
        console.log('⏭️ [ORCHESTRATOR] Bypasser disabled. Skipping Telegram Bot bypass and importing links directly as requested.');
        // Copy the links to the expected bypassed file name so the importer can pick them up
        fs.writeFileSync(getPath('bypassed_links.json'), data);
      } else {
        console.log('⚠️ [ORCHESTRATOR] No links to bypass, skipping bypasser.');
      }
    } else {
      console.log('⚠️ [ORCHESTRATOR] links_for_bypasser.json not found.');
    }

    // Step 3: Import Bypassed Links
    if (fs.existsSync(getPath('bypassed_links.json'))) {
      const data = fs.readFileSync(getPath('bypassed_links.json'), 'utf8');
      const parsed = JSON.parse(data);
      if (parsed.length > 0) {
        // Run importer with extra heap to avoid OOM kills on large datasets
      await runCommand('node --max-old-space-size=512 import_bypassed.js', 'Database Importer');
      } else {
        console.log('⚠️ [ORCHESTRATOR] No bypassed links to import, skipping importer.');
      }
    }

    // Step 4: Heal Database
    await runCommand('node heal_db.js', 'Database Healer');

    // Step 5: Cleanup intermediate files (keep telegram_export.json — it's the source)
    console.log('\n🧹 [ORCHESTRATOR] Cleaning up temporary files...');
    const tempFiles = ['links_for_bypasser.json', 'bypassed_links.json'];
    for (const file of tempFiles) {
      const p = path.join(__dirname, file);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`   Deleted ${file}`);
      }
    }

    console.log('\n🎉 [ORCHESTRATOR] Pipeline finished successfully!');
  } catch (err) {
    console.error('\n💥 [ORCHESTRATOR] Pipeline stopped due to an error:', err.message);
  }
}

startOrchestrator();
