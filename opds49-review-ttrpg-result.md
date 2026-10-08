# TTRPG review fixes final result

## Commits

- `0dc3757` `fix: address shared sync review findings`
- `c684532` `docs: record ttrpg review phase 1`
- `175a263` `fix: pin sync engine 0.5.1`
- This result file is committed in the next commit.

## Engine pin evidence

- `package.json`: `@seigiard/sync-engine` pinned to `0.5.1`.
- `bun.lock`: `@seigiard/sync-engine@0.5.1` integrity is `sha512-dIO+BVc7lw2Ydc+dKCg2TXn7p2hLltwL7AcUMH1wqt1EbhlruO6cPBSL7CdqsnvvAQRFou3kIR6lSsGEQytskA==`.
- `npm view @seigiard/sync-engine@0.5.1 dist.integrity dist.tarball --json` returned the same integrity and registry tarball.
- `npm pack @seigiard/sync-engine@0.5.1` produced shasum `aeb9d387aeafc4f5a58d07578a2f9341d220ca75` and the same integrity.
- Host `node_modules/@seigiard/sync-engine` is version `0.5.1` and `diff -ru` against unpacked `npm pack` returned no diff.
- Production image `ttrpg49-rf2-prod` installs `@seigiard/sync-engine@0.5.1`; `diff -ru /app/node_modules/@seigiard/sync-engine /pack` returned no diff inside the image.

## Finding to test table

| Review finding | Test / evidence | Red calibration | Green evidence |
| --- | --- | --- | --- |
| CI `bun run test` missed the production engine path; retired `generateCatalog` tests kept dead code alive. | `package.json` runs unit tests everywhere and engine tests on Linux; Docker suite runs unit + engine. Retired `generateCatalog`, `scan.ts`, and `test/unit/generate.test.ts` were removed after grep showed only tests imported them. | Config cleanup, not a behavioral red. Pre-review `bun run test` ran only unit tests, including 16 dead `generate.test.ts` tests. | Host `bun run test`: 23 unit tests passed on macOS. Docker full suite: 44 tests passed, including 21 engine tests. |
| One unreadable subfolder failed the pass or pruned prior output. | `an unreadable subfolder keeps its prior output instead of failing or pruning it`; production smoke chmods `Mixed/Inner`, triggers a pass, checks status and prior catalog output. | Initial phase-2 smoke red: status reported `ScanFailed` after chmod-000 subtree. The root cause was `accessSync` accepting the directory while engine `readdir` failed. | Policy now probes directories with `readdirSync`; targeted Docker test passed. Smoke passed: status stayed completed and prior output was served. |
| Cold start category/search waited behind preview work. | `publishes category and search indexes before held preview work finishes`; smoke cold-start holds `Rain.webm` ffmpeg and fetches category/search before release. | Phase 1 red observed before cascade fix: `search index did not appear`. | Targeted Docker and full Docker suite passed. Smoke passed category/search before release. |
| README `THUMBNAIL_CONCURRENCY` wording was stale. | README updated to say it limits synchronization work items, including index writes and image jobs. | Docs-only. | `bun run lint` passed. |
| Image job scheduling key collisions with `:` in map and variant names. | `colon-bearing map and variant names do not collide in image scheduling`. | Temporary mutation to colon-joined `imageWorkKey` failed: expected preview path was `null`. | Shared JSON tuple `imageWorkKey`; targeted and full Docker passed. |
| Forced resync did not bypass image freshness. | `a forced pass recreates derived images even when the stored signature is fresh`. | Temporary mutation to ignore `force` failed: corrupted preview stayed as `not a webp`. | `PassContext.force` reaches `ensureDerivedImage`; targeted and full Docker passed. |
| Image failures for deleted variants/maps were never cleared. | `image failures for deleted variants are cleared after the next successful scan`. | Temporary mutation making `retain()` a no-op failed: `image failure did not clear after variant deletion`. | Registry `retain()` keeps only declared image keys; targeted and full Docker passed. |
| A failed later pass reported `completed=true`. | `a warm source failure remains available and reports pass errors until recovery` asserts `completed=false`. | Old TTRPG expression stayed green on engine `0.5.1`; upstream status no longer reproduced the stale-complete shape. Marked uncalibrated after engine bump. | Runtime still guards `completed` with non-failed state and null pass failure; full Docker passed. |
| `ready` comment claimed every failed initial pass was fatal. | Comment updated in `runtime.ts`. | Comment-only. | `bun run lint` and `bun run typecheck` passed. |
| SIGTERM during first pass exited 1 via rejected readiness. | `stopping during the first pass does not reject readiness`. | Temporary mutation to unconditional `ready.reject(cause)` failed: ready outcome was `rejected`. | Runtime skips `ready.reject` after abort; targeted Docker, full Docker, and smoke graceful stop passed with exit 0. |
| Retired `generateCatalog` pipeline survived only through stale tests. | Production imports no longer reference `generateCatalog` or `scanCollection`; files and stale tests removed. | Structural cleanup, not a behavioral red. | `grep generateCatalog` / `grep scanCollection` returned no files after phase 1; full gates passed. |
| Original-resolution test depended on prior test order. | `every variant in a published map index resolves...` opens its own session. | Temporary removal of the setup failed when selected alone: `index` was `null`. | Targeted and full Docker passed. |
| Same-map republish race test was not calibrated. | Strengthened test records concurrent same-map `MapWork` entry while the first write is held. | Temporary random `MapWork` key failed: `concurrentDuringHold` was `5`, expected `0`. | Real key-based serialization passed targeted and full Docker. |

## Commands and counts

- `bun run fix`: passed.
- `bun run lint`: passed.
- `bun run typecheck`: passed.
- `bun run test`: passed on macOS host: 23 unit tests, 0 failures; engine tests are skipped on non-Linux with an explicit message.
- `bun test tools/sort-dump`: 47 tests, 0 failures.
- `COMPOSE_PROJECT_NAME=ttrpg49-rf2 docker compose -f docker-compose.test.yml run --rm test`: 44 tests, 0 failures. This is 23 unit + 21 engine tests.
- `docker build --target production -t ttrpg49-rf2-prod .`: passed.
- `bash opds49-review-ttrpg-smoke.sh`: `SMOKE_RESULT=PASS`.

Pre-review count comparison from `0578de2` source:

- Pre-review host `bun run test` covered only `test/unit`: 39 unit tests, including 16 retired `generate.test.ts` tests.
- Current host `bun run test` on macOS covers 23 live unit tests and skips engine tests because Linux `flock` is unavailable.
- Current Linux/CI `bun run test` covers unit + engine: 44 tests.
- Pre-review engine files had 15 engine tests; current engine suite has 21 engine tests.
- Sort-dump count is unchanged at 47 tests.

## Production smoke

Image: `ttrpg49-rf2-prod`.

Cases passed:

- Cold start publishes category index and `search.json` while `Rain.webm` preview ffmpeg is held.
- Status becomes available and completed after release.
- SPA, catalog, original, download, map zip, and print-image routes work through nginx on port `18200`.
- Chmod-000 `Mixed/Inner` subtree pass keeps status completed and prior `Mixed/Inner/index.json` served.
- Forced resync completes with available output.
- SIGTERM exits with code 0.

## Open items

- The engine `0.5.1` still has the documented open race where a source entry vanishes between `readdir` and the engine's own `lstat`; this remains a `ScanFailed` engine limitation.
- The TTRPG-side unreadable subtree policy now catches unreadable directories by probing `readdirSync` before engine traversal. It cannot close the post-policy `lstat` race above.
- No `knip` or e2e script/config exists in this repository, so those gates were not run.

## Leftover Docker artifacts

- `ttrpg49-rf2-prod:latest` image, id `7aba15266b1c`.
- `ttrpg49-rf2-test:latest` image, id `233b3254644c`.
- `docker compose -p ttrpg49-rf2 -f docker-compose.test.yml down --remove-orphans` was run. Smoke script removed its own container and volume.
