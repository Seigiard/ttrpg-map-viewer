# ttrpg-map-viewer

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues of `Seigiard/ttrpg-map-viewer`, managed via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Architecture

One Docker image: nginx on :80 in front, Bun on 127.0.0.1:3000. Bun runs the shared synchronization engine (`@seigiard/sync-engine`, issue Seigiard/opds-generator#49) against the read-only collection (`FILES`) and writes the catalog into a separate output mirror tree (`DATA`): one `index.json` per category and map, plus a thumbnail and a preview per variant under `<map>/_thumbnails/` and `<map>/_previews/`. The engine owns scans, pass scheduling, watcher requests, reconciliation, image work, first-pass retry and shutdown. TTRPG supplies `declare` (classification) plus handlers for Map indexes, Category indexes, Search, Previews and Thumbnails. The contract between generator and SPA is `src/catalog/model.ts`; it stays browser-importable.

- Map indexes publish before optional derived images finish; handlers reference a thumbnail or preview only after the target exists and the latest image job for that target did not fail. `GET /internal/status` (127.0.0.1 only) reports `available`, `verifying`, `completed`, retained errors and raw engine state. The root `index.json` is the minimum availability marker. A warm failed pass keeps prior output available and reports the pass error; a cold failed pass exits the process. Engine state and the output lease live at `DATA/.sync-engine`.
- Nothing is ever written under `FILES`. Docker mounts it `:ro`.
- nginx routes: `/_app/` SPA assets, `/_catalog/` output tree, `/_original/` collection, `/_download/` attachment downloads, `/_planar/` static Planar export, `/api/` Bun. Every other path is an SPA route that mirrors a folder path and falls back to `index.html`. The prefixes live in `nginx.conf.template` and `ui/app/urls.ts`; change both together.
- `static/` is built by `bun run build:ui` inside the Docker `ui` stage and is not committed.
- Promise crossings in Effect code go through `src/utils/owned-promise.ts`; `catalog/no-direct-effect-promise` (in `tools/oxlint/catalog/`) enforces it. `tools/oxlint/anti-slop/` is vendored: never edit it.

## Finishing a task

Run until clean: `bun run fix`, `bun run lint`, `bun run typecheck`, `bun run test`. `test/engine/` needs Linux `flock`: `bun run test` runs it on Linux, including CI, and skips it elsewhere; on macOS use `bun run test:docker`. After touching nginx, the entrypoint, or the Dockerfile, also build the image and curl it against a small fixture collection.
