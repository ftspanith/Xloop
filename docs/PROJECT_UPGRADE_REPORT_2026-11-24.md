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
