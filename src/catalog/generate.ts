import { Effect } from "effect";
import { join } from "node:path";
import { log } from "../logging/index.ts";
import { isAnimatedVariant, type CategoryNode, classifyCollection, type FileListing, type MapNode } from "./classify.ts";
import { selectMapCovers } from "./cover.ts";
import { statPath, type FileSystemError, writeFileAtomically } from "./file-system.ts";
import { categoryIndex, mapIndex, previewPath, thumbnailPath, type DerivedImageAvailability } from "./folder-index.ts";
import { type CatalogPath, type FolderIndex, INDEX_FILE } from "./model.ts";
import { scanCollection } from "./scan.ts";
import { ensureDerivedImage, PREVIEW_MAX_SIZE, THUMBNAIL_MAX_SIZE, type DerivedImageKind } from "./thumbnail.ts";

export interface GenerationOptions {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly overridesPath: string;
  readonly thumbnailConcurrency: number;
}

export interface GenerationSummary {
  readonly categories: number;
  readonly maps: number;
  readonly thumbnailsCreated: number;
  readonly thumbnailsFresh: number;
  readonly thumbnailsFailed: number;
  readonly previewsCreated: number;
  readonly previewsFresh: number;
  readonly previewsFailed: number;
}

const INDEX_WRITE_CONCURRENCY = 16;

interface CatalogNodes {
  readonly categories: CategoryNode[];
  readonly maps: MapNode[];
}

interface DerivedImageJob {
  readonly map: MapNode;
  readonly variant: FileListing;
}

function updateCategoryCovers(category: CategoryNode, mapsByPath: ReadonlyMap<string, MapNode>): CategoryNode {
  return {
    ...category,
    categories: category.categories.map((child) => updateCategoryCovers(child, mapsByPath)),
    maps: category.maps.map((map) => mapsByPath.get(map.path) ?? map),
  };
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

function derivedImageKey(map: MapNode, variant: FileListing, kind: DerivedImageKind): string {
  return `${map.path}\u0000${variant.name}\u0000${kind}`;
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

    const { categories: unselectedCategories, maps: unselectedMaps } = collectNodes(root);
    const maps = yield* selectMapCovers(unselectedMaps, options.filesPath, options.overridesPath);
    const mapsByPath = new Map(maps.map((map) => [map.path, map]));
    const categories = unselectedCategories.map((category) => updateCategoryCovers(category, mapsByPath));
    const failedDerivedImages = new Set<string>();
    const hasDerivedImage: DerivedImageAvailability = (map, variant, kind) => !failedDerivedImages.has(derivedImageKey(map, variant, kind));

    const writeAllIndexes = () =>
      Effect.forEach(
        [...categories.map((category) => categoryIndex(category, hasDerivedImage)), ...maps.map((map) => mapIndex(map, hasDerivedImage))],
        (index) => writeIndex(options.dataPath, index),
        { concurrency: INDEX_WRITE_CONCURRENCY, discard: true },
      );

    // Indexes go out before derived images so a first run over a large collection is browsable while they render.
    yield* writeAllIndexes();
    log.info("Generate", "Indexes written", { categories: categories.length, maps: maps.length });

    let created = 0;
    let fresh = 0;
    let previewsCreated = 0;
    let previewsFresh = 0;
    let thumbnailsFailed = 0;
    let previewsFailed = 0;

    // Every cover goes before any other variant so the category grids fill in first on a long first run.
    const jobs: DerivedImageJob[] = [
      ...maps.map((map) => ({ map, variant: map.cover })),
      ...maps.flatMap((map) => map.variants.flatMap((variant) => (variant === map.cover ? [] : [{ map, variant }]))),
    ];

    const recordOutcome = (kind: DerivedImageKind, outcome: "created" | "fresh") => {
      if (kind === "thumbnail") {
        if (outcome === "created") created += 1;
        else fresh += 1;
      } else if (outcome === "created") previewsCreated += 1;
      else previewsFresh += 1;
    };

    const recordFailure = (map: MapNode, variant: FileListing, kind: DerivedImageKind, error: { readonly message: string }) => {
      failedDerivedImages.add(derivedImageKey(map, variant, kind));

      if (kind === "thumbnail") thumbnailsFailed += 1;
      else previewsFailed += 1;
      log.warn("Generate", "Derived image failed", { path: map.path, variant: variant.name, kind, error: error.message });
    };

    yield* Effect.forEach(
      jobs,
      ({ map, variant }) =>
        Effect.gen(function* () {
          const original = join(options.filesPath, map.path, variant.name);
          const preview = join(options.dataPath, previewPath(map.path, variant.name));
          const thumbnail = join(options.dataPath, thumbnailPath(map.path, variant.name));

          const previewResult = yield* ensureDerivedImage(
            original,
            variant.mtimeMs,
            preview,
            PREVIEW_MAX_SIZE,
            isAnimatedVariant(variant.name),
          ).pipe(
            Effect.map((outcome) => ({ ok: true as const, outcome })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );

          if (!previewResult.ok) {
            recordFailure(map, variant, "preview", previewResult.error);
            // Thumbnail has no valid input when Preview rendering fails.
            recordFailure(map, variant, "thumbnail", previewResult.error);

            return;
          }

          recordOutcome("preview", previewResult.outcome);

          const thumbnailResult = yield* Effect.gen(function* () {
            const previewStats = yield* statPath(preview);

            return yield* ensureDerivedImage(preview, previewStats.mtimeMs, thumbnail, THUMBNAIL_MAX_SIZE, false);
          }).pipe(
            Effect.map((outcome) => ({ ok: true as const, outcome })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );

          if (!thumbnailResult.ok) {
            recordFailure(map, variant, "thumbnail", thumbnailResult.error);

            return;
          }

          recordOutcome("thumbnail", thumbnailResult.outcome);
        }),
      { concurrency: options.thumbnailConcurrency, discard: true },
    );

    if (failedDerivedImages.size > 0) yield* writeAllIndexes();

    return {
      categories: categories.length,
      maps: maps.length,
      thumbnailsCreated: created,
      thumbnailsFresh: fresh,
      thumbnailsFailed,
      previewsCreated,
      previewsFresh,
      previewsFailed,
    };
  });
}
