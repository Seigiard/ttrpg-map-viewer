# TTRPG review fixes phase 1

## Commits

- `0dc3757` `fix: address shared sync review findings`

## Verification

- `bun run fix` passed.
- `bun run lint` passed.
- `bun run typecheck` passed.
- `bun test test/unit` passed: 23 tests.
- `docker compose -p ttrpg49-review-fix-phase1 -f docker-compose.test.yml run --rm test bun test test/engine/catalog-repass.test.ts test/engine/catalog-sync.test.ts --timeout 30000` passed: 21 tests.
- Local `bun test test/engine/...` is not valid on macOS because the pinned engine uses Linux `flock`; Docker was used for engine tests.

## Findings

| Finding | Test / oracle | Fix | Red / green |
| --- | --- | --- | --- |
| CI missed the production engine path and stale `generateCatalog` tests kept dead code alive. | `package.json` now runs `test/unit test/engine`; `test/unit` still passes after deleting `generate.test.ts`. Grep showed `generateCatalog` and `scanCollection` were imported only by the removed unit test. | Removed retired `src/catalog/generate.ts`, `src/catalog/scan.ts`, and `test/unit/generate.test.ts`. Updated CI wording and `bun run test`. | Red not separately run against the old tree. Green: unit 23/23 and Docker engine 21/21. |
| Unreadable subfolder failed the pass and could prune prior output. | `an unreadable subfolder keeps its prior output instead of failing or pruning it` checks the real output file and pass status after `chmod 000`. | Added TTRPG source policy that skips hidden, vanished, or inaccessible entries before engine traversal. Preserved existing output prefixes for skipped source paths during pruning. | Red not separately run against the old tree. Green in Docker targeted run. |
| Cold start category/search waited behind previews. | `publishes category and search indexes before held preview work finishes` holds preview work and asserts category/search JSON appears with null thumbnail before release. | Declared map indexes, categories, and search before image work. Initial `MapWork` does not cascade indexes; image-triggered `MapWork` does. | Red observed during implementation before the cascade fix: `search index did not appear`. Green in Docker targeted run. |
| README `THUMBNAIL_CONCURRENCY` was stale. | README text review. | Reworded it as maximum concurrent synchronization work items, including index writes and image jobs. | Docs-only; no runtime red. |
| Image work keys collided on `:`. | `colon-bearing map and variant names do not collide in image scheduling` uses `A/B:C.png` and `A:B/C.png` and checks both previews/thumbnails. | Added shared `imageWorkKey()` with `JSON.stringify` tuple and used it for scheduling and failure status. | Red not separately run against the old tree. Green in Docker targeted run. |
| `force=1` did not bypass image freshness. | `a forced pass recreates derived images even when the stored signature is fresh` corrupts a preview and runs a forced pass. | Passed `request.force` into `PassContext` and `ensureDerivedImage`; force skips the freshness short-circuit. | Red not separately run against the old tree. Green in Docker targeted run. |
| Deleted variants left stale image failures in status. | `image failures for deleted variants are cleared after the next successful scan` creates an image failure, deletes the original, requests a pass, and asserts work errors are empty. | Added `ImageFailureRegistry.retain()` and retain only currently declared image keys per pass. | Red not separately run against the old tree. Green in Docker targeted run. |
| A failed warm pass reported `completed=true`. | Existing `a warm source failure remains available and reports pass errors until recovery` asserts `completed=false`. | `completed` now requires a non-failed live state and no retained pass failure. | Red not separately run against the old tree. Green in Docker targeted run. |
| `ready` comment overstated fatal failures. | Type/comment review. | Updated the readiness comment to say it resolves when usable output is established and rejects only when no output can be served. | Comment-only; no runtime red. |
| SIGTERM during first pass could reject readiness and make `server.ts` exit 1. | `stopping during the first pass does not reject readiness` blocks first image work, stops runtime before `ready`, and asserts readiness does not reject. | Runtime no longer rejects `ready` when the abort controller is already aborted. | Red not separately run against the old tree. Green in Docker targeted run. |
| Original-resolution test depended on a previous test. | `every variant in a published map index resolves...` now opens a session in its own setup. | Added explicit catalog generation inside the test. | Red not separately run against the old tree. Green in Docker targeted run. |

## Open / Not Fixed

- Vanishing files are skipped when they are already absent by the TTRPG `includeSource` policy. A race after the policy and before the engine's own `lstat` can still fail the pass in engine `0.5.0`; the current engine API cannot close that gap from TTRPG without editing the engine.
- The concurrent-publication calibration request did not produce the expected red. Temporary mutation `MapWork: ({ map }) => \`map:${map.path}:${Math.random()}\`` was run against `same-map preview and thumbnail republishes leave the final index with both references`; it passed 5/5 in Docker. This means that test is not proven to fail when same-map key coalescing is removed.
- Immaterial test-only hooks were left in production options. They are still used by the engine tests and removing them was not trivial in this phase.
