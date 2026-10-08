# ttrpg-map-viewer

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues of `Seigiard/ttrpg-map-viewer`, managed via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Architecture

One Docker image: nginx on :80 in front, Bun on 127.0.0.1:3000. Bun runs full generation passes (`src/catalog/generate.ts`, Effect 4) that walk the read-only collection (`FILES`) and write the catalog into a separate output mirror tree (`DATA`): one `index.json` per category and map, plus a thumbnail and a preview per variant under `<map>/_thumbnails/` and `<map>/_previews/`. A pass runs at start, after collection changes (`src/watcher.sh` → inotify → debounced trigger, `src/catalog/regeneration.ts`), and every `RECONCILE_INTERVAL` seconds. A pass skips fresh derived images, rewrites only changed indexes, and prunes orphaned output unless the scan found no maps. The contract between generator and SPA is `src/catalog/model.ts`; it stays browser-importable.

- Two synchronization compositions coexist during the move to the shared engine (`@seigiard/sync-engine`, issue Seigiard/opds-generator#49). The default is the pass above. `SYNC_ENGINE=1` selects `src/catalog/engine/`: the engine owns scan, scheduling, reconciliation and shutdown, and TTRPG supplies `declare` (classification) and the Map, Category and Search handlers that write the JSON indexes. It does no image work yet and references a thumbnail or preview only when that file already exists. `GET /internal/status` (127.0.0.1 only, engine mode) reports pass and work state. Each composition holds the engine's output lease at `DATA/.sync-engine`, so only one writes a `DATA` tree. `REGENERATION_DEBOUNCE_MS` applies to the default pass only.
- Nothing is ever written under `FILES`. Docker mounts it `:ro`.
- nginx routes: `/_app/` SPA assets, `/_catalog/` output tree, `/_original/` collection, `/_download/` attachment downloads, `/_planar/` static Planar export, `/api/` Bun. Every other path is an SPA route that mirrors a folder path and falls back to `index.html`. The prefixes live in `nginx.conf.template` and `ui/app/urls.ts`; change both together.
- `static/` is built by `bun run build:ui` inside the Docker `ui` stage and is not committed.
- Promise crossings in Effect code go through `src/utils/owned-promise.ts`; `catalog/no-direct-effect-promise` (in `tools/oxlint/catalog/`) enforces it. `tools/oxlint/anti-slop/` is vendored: never edit it.

## Finishing a task

Run until clean: `bun run fix`, `bun run lint`, `bun run typecheck`, `bun run test`. `test/engine/` needs Linux `flock`, so it runs only in `bun run test:docker`. After touching nginx, the entrypoint, or the Dockerfile, also build the image and curl it against a small fixture collection.
