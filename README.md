# ttrpg-map-viewer

Static web catalog for a homelab collection of TTRPG battle maps: thumbnails, previews, downloads, and print slicing via Planar.

## Configuration

- `FILES`: read-only Collection root. Default: `./files`.
- `DATA`: generated Catalog root. Default: `./out`.
- `OVERRIDES`: optional JSON file outside the Collection that pins Covers. Default: `/config/overrides.json`. A missing file is ignored. Its shape is `{ "covers": { "<map path>": "<variant file>" } }`.
- `PORT`: Bun listener port. Default: `3000`.
- `THUMBNAIL_CONCURRENCY`: concurrent Preview and Thumbnail jobs. Default: `2`.
