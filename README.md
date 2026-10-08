# ttrpg-map-viewer

Static web catalog for a homelab collection of TTRPG battle maps: thumbnails, previews, downloads, and print slicing via Planar.

## Configuration

- `FILES`: read-only Collection root. Default: `./files`.
- `DATA`: generated Catalog root. Default: `./out`. The generator owns this directory and removes unrecognized output during regeneration.
- `OVERRIDES`: optional JSON file outside both the Collection and `DATA` that pins Covers. Default: `/config/overrides.json`. A missing file is ignored. Its shape is `{ "covers": { "<map path>": "<variant file>" } }`.
- `PORT`: Bun listener port. Default: `3000`.
- `THUMBNAIL_CONCURRENCY`: concurrent Preview and Thumbnail jobs. Default: `2`.
- `REGENERATION_DEBOUNCE_MS`: delay in milliseconds after a watched collection change. Default: `3000`. Range: `0`-`60000`.
- `RECONCILE_INTERVAL`: full regeneration interval in seconds. Default: `1800`. Range: `1`-`86400`.
- `WATCHER_RETRY_SECONDS`: wait before restarting the collection watcher after `inotifywait` exits (for example when `fs.inotify.max_user_watches` is too low). Default: `60`. The periodic reconcile keeps the catalog current meanwhile.
