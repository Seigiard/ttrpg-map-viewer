import { Effect } from "effect";
import { join } from "node:path";
import { log } from "../logging/index.ts";
import { type CategoryNode, classifyCollection, type MapNode } from "./classify.ts";
import { type FileSystemError, writeFileAtomically } from "./file-system.ts";
import { categoryIndex, mapIndex, type ThumbnailAvailability, thumbnailPath } from "./folder-index.ts";
import { type CatalogPath, type FolderIndex, INDEX_FILE } from "./model.ts";
import { scanCollection } from "./scan.ts";
import { ensureThumbnail } from "./thumbnail.ts";

export interface GenerationOptions {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly thumbnailConcurrency: number;
}

export interface GenerationSummary {
  readonly categories: number;
  readonly maps: number;
  readonly thumbnailsCreated: number;
  readonly thumbnailsFresh: number;
  readonly thumbnailsFailed: number;
}

const INDEX_WRITE_CONCURRENCY = 16;

interface CatalogNodes {
  readonly categories: CategoryNode[];
  readonly maps: MapNode[];
}

function collectNodes(root: CategoryNode): CatalogNodes {
  const categories: CategoryNode[] = [];
  const maps: MapNode[] = [];
  const pending = [root];

  for (let category = pending.pop(); category; category = pending.pop()) {
    categories.push(category);
    maps.push(...category.maps);
    pending.push(...category.categories);
  }

  return { categories, maps };
}

function indexFile(dataPath: string, path: CatalogPath): string {
  return join(dataPath, path, INDEX_FILE);
}

function writeIndex(dataPath: string, index: FolderIndex): Effect.Effect<void, FileSystemError> {
  return writeFileAtomically(indexFile(dataPath, index.path), JSON.stringify(index));
}

/**
 * Full one-shot generation: scan the collection, write one index.json per category and map, then make cover thumbnails.
 * Nothing is ever written under `filesPath`.
 */
export function generateCatalog(options: GenerationOptions): Effect.Effect<GenerationSummary, FileSystemError> {
  return Effect.gen(function* () {
    const listing = yield* scanCollection(options.filesPath);
    const { root, mixedFolders } = classifyCollection(listing);

    for (const path of mixedFolders) {
      log.warn("Generate", "Folder has variants and subfolders; subfolders are not catalogued yet", { path });
    }

    const { categories, maps } = collectNodes(root);
    const failedThumbnails = new Set<CatalogPath>();
    const hasThumbnail: ThumbnailAvailability = (map) => !failedThumbnails.has(map.path);

    const writeAllIndexes = () =>
      Effect.forEach(
        [...categories.map((category) => categoryIndex(category, hasThumbnail)), ...maps.map((map) => mapIndex(map, hasThumbnail))],
        (index) => writeIndex(options.dataPath, index),
        { concurrency: INDEX_WRITE_CONCURRENCY, discard: true },
      );

    // Indexes go out before thumbnails so a first run over a large collection is browsable while covers render.
    yield* writeAllIndexes();
    log.info("Generate", "Indexes written", { categories: categories.length, maps: maps.length });

    let created = 0;
    let fresh = 0;

    yield* Effect.forEach(
      maps,
      (map) =>
        ensureThumbnail(
          join(options.filesPath, map.path, map.cover.name),
          map.cover.mtimeMs,
          join(options.dataPath, thumbnailPath(map.path, map.cover.name)),
        ).pipe(
          Effect.map((outcome) => {
            if (outcome === "created") created += 1;
            else fresh += 1;
          }),
          Effect.catch((error) => {
            failedThumbnails.add(map.path);
            log.warn("Generate", "Thumbnail failed", { path: map.path, variant: map.cover.name, error: error.message });

            return Effect.void;
          }),
        ),
      { concurrency: options.thumbnailConcurrency, discard: true },
    );

    if (failedThumbnails.size > 0) yield* writeAllIndexes();

    return {
      categories: categories.length,
      maps: maps.length,
      thumbnailsCreated: created,
      thumbnailsFresh: fresh,
      thumbnailsFailed: failedThumbnails.size,
    };
  });
}
