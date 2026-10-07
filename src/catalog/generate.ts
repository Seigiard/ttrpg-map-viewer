import { Effect } from "effect";
import { join } from "node:path";
import { log } from "../logging/index.ts";
import {
  isAnimatedVariant,
  type CategoryNode,
  classifyCollection,
  type FileListing,
  type FolderListing,
  type MapNode,
} from "./classify.ts";
import { selectMapCovers } from "./cover.ts";
import { readDirectory, removePath, statPath, type FileSystemError, writeTextFileIfChanged } from "./file-system.ts";
import { categoryIndex, mapIndex, previewPath, searchIndex, thumbnailPath, type DerivedImageAvailability } from "./folder-index.ts";
import { type CatalogPath, type FolderIndex, INDEX_FILE, SEARCH_FILE } from "./model.ts";
import { enrichMapMetadata, readVariantDimensions } from "./metadata.ts";
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

interface ZipArchive {
  readonly path: string;
  readonly size: number;
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

function collectZipArchives(root: FolderListing): ZipArchive[] {
  const archives: ZipArchive[] = [];
  const pending = [root];

  for (let folder = pending.pop(); folder; folder = pending.pop()) {
    for (const file of folder.files) {
      if (!file.name.toLowerCase().endsWith(".zip")) continue;

      archives.push({ path: folder.path === "" ? file.name : `${folder.path}/${file.name}`, size: file.size });
    }

    pending.push(...folder.subfolders);
  }

  return archives.sort((a, b) => a.path.localeCompare(b.path, "en", { sensitivity: "base" }));
}

function indexFile(dataPath: string, path: CatalogPath): string {
  return join(dataPath, path, INDEX_FILE);
}

function writeIndex(dataPath: string, index: FolderIndex): Effect.Effect<void, FileSystemError> {
  return writeTextFileIfChanged(indexFile(dataPath, index.path), JSON.stringify(index));
}

function writeSearchIndex(dataPath: string, content: string): Effect.Effect<void, FileSystemError> {
  return writeTextFileIfChanged(join(dataPath, SEARCH_FILE), content);
}

interface OutputManifest {
  readonly paths: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

function expectedOutputManifest(categories: readonly CategoryNode[], maps: readonly MapNode[]): OutputManifest {
  const paths = new Set([
    SEARCH_FILE,
    ...categories.map((category) => join(category.path, INDEX_FILE)),
    ...maps.flatMap((map) => [
      join(map.path, INDEX_FILE),
      ...map.variants.flatMap((variant) => [
        previewPath(map.path, variant.name),
        `${previewPath(map.path, variant.name)}.source.json`,
        thumbnailPath(map.path, variant.name),
        `${thumbnailPath(map.path, variant.name)}.source.json`,
      ]),
    ]),
  ]);

  const directories = new Set<string>();

  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      directories.add(path.slice(0, slash));
    }
  }

  return { paths, directories };
}

function pruneOrphans(dataPath: string, manifest: OutputManifest, relativePath = ""): Effect.Effect<void, FileSystemError> {
  const absolutePath = join(dataPath, relativePath);

  return Effect.gen(function* () {
    const entries = yield* readDirectory(absolutePath);

    yield* Effect.forEach(
      entries,
      (entry) => {
        const childPath = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        const childAbsolutePath = join(dataPath, childPath);

        if (entry.isDirectory()) {
          const hasExpectedChild = manifest.directories.has(childPath);

          return hasExpectedChild ? pruneOrphans(dataPath, manifest, childPath) : removePath(childAbsolutePath);
        }

        return manifest.paths.has(childPath) ? Effect.void : removePath(childAbsolutePath);
      },
      { concurrency: INDEX_WRITE_CONCURRENCY, discard: true },
    );
  });
}

function derivedImageKey(map: MapNode, variant: FileListing, kind: DerivedImageKind): string {
  return `${map.path}\u0000${variant.name}\u0000${kind}`;
}

/**
 * Full one-shot generation: scan the collection, write folder indexes and global search data, then make derived images.
 * Nothing is ever written under `filesPath`.
 */
export function generateCatalog(options: GenerationOptions): Effect.Effect<GenerationSummary, FileSystemError> {
  return Effect.gen(function* () {
    const listing = yield* scanCollection(options.filesPath);
    const { root } = classifyCollection(listing);

    const { categories: unselectedCategories, maps: unselectedMaps } = collectNodes(root);
    const zipArchives = collectZipArchives(listing);
    const likelyDumps = unselectedMaps.filter((map) => map.variants.length > 60);

    for (const archive of zipArchives) log.info("Generate", "ZIP archive ignored", { path: archive.path, size: archive.size });

    for (const map of likelyDumps) log.warn("Generate", "Likely dump", { path: map.sourcePath, variants: map.variants.length });
    log.info("Generate", "Collection diagnostics", { zipArchives: zipArchives.length, likelyDumps: likelyDumps.length });

    const dimensions = yield* readVariantDimensions(unselectedMaps, options.filesPath);
    const selectedMaps = yield* selectMapCovers(unselectedMaps, options.overridesPath, dimensions);
    const maps = yield* enrichMapMetadata(selectedMaps, listing, options.filesPath, dimensions);
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
          const original = join(options.filesPath, map.sourcePath, variant.name);
          const preview = join(options.dataPath, previewPath(map.path, variant.name));
          const thumbnail = join(options.dataPath, thumbnailPath(map.path, variant.name));

          const previewResult = yield* ensureDerivedImage(
            original,
            variant.mtimeMs,
            variant.size,
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

            return yield* ensureDerivedImage(preview, previewStats.mtimeMs, previewStats.size, thumbnail, THUMBNAIL_MAX_SIZE, false);
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

    yield* writeSearchIndex(options.dataPath, JSON.stringify(searchIndex(maps, hasDerivedImage)));

    // An empty scan usually means the collection's mount is missing; pruning then would throw away hours of derived images.
    if (maps.length === 0) log.warn("Generate", "Collection has no maps; keeping existing catalog output", { files: options.filesPath });
    else yield* pruneOrphans(options.dataPath, expectedOutputManifest(categories, maps));

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
