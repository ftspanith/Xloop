# Xloop — Termux dual Telegram scrape and direct MongoDB import

This workflow does not call the Vercel deployment. It scrapes both Telegram accounts locally, creates two full JSON exports, validates them, then imports the extracted links directly into MongoDB.

## 1. Termux setup

On Android 16 / Termux:

```bash
pkg update && pkg upgrade -y
pkg install git nodejs-lts nano -y
termux-setup-storage
git clone -b test/mobile-dual-upload https://github.com/ftspanith/Xloop.git
cd Xloop
cp .env.example .env
nano .env
```

Fill the local `.env` with your own Telegram API credentials and session strings for both accounts, plus `MONGODB_URI`. Account 2 must have `TG_CHANNELS_2` set to its comma-separated channel IDs. Account 1 uses the scraper's built-in channel list unless `TG_CHANNELS_1` is configured.

Do not paste API hashes, Telegram session strings, OTPs, or MongoDB connection strings into chat or commit them to Git.

Install the project dependencies without downloading Puppeteer's browser (this workflow does not use Puppeteer):

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --ignore-scripts
```

## 2. Full scrape — both accounts

Run:

```bash
npm run scrape:both:json
```

This runs Account 1 first, then Account 2, each in full-history mode (`--mode=1`). The scraper writes:

- `telegram_export.json` — Account 1
- `telegram_export_2.json` — Account 2

The scraper also writes dated human-readable copies into Termux's home Downloads folder when available. Do not run the two account scrapers simultaneously; their progress and export files are separate, but sequential execution is gentler on Telegram rate limits.

If Telegram returns FloodWait, leave the process running; the scraper waits for Telegram's requested interval and has per-channel recovery checkpoints.

## 3. Validate first — no database writes

```bash
npm run import:telegram-json
```

This is a dry run. It checks that both exports exist, are full scrapes, have consistent message counts and valid message IDs, then runs the same parser/extraction rules used by the upload workflow. It prints per-account message, unique-message, extracted-link and skipped-message counts. It does not connect to or write to MongoDB.

Review the counts. If either account has zero messages or zero extracted links, stop and investigate rather than applying.

## 4. Direct MongoDB import

Only after reviewing the dry-run output:

```bash
npm run import:telegram-json:apply
```

Before writing, the importer saves the current `extractedlinks` collection to a timestamped local JSON backup.

Import behavior:
- Account 1: refreshes/upserts the newly scraped Account 1 URLs and removes stale records tagged as Account 1 only after the new records have been written successfully.
- Account 2: inserts only URLs not already present, preserving Account 1's copy when the same URL appears in both accounts.
- Legacy records without an account tag are preserved.
- The `extracted_links` PipelineCache count is updated for the existing Skip Scraper / pipeline flow.

The importer never drops the collection. Keep the generated backup file until the database and Xloop admin views are verified.

## 5. Verify

After import, check the printed MongoDB total and the backup filename. Then verify Xloop's Content Manager and Skip Scraper path after a deployment is available. The JSON files and backup remain local to Termux unless you manually copy them elsewhere.

## Notes

- Use a MongoDB database user with read/write access only to the Xloop database.
- Restrict MongoDB Atlas Network Access to your current IP where practical; do not use an unrestricted public rule just for convenience.
- Keep both JSON exports and the backup until the final verification is complete.
- This branch is a test branch. Do not merge it to `main` without explicit approval.
