# Xloop Project Upgrade Report

**Report date:** 24 November 2026  
**Repository:** [ftspanith/Xloop](https://github.com/ftspanith/Xloop)  
**Branch reviewed:** `main`  
**Main HEAD at report time:** `67aa51b57043c009789bc59c409de0d4de80f455`  
**Latest merged upgrade:** [PR #22 — Apply variant intelligence to catalogue download ordering](https://github.com/ftspanith/Xloop/pull/22)

---

## 1. Executive summary

The repository has **22 pull requests numbered #1–#22**:

| GitHub PR state | Count | Meaning |
|---|---:|---|
| Merged into a branch | **19** | Includes the upgrades listed in this report; PR #11 is not merged |
| Open | **2** | PR #6 and PR #11 |
| Open and marked Draft | **1** | PR #6 |
| Closed without merge | **1** | PR #1, superseded by PR #2 |

**Important distinction:** PR #11 is open but is not a Draft PR. It targets `test/xloop-readiness-contracts`, not production `main`. PR #6 is the one currently open Draft PR and targets `main`. PR #1 was historically a Draft but is closed; it is not an active draft. PR #3's old description contains stale “remains Draft” wording, but GitHub records it as merged.

The most important recent change is the separation and connection of the two data stages:

1. Telegram links are extracted and stored in MongoDB's `ExtractedLink` collection.
2. The catalogue importer reads those existing records and creates or enriches entries in the `Movie` collection.

The site **Skip Scraper** option is now connected to the MongoDB-only importer. The latest metadata search engine and variant intelligence are also connected to the catalogue import path.

---

## 2. All upgrades merged into main

The following 19 PRs are merged. PR numbers are listed so each change can be traced to its original review and implementation.

| PR | Upgrade merged into main | Main result |
|---:|---|---|
| [#2](https://github.com/ftspanith/Xloop/pull/2) | Vercel Web Analytics integration | Added the analytics integration across the public and admin HTML pages, with automated page coverage. Live event collection still needs separate dashboard verification. |
| [#3](https://github.com/ftspanith/Xloop/pull/3) | Quick Paste metadata fixes | Improved paste parsing, multi-variant import, size/codec/quality metadata and repeated-message duplicate handling. |
| [#4](https://github.com/ftspanith/Xloop/pull/4) | Video codec and resolution detection | Added regression coverage for formats including AV1, VP9, VP8, HEVC/H.265, AVC/H.264, MPEG, Xvid, DivX, ProRes, Theora and VC-1; extended resolution and container detection. |
| [#5](https://github.com/ftspanith/Xloop/pull/5) | Scraper intelligence and dual-account workflow | Restored the scraper API engine, added sequential Both Accounts scraping/upload, metadata-based variant scoring, close-size review flags and richer file metadata. |
| [#7](https://github.com/ftspanith/Xloop/pull/7) | Mobile navigation, Content Manager and audience search | Improved mobile navigation, admin manager API/error handling, title search, typo tolerance, suggestions, accessibility and reduced-motion behavior. |
| [#8](https://github.com/ftspanith/Xloop/pull/8) | Home mobile menu visibility | Fixed overlay visibility/clickability and added a reduced-motion-aware entrance animation. |
| [#9](https://github.com/ftspanith/Xloop/pull/9) | Home mobile menu viewport positioning | Fixed transformed-containing-block issues so the fixed mobile menu stays attached to the viewport. |
| [#10](https://github.com/ftspanith/Xloop/pull/10) | Live MongoDB Sync Data dashboard | Reads actual `ExtractedLink` records and shows account-tagged, untagged and total link counts plus latest database activity. |
| [#12](https://github.com/ftspanith/Xloop/pull/12) | Safe Termux Telegram sync endpoints | Added authenticated staged chunk upload/finalize endpoints and atomic same-database collection replacement after expected counts verify. The PR did not itself run a production sync. |
| [#13](https://github.com/ftspanith/Xloop/pull/13) | Unified Telegram ingestion and sync-date fix | Uses one extraction engine for website and Termux flows; normalizes URLs, deduplicates messages/links, bounds batches and fixes stale sync dates when legacy account tags are absent. |
| [#14](https://github.com/ftspanith/Xloop/pull/14) | Removed Termux sync monitor UI | Removed the dashboard progress monitor, token-copy action and polling; retained the backend sync endpoints and MongoDB status badges. |
| [#15](https://github.com/ftspanith/Xloop/pull/15) | Global cross-account variant ranking | Combines account links and ranks them by size plus metadata score inside close-size windows, without deleting distinct links. |
| [#16](https://github.com/ftspanith/Xloop/pull/16) | Numeric download-size sorting | Parses TB/GB/MB/KB/bytes numerically; preserves episode/season and quality ordering and keeps unknown sizes last. |
| [#17](https://github.com/ftspanith/Xloop/pull/17) | Provider allowlist for Telegram uploads | Accepts GDFlix, HubCloud and TMBCloud; filters unsupported links both during extraction and server-side upload; protects existing data on an empty approved batch. |
| [#18](https://github.com/ftspanith/Xloop/pull/18) | Upload-only no-wipe behavior | Upload-only runs select the Skip Scraper/import path instead of the full pipeline, protecting the existing catalogue from an unnecessary wipe. |
| [#19](https://github.com/ftspanith/Xloop/pull/19) | Dedicated MongoDB-only catalogue importer | Added `npm run import:db`; reads `ExtractedLink` directly and forces no-wipe, no-bypass and no-heal behavior. |
| [#20](https://github.com/ftspanith/Xloop/pull/20) | Site Skip Scraper connection | Both orchestrator entry points pass the MongoDB-only mode when Skip Scraper is selected. The option no longer relies on stale local export/sidecar files. |
| [#21](https://github.com/ftspanith/Xloop/pull/21) | Latest metadata algorithms connected to importer | Replaced the importer's duplicated legacy title matcher with the shared 14-algorithm TMDB engine; connected IMDb/TMDB hints, shared OMDb, poster fallbacks, season posters and complete filename metadata. |
| [#22](https://github.com/ftspanith/Xloop/pull/22) | Variant intelligence connected to catalogue ordering | Keeps quality-first ordering, then applies metadata-based variant ranking within each quality group and close-size window; preserves every distinct variant. |

**Merged PR total: 19.** PR #1 is not included because it was closed without merge and superseded by PR #2.

---

## 3. Old vs new — functional differences

| Area | Earlier behavior | Current main behavior |
|---|---|---|
| Telegram extraction | Website and CLI paths could use separate parsing/extraction logic. | Shared `utils/telegram-ingestion.js` extraction path is used by website and Termux flows. |
| URL acceptance | More unsupported URLs could reach the upload/import path. | GDFlix, HubCloud and TMBCloud allowlist is applied during extraction and again on server-side upload. |
| Account imports | Account operations could overlap or risk replace/merge ordering problems. | Both-account workflow runs sequentially: Account 1 then Account 2, with merge behavior for the second account. |
| Extracted links vs catalogue | Uploading records to `ExtractedLink` did not by itself populate the site's `Movie` catalogue. | The dedicated importer reads extracted DB records and builds/enriches `Movie` catalogue records. These remain separate collections and stages. |
| Upload-only pipeline | An upload-only operation could trigger the normal full pipeline path and risk wiping catalogue data. | Upload-only is routed to the safe Skip Scraper/import-only path. |
| Skip Scraper button | The UI described a local `telegram_export.json` source; the new importer was not yet wired to both site entry points. | Skip Scraper passes `fromMongoDB: true` and imports directly from MongoDB without scraping, uploading, wiping, bypassing or healing. |
| Dedicated importer | No separate command existed specifically for “MongoDB ExtractedLink → Movie catalogue”. | `npm run import:db` runs `node pipeline_full.js --from-mongodb`; stale local files and sidecars are ignored. |
| Title matching | The pipeline had a duplicated legacy title matcher with fewer candidate variations than the shared implementation. | Importer uses the shared 14-algorithm candidate engine, strict/relaxed matching and TMDB/IMDb ID fast paths. |
| External metadata | Metadata behavior was split across import paths; existing catalogue records were not always enriched. | Shared TMDB and OMDb functions provide title, year, plot, rating, runtime, IMDb ID, genre and poster fallback data; incomplete existing entries can be enriched. |
| Posters and seasons | Show-level and season-level artwork could be conflated or not stored separately. | Main show poster is kept separately; season artwork is stored under `seasonPosters.sN`. OMDb and optional Google image lookup provide fallback paths. |
| Filename metadata | Some parsed technical metadata did not consistently survive all the way into stored downloads. | Quality, size, language, codec, HDR, audio, source, container, bit depth, audio channels, season and episode are carried into importer download records. |
| Download ordering | Size values could be compared as text or inconsistently across units/paths. | Size is normalized numerically; season/episode and quality ordering are preserved. |
| Variant ranking | Cross-account scoring existed in helper/API paths but was not yet applied to catalogue download ordering. | Same-quality catalogue variants are ranked by source/codec/HDR/audio/completeness inside an 8% size window. All distinct variants remain stored. |
| Duplicate handling | Repeated Telegram messages and URLs could create duplicate work or records. | Shared ingestion deduplicates overlapping messages/URLs; catalogue import checks existing content/download links and uses filename, quality, size, codec, language and episode information for grouping. |
| Sync dashboard | Sync status could show an old cached date or incomplete counts. | Dashboard reads live MongoDB counts and timestamps, with fallback handling for legacy records lacking account tags. |
| Mobile/admin UI | Some navigation icons, mobile menu positioning and manager error states were unreliable. | PRs #7–#9 address navigation/overlay behavior and Content Manager search/error handling. |

### Import flow now

```text
Telegram channels / exports
          |
          v
Shared Telegram parser + provider allowlist
          |
          v
MongoDB: ExtractedLink
          |
          +-------------------------------+
          |                               |
          v                               v
Full scrape/upload workflow       MongoDB-only importer
                                  (CLI: npm run import:db)
                                  (Site: Skip Scraper)
                                          |
                                          v
                               Shared 14-algorithm TMDB search
                               IMDb/TMDB ID fast paths
                               Shared OMDb lookup
                               Poster + season poster fallbacks
                               Filename technical metadata
                                          |
                                          v
                                  MongoDB: Movie catalogue
                                          |
                                          v
                             Quality-first variant ordering
                             + cross-account metadata ranking
```

### Skip Scraper safety behavior

When Skip Scraper is selected on the site, the intended mode is:

- Source: MongoDB `ExtractedLink` collection directly.
- Scraping: skipped.
- Uploading: skipped.
- Catalogue wipe: disabled.
- Shortlink bypass: disabled.
- Healer: disabled.
- Empty/no-approved-link source: fail safely rather than clearing the existing catalogue.

This is a catalogue import, not a Telegram sync or a new scrape.

---

## 4. Metadata and variant algorithms now connected

### Title and catalogue metadata

- Shared `utils/tmdbSearch.js` is used by the MongoDB importer and the manual/bulk import path.
- 14 title-candidate algorithms cover title cleanup and variations such as sequel numbers, Roman numerals, “Part” phrasing, subtitle stripping and alternate title forms.
- Direct TMDB-ID and IMDb-ID paths are attempted when the source message contains those identifiers.
- Strict and relaxed candidate-scoring phases are available.
- Shared OMDb lookup supplements IMDb ID, rating, plot, duration, year, genre and poster data.
- Existing incomplete catalogue entries can be enriched without replacing already-known metadata.
- TV season artwork is stored separately from the main show poster.

A successful search is not guaranteed for every Telegram title. Unmatched or ambiguous titles can still fall back to a basic title record or remain without full external metadata.

### Per-download technical metadata

The parser/import path now carries these fields:

- Title, year, content type, IMDb ID and TMDB ID hint.
- Quality/resolution and file size.
- Language(s).
- Codec and HDR.
- Audio format and channel layout.
- Release source and container.
- Bit depth.
- Season and episode.
- Provider host and URL.

The Movie download schema includes container, bit depth and audio-channel fields in addition to the existing codec/HDR/audio/source data.

### Cross-account variant intelligence

- The analyzer can flag close-size candidates for review; it does not treat size alone as proof of duplication.
- Catalogue ordering keeps quality tiers first.
- Inside the same quality tier, close-size variants can be reordered using source, codec, HDR, audio and metadata completeness.
- Ranking is advisory/display ordering. It does **not** delete different releases or download links.
- The watch-page sorter separately normalizes mixed file-size units and preserves season/episode order.

---

## 5. Current open work and drafts

| PR | Current state | Target | Scope / note |
|---:|---|---|---|
| [#6 — Mobile admin controls and Content Manager readiness](https://github.com/ftspanith/Xloop/pull/6) | **Open · Draft** | `main` | Restores admin icons, improves small-screen scraper layout and adds Content Manager error/count handling plus replace/merge tests. It has not been merged. Some related mobile/navigation improvements were independently merged in PR #7; this PR's remaining changes should be reviewed against current main before any merge. |
| [#11 — Safe Termux Telegram sync and Admin progress monitor](https://github.com/ftspanith/Xloop/pull/11) | **Open · Not Draft** | `test/xloop-readiness-contracts` | Staged sync proposal using a separate collection, count verification and atomic rename. It targets a test branch, not production main, and the PR states that no database operation has been run. |

Historical PR status notes:

- [PR #1](https://github.com/ftspanith/Xloop/pull/1) was a Draft, then closed without merge because PR #2 superseded it.
- PR #3's description still contains old draft wording, but its actual GitHub state is merged.
- Merged feature branches remain visible on GitHub; a remaining branch by itself is not an open Draft PR.

---

## 6. Validation and deployment status

At the time of this report:

- **Main commit:** `67aa51b57043c009789bc59c409de0d4de80f455`.
- **Vercel:** GitHub commit status reports `success` for the latest main commit.
- **Scraper Intelligence Regression:** passed on the latest main commit, including:
  - `npm ci`
  - `npm run test:scraper-intelligence`
  - `npm run test:video-formats`
  - `npm run test:importer-metadata`
- PR #22 checks also passed for Quick Paste, Video Format Detection and Vercel Analytics HTML coverage.

### Not yet verified by these code changes

- A live MongoDB run of the full `ExtractedLink → Movie` import was **not** performed by PR #19, #20, #21 or #22.
- The actual post-import Movie/Series/Anime dashboard counts and the percentage of records with matched TMDB/IMDb metadata and posters still need a live import and database verification.
- Vercel Analytics integration is present and its HTML regression check passed, but actual production event collection has not been independently verified in the Vercel analytics dashboard.
- PR #12's staged Termux sync endpoints were added safely, but that PR itself did not perform the production sync.

---

## 7. Recommended next steps

1. Review PR #6 against current `main`; decide whether its remaining mobile/admin changes are still needed or already superseded.
2. Keep PR #11 isolated on its test branch until its count assumptions, backup and atomic-swap procedure are independently verified; do not merge it to production `main` just to close the PR.
3. Run one controlled MongoDB-only catalogue import using the site Skip Scraper option (or the CLI command, not both at the same time).
4. Verify Movie/Series/Anime counts, sample titles, poster URLs, season posters, download variants and account/provider counts after import.
5. Check real Vercel Analytics events in the project dashboard.

---

## 8. Source of truth

This report is based on GitHub repository state and PR descriptions available on **24 November 2026**:

- [Xloop repository](https://github.com/ftspanith/Xloop)
- [Main branch](https://github.com/ftspanith/Xloop/tree/main)
- [PR list](https://github.com/ftspanith/Xloop/pulls)
- [PR #12 — Safe Telegram sync](https://github.com/ftspanith/Xloop/pull/12)
- [PR #13 — Unified ingestion](https://github.com/ftspanith/Xloop/pull/13)
- [PR #17 — Provider allowlist](https://github.com/ftspanith/Xloop/pull/17)
- [PR #19 — MongoDB-only importer](https://github.com/ftspanith/Xloop/pull/19)
- [PR #20 — Site Skip Scraper](https://github.com/ftspanith/Xloop/pull/20)
- [PR #21 — Shared metadata engine](https://github.com/ftspanith/Xloop/pull/21)
- [PR #22 — Catalogue variant ranking](https://github.com/ftspanith/Xloop/pull/22)

**Interpretation note:** “Merged” means code was merged to a Git branch. “Vercel success” means the commit's Vercel check reported success. Neither one alone proves a live MongoDB catalogue import has completed successfully.


---

# 9. Project update — 27 November 2026

**This section supplements the original 24 November report.** It records work completed on `main`, the production deployment checked on 27 November, the catalogue state reported/audited after the database clean, and the recovery work still pending. Where the exact cause or result is not proven, it is labelled as unverified.

## 9.1 Latest production code and deployment

Repository: `ftspanith/Xloop`  
Branch: `main`  
Latest checked production commit: `372860452b40c100b08a3596d93a99dec907615a`  
Commit message: `Test safe relocation of misassigned source links`  
Vercel deployment: `dpl_HoKuA3MwmtKBfUXd4aVbwu6Gw9CC`  
Deployment state when checked: `READY`  
Production domain checked: `https://xloop-rose.vercel.app` (also aliased to `xloop-fintech25.vercel.app`)

### Commits added after the 24 November report

| Commit | Change |
|---|---|
| `267d0d2a3e6888f6997e188530dbbe28d4169a9d` | Corrected regex escaping in the multi-title parser helper. |
| `65cde4b4b765eda23c97232363117405f6d73ac7` | Telegram ingestion now splits multi-title messages into separate title blocks before associating download URLs. |
| `f7e3db0e206317450c627ef9999bafb06dfd5e0f` | Added regression tests for multi-title BluRay ISO Telegram messages and separate editions of the same movie. |
| `5262af96ceba061b981bf5675e85530c31a03fe8` | Applied the same multi-title splitting to the manual/bulk import route. |
| `47a08bc96a0aeefa763be77934d749b915aea4d3` | Applied the same splitting to the local JSON fallback in `pipeline_full.js`. |
| `2a0eb18cb8747b541f0cdc4d1101d749c9c949e5` | Merge upload refreshes metadata for an existing URL instead of leaving its old, potentially misassigned title; merge-mode pipeline sidecar uses all available links. |
| `3bd2c53dcafa83e41d5bccdcf4d7c421a980ef1e` | Added exact-URL relocation when a strong TMDB-verified identity proves that a link is stored under the wrong movie record. |
| `372860452b40c100b08a3596d93a99dec907615a` | Added regression coverage confirming exact-URL relocation does not remove other mirrors or sibling variants. |

### Multi-title Telegram message fix

Previously, one Telegram message could contain many blank-line-separated movie filenames and individual download URLs. The ingestion path parsed the entire message once, so all extracted URLs could inherit the first movie title.

The shared `splitMultiTitleMessage` helper in `utils/parser.js` now separates a message when it detects at least two distinct movie title/year identities among file-descriptor lines. The Telegram ingestion path, bulk import route and local pipeline JSON fallback use the same splitter.

Supported descriptor/container examples include `.iso`, `.mkv`, `.mp4`, `.avi`, `.m2ts`, `.mov`, `.ts`, `.zip` and `.rar`, as well as BluRay/BD50/BD25 descriptors. Distinct editions of the same movie remain separate link entries under that movie; they are not treated as separate movies solely because they are different files.

The fix is covered by Telegram ingestion and importer regression tests. It does not retroactively correct already-stored records by itself; the merge metadata-refresh and strong-identity relocation paths address those cases when the source data is reprocessed and verified.

### Safe link metadata reconciliation

- Merge uploads look up existing records by exact URL.
- Incoming non-empty parsed metadata can refresh title, year, filename, quality, size, language, season/episode and technical fields.
- Exact duplicate URLs are not inserted a second time.
- Strong TMDB identity verification is required before moving an exact URL away from a wrong catalogue record.
- Relocation removes only that exact URL from the incorrect record; other mirrors and variants are preserved.
- Regression test added for mirror/variant preservation.

This is intentionally conservative. A fuzzy title mismatch by itself is not enough to move or delete a download.

## 9.2 Scraper and sync workflow

The script `scrape-and-upload.js` supports:

- `--mode=3 --days=N` for a recent date window.
- `--account=both` for sequential Account 1 then Account 2 processing.
- `--merge` to retain earlier extracted-link batches rather than replace them.
- `--upload-only` to reuse existing local Telegram export JSON files without calling the Telegram scraper.
- `--no-pipeline` to upload without automatically triggering the pipeline.

The `account=both` parent workflow launches Account 1 and then Account 2 as child workflows, and the root merge flag is propagated to both children. With merge enabled, the script triggers the Skip Scraper/import-only route after uploads; that route passes `noWipe: true` and reads MongoDB `ExtractedLink` as its source.

### Weekly update command that was discussed

```bash
cd ~/Xloop
node scrape-and-upload.js --mode=3 --days=6 --account=both --merge
```

**Intended effect:** process only the recent six-day window from both Telegram accounts and merge those links into the existing extracted-link source. This is not intended to clear the existing catalogue.

**Execution status:** no successful terminal output proving that this command was run is present in the project handover at the time this report was updated. Do not treat the command as completed merely because it was recommended.

### Existing-export recovery command that was proposed

```bash
cd ~/Xloop
node scrape-and-upload.js --upload-only --account=both --merge
```

**Intended effect:** read the existing local Account 1 and Account 2 export JSON files, re-extract their links, merge them into MongoDB `ExtractedLink`, then run the MongoDB-only importer without wiping the catalogue.

**Status: NOT RUN / NOT VERIFIED.** Preserve the two original export files before any operation. Do not run this command concurrently with another scraper, upload or import session. The result must be checked against counts and sample titles before another weekly incremental update is started.

## 9.3 Existing export files

The two Telegram export files previously reported in the Termux project directory were:

| File | Messages | Approximate size |
|---|---:|---:|
| `telegram_export.json` (Account 1) | 39,925 | 147.9 MB |
| `telegram_export_2.json` (Account 2) | 48,032 | 177.7 MB |
| **Combined** | **87,957** | **325.6 MB** |

These are local source exports, not the same thing as the live MongoDB catalogue. Keep them unchanged as recovery inputs. Their current presence and integrity should be rechecked locally before recovery; the counts above are the last reported values, not a fresh filesystem check.

## 9.4 Catalogue count before clean and database state after clean

The user supplied a screenshot of the website Admin Dashboard showing the catalogue totals before the clean:

| Dashboard metric | Count before clean |
|---|---:|
| Total Movies | 7,701 |
| Total Series | 1,542 |
| Total Anime | 193 |
| **Total Items** | **9,436** |

The total reconciles: 7,701 + 1,542 + 193 = 9,436.

After the clean, a read-only audit of the production MongoDB database and the Termux `.env` URI showed the same Atlas host and database name:

- MongoDB host: `xloop-cluster.5wb5qj3.mongodb.net`
- Database: `xloop`
- The Termux `.env` URI and Vercel production `MONGODB_URI` were confirmed to point to this same host/database.
- Catalogue collections reported by the audit: `movies = 0`, `series = 0`, `episodes = 0`.
- Current `ExtractedLink` collection: **1,759** documents.
- Staging collection `extractedlinks_stage_direct_1795420691013`: **26,500** documents.

**Important:** the 9,436 figure is the pre-clean website dashboard count. The zero counts are the post-clean live catalogue state at the time of the audit. The audit did not establish that the original 9,436 catalogue documents still exist in another live collection.

### What the database clean route does

The current `routes/orchestrator.js` `POST /wipe` route runs deletes against:

- `Movie.deleteMany({})`
- `Series.deleteMany({})`
- `Episode.deleteMany({})`

It also clears selected pipeline-state cache records and temporary pipeline files. Its code comment explicitly preserves the `extracted_links` and `telegram_export` cache keys; the route does not delete the MongoDB `ExtractedLink` source collection.

The current `pipeline_full.js` full-replacement path also has a catalogue deletion step (`Movie.deleteMany({})`) when `NO_WIPE` is false. The MongoDB-only path has a separate explicit `--clean-catalogue` opt-in and otherwise preserves the catalogue. The `routes/import.js` `DELETE /wipe-all` route deletes Movie records.

**Exact incident cause:** the available read-only evidence confirms the catalogue is empty and identifies the destructive code paths, but it does not conclusively identify which exact UI action, endpoint or pipeline invocation caused this clean. Vercel Hobby runtime-log retention did not provide the older request logs needed to prove the exact triggering request. Do not state that the six-day `--merge` command itself caused the clean: the current script source propagates merge mode to both account children and uses the no-wipe importer path for that mode.

### Remaining staging data and mismatch audit

A read-only audit of the 26,500-document staging collection reported:

- 26,500 records with parseable filenames.
- 5,944 unique filename-derived movie identities (heuristic).
- 1,762 title-mismatch candidates at the audit's matching threshold.
- 1,032 strong-mismatch candidates within that candidate set.
- 484 year-mismatch candidates.

These are **heuristic audit candidates**, not confirmed missing movies, not confirmed wrong records, and not a count of lost catalogue titles. Some entries may be bundles, filmographies, alternate-language titles or parser false positives. The current 1,759-document `ExtractedLink` collection also had title-mismatch candidates, including parser false positives. Do not automatically rewrite titles or move links based only on these candidate counts.

A cache record named `bypassed_links` had a reported count of 66,141; it is a count/cache record, not proof that 66,141 complete source documents are available for restoration.

## 9.5 Recovery plan — not yet executed

The safest recovery order is:

1. Preserve both local Telegram export JSON files unchanged and verify their file sizes/message counts.
2. Preserve and snapshot the existing `ExtractedLink` and `extractedlinks_stage_direct_1795420691013` source data before any replacement or import attempt.
3. Confirm no scrape/upload/import pipeline is currently running.
4. Rebuild extracted source links from the existing Account 1 and Account 2 export files using the upload-only merge workflow, or build a separately verified restore set from the preserved staging collection.
5. Run the MongoDB-only importer in its no-wipe mode. Do not use the admin Wipe button, `--clean-catalogue`, `/api/import/wipe-all`, or a full replacement run for this recovery.
6. Verify the restored Movie/Series/Anime dashboard totals, representative titles from each type, download links, seasons/episodes, language and file metadata, before considering the recovery complete.
7. Only after recovery has been validated, run the six-day Account 1 + Account 2 merge update.

**No catalogue restore has been executed by the audit.** The earlier database inspection was read-only. Do not interpret the suggested upload-only command as already run or as a verified restoration.

## 9.6 Other active product issues / requirements raised during this work

These are requirements or open investigations, not all verified fixes:

- **BluRay quality classification:** BD50 and BD25 should classify as BluRay; 1080p BluRay should remain BluRay, not be downgraded to generic HD. BluRay Remux remains its own higher-specificity format/category.
- **Audio display:** show the audio format (for example DD or DDP) and channel layout (2.0, 5.1, 7.1) as separate useful information. Do not invent a channel layout when it is absent.
- **Video metadata:** only show codec/HDR/bit-depth and related technical values when actually detected. Language and file size are common download metadata; missing optional video/audio metadata should remain blank rather than display guessed values.
- **TMDB matching:** a reported example involved “Robo (2010)”/Telugu title metadata being incorrectly matched to an unrelated English film rather than the intended Tamil film `Enthiran` (released in Telugu as `Robo`). Correct regional/alternate-title identity and year validation are important. The exact matching fix for this example is not confirmed in this report.
- **TV/anime downloads:** a reported issue was that show, season, anime pack and individual episode download links were not appearing in some views. This remains an item to verify end-to-end after catalogue recovery.
- **Admin portal responsiveness:** the user reported delayed UI application of clean/add actions and a slow admin portal. No completed fix is confirmed here.
- **Download sorting:** a local `public/js/watch.js` size-sorting change was reported as applied with a successful JavaScript syntax check and a backup file. Its merge/deployment status was not independently confirmed in this handover.

## 9.7 Regression and deployment validation after recent commits

The latest Scraper Intelligence Regression run checked in this session was run `46006242058` for commit `372860452b40c100b08a3596d93a99dec907615a`. All eight listed workflow steps completed successfully:

1. `npm ci`
2. Pipeline safety tests
3. Extracted-link merge tests
4. Scraper intelligence tests
5. Video format tests
6. Importer metadata tests
7. Telegram ingestion tests
8. Metadata search tests

The associated production Vercel deployment was reported as `READY`. This validates the code checks and deployment state; it does **not** prove that the database catalogue was restored or that a fresh live import completed.

A Vercel runtime error group was also observed: `UnhandledRejection: Cannot set headers after they are sent to the client`, route `/server.js`, two occurrences, most recent reported at `2026-11-27T13:26:14Z`. This is a separate runtime issue and is not evidence of the database clean cause.

## 9.8 Operational safety notes

- Never run a full replacement scrape/import when the intention is a small weekly update.
- For weekly changes, use Account 1 + Account 2 with `--merge`.
- For an export-based rebuild, use `--upload-only --account=both --merge` only after preserving/validating both export files and ensuring no other import session is active.
- For catalogue recovery, use MongoDB-only/no-wipe import behavior; do not use destructive wipe/reset endpoints.
- Keep Telegram source links (`ExtractedLink`), staging collections, raw Telegram exports and the Movie/Series/Anime catalogue conceptually separate. A count in one stage is not the count of items in another stage.
- Do not treat filename/title mismatch heuristics as confirmed metadata errors; require stronger identity evidence (TMDB/IMDb/year/alternate title) before moving a download.

**Last updated:** 27 November 2026.  
**This update records the known state at that date; catalogue recovery remains pending and unverified.**
