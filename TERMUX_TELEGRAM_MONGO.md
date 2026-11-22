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

First fill the Telegram API ID and API hash values in the local `.env` for both accounts. Get those credentials from `https://my.telegram.org/apps`. The recovered channel lists are already prefilled in `.env.example`: Account 1 has 20 IDs and Account 2 has the 25 IDs from its historical `TG_CHANNELS_2` allowlist. The four channels visible in the old Account 2 JSON export were only a subset, not the full configured list. Keep or edit those comma-separated IDs as needed. Both `TG_CHANNELS_1` and `TG_CHANNELS_2` are mandatory: the scraper stops if either list is missing or invalid, and it never falls back to a built-in/default channel list.

Do not paste API hashes, Telegram session strings, OTPs, 2-step passwords, or MongoDB connection strings into chat or commit them to Git.

Install dependencies (Puppeteer's browser download is disabled; normal package install scripts remain enabled):

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci
```

## 2. Authenticate both Telegram accounts locally

Run these one at a time:

```bash
npm run telegram:login:1
npm run telegram:login:2
```

Enter each account's phone number, Telegram login code and (if enabled) 2-step verification password in Termux. The helper stores each StringSession in the local `.env` with restricted file permissions and never prints the session string. Do not share that file.

**Security:** `.env` is local-only. It must never be committed or included in a public repository. A session/API credential or database URI that was pushed to a public remote must be treated as compromised: terminate exposed Telegram sessions, rotate/recreate Telegram API credentials as appropriate, rotate the MongoDB password, and clean the Git history after revocation. Making the repository private or deleting `.env` from the latest commit does not revoke leaked credentials.

## 3. Full scrape — both accounts

Run:

```bash
npm run scrape:both:json
```

This runs Account 1 first, then Account 2, each in full-history mode (`--mode=1`). Each account scrapes only the channel/group IDs in its own allowlist (`TG_CHANNELS_1` or `TG_CHANNELS_2`); no other chats are scanned. The scraper writes:

- `telegram_export.json` — Account 1
- `telegram_export_2.json` — Account 2
- `telegram_shortlinks.json` / `telegram_shortlinks_2.json` — detected shortlinks with their original URL and source references; no redirect resolution or bypass.
- `telegram_review.json` / `telegram_review_2.json` — ambiguous messages retained for manual review.
- `telegram_scan_report.json` / `telegram_scan_report_2.json` — per-account scan and classification totals, plus skipped-record reasons.

Promotions are classified inside each main `telegram_export*.json` message record. There is no separate promotions export, and promotion-only records are not imported as download entries; mixed download-plus-promotion messages remain eligible for import.

Each captured message preserves its original `raw_text` and legacy `text`, entity links, button labels/positions, media and webpage-preview metadata, grouped-media ID, forwarded/reply context, sender and available engagement fields. The `classification` field distinguishes download, promotion, mixed, review and other content. Movie/series metadata is stored in `content_metadata`. When a message explicitly replies to another scanned message or belongs to the same Telegram album, only missing descriptive fields (such as title/year/language/season) may be inherited; per-file quality, filenames and URLs are never copied between messages.

Ambiguous links in a mixed message stay in the main export and review sidecar. The MongoDB importer only imports links classified as downloads; promotional and unresolved links are not silently turned into download records.

The scraper also writes dated copies directly into Android's shared `Download` folder (`~/storage/downloads`). Run `termux-setup-storage` and allow the Android storage permission before scraping. It also keeps the canonical `telegram_export.json` / `telegram_export_2.json` files in the Xloop project folder for the importer. Do not run the two account scrapers simultaneously; their progress and export files are separate, but sequential execution is gentler on Telegram rate limits.

If Telegram returns FloodWait, leave the process running; the scraper waits for Telegram's requested interval. If a channel fails, the partial export and checkpoint are saved, the process exits with a partial-completion status, and rerunning the same command retries only the incomplete channel(s).

## 4. Validate first — no database writes

```bash
npm run import:telegram-json
```

This is a dry run. It checks that both exports exist, are full scrapes, have consistent message counts and valid message IDs, then runs the same parser/extraction rules used by the upload workflow. It prints per-account message, unique-message, extracted-link and skipped-message counts. It does not connect to or write to MongoDB.

Review the counts. If either account has zero messages or zero extracted links, stop and investigate rather than applying.

## 5. Direct MongoDB import

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

## 6. Verify

After import, check the printed MongoDB total and the backup filename. Then verify Xloop's Content Manager and Skip Scraper path after a deployment is available. The JSON files and backup remain local to Termux unless you manually copy them elsewhere.

## Notes

- Use a MongoDB database user with read/write access only to the Xloop database.
- Restrict MongoDB Atlas Network Access to your current IP where practical; do not use an unrestricted public rule just for convenience.
- Keep both JSON exports and the backup until the final verification is complete.
- This branch is a test branch. Do not merge it to `main` without explicit approval.
