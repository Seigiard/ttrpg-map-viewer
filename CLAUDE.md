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

- Nothing is ever written under `FILES`. Docker mounts it `:ro`.
- nginx routes: `/_app/` SPA assets, `/_catalog/` output tree, `/_original/` collection, `/_download/` attachment downloads, `/_planar/` static Planar export, `/api/` Bun. Every other path is an SPA route that mirrors a folder path and falls back to `index.html`. The prefixes live in `nginx.conf.template` and `ui/app/urls.ts`; change both together.
- `static/` is built by `bun run build:ui` inside the Docker `ui` stage and is not committed.
- Promise crossings in Effect code go through `src/utils/owned-promise.ts`; `catalog/no-direct-effect-promise` (in `tools/oxlint/catalog/`) enforces it. `tools/oxlint/anti-slop/` is vendored: never edit it.

## Finishing a task

Run until clean: `bun run fix`, `bun run lint`, `bun run typecheck`, `bun run test`. After touching nginx, the entrypoint, or the Dockerfile, also build the image and curl it against a small fixture collection.
