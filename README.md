# ttrpg-map-viewer

Static web catalog for a homelab collection of TTRPG battle maps: thumbnails, previews, downloads, and print slicing via Planar.

## Image

CI publishes `ghcr.io/seigiard/ttrpg-map-viewer` on every push to `main` (`latest` and the short commit SHA) and on `v*` tags. Mount the collection read-only at `/maps` and a writable directory at `/data`; nginx listens on port 80.

## Configuration

- `FILES`: read-only Collection root. Default: `./files`.
- `DATA`: generated Catalog root. Default: `./out`. The generator owns this directory and removes unrecognized output during regeneration.
- `OVERRIDES`: optional JSON file outside both the Collection and `DATA` that pins Covers. Default: `/config/overrides.json`. A missing file is ignored. Its shape is `{ "covers": { "<map path>": "<variant file>" } }`.
- `PORT`: Bun listener port. Default: `3000`.
- `THUMBNAIL_CONCURRENCY`: maximum concurrent synchronization work items, including index writes, Preview/Thumbnail jobs, and classification requests. Default: `2`.
- `ANTHROPIC_API_KEY`: optional key for Claude vision classification. When absent, classification is disabled.
- `CLASSIFY_MODEL`: Anthropic model id. Default: `claude-haiku-5-5`.
- `CLASSIFY_CONCURRENCY`: maximum concurrent classification requests. Default: `2`. Range: `1`-`8`. It can only lower effective classification parallelism below `THUMBNAIL_CONCURRENCY`.
- `CLASSIFY_MAX_CALLS`: optional process-wide hard cap on classification API calls. Default: unlimited.
- `RECONCILE_INTERVAL`: full regeneration interval in seconds. Default: `1800`. Range: `1`-`86400`.
- `WATCHER_RETRY_SECONDS`: wait before restarting the collection watcher after `inotifywait` exits (for example when `fs.inotify.max_user_watches` is too low). Default: `60`. The periodic reconcile keeps the catalog current meanwhile.

## Synchronization

Startup, watcher-triggered regeneration, forced resync, reconciliation and shutdown run through `@seigiard/sync-engine`. The root `index.json` is the minimum availability marker. `GET /internal/status` is local-only and reports availability, verification, completion and retained pass/work errors for operators. If a source entry cannot be observed for a reason other than confirmed absence (`ENOENT` or `ENOTDIR`) during the opening scan of a pass, the pass fails before declaration and leaves prior catalog output untouched until the source is readable again. If a source becomes unobservable after publication, the pass reports the post-publication scan failure; already written output is not rolled back.

Future engine updates should come from the npm registry: update `package.json` to the exact reviewed version, regenerate `bun.lock` with the Bun version pinned by CI, rebuild Docker images without cache, and verify the installed package version and registry integrity before merge.
