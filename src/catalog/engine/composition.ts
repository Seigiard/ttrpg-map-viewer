import { openLiveSynchronization, startLiveSynchronization, type LiveOptions, type SourceEntry } from "@seigiard/sync-engine";
import { Effect, Semaphore } from "effect";
import { join } from "node:path";
import { log } from "../../logging/index.ts";
import {
  classifyCollection,
  isAnimatedVariant,
  type CategoryNode,
  type FileListing,
  type FolderListing,
  type MapNode,
} from "../classify.ts";
import { loadCoverOverrides, selectMapCover, warnUnknownCoverOverrides } from "../cover.ts";
import { mtimeOrNull, readTextFile, type FileSystemError } from "../file-system.ts";
import { previewPath, thumbnailPath } from "../folder-index.ts";
import { enrichMap, loadMetadataSources, readVariantDimensions } from "../metadata.ts";
import { INDEX_FILE, type CatalogPath, type Classification } from "../model.ts";
import {
  CLASSIFICATION_PROMPT_VERSION,
  classificationCacheKey,
  createClassificationStatus,
  readClassificationCache,
  type ClassificationOptions,
} from "../classification.ts";
import { expectedOutputManifest, pruneOrphans } from "../output-manifest.ts";
import { sourceSignature, type DerivedImageFailure, type DerivedImageKind } from "../thumbnail.ts";
import { handleCatalogWork } from "./handlers.ts";
import { createImageFailureRegistry, type ImageFailureRegistry } from "./image-status.ts";
import { listingFromEntries } from "./listing.ts";
import { catalogStatePath, includeObservableCollectionSource, type SourcePolicyFileSystem } from "./policy.ts";
import {
  CategoryWork,
  ClearWorkFailure,
  FinalizeIndexesWork,
  ImageWork,
  imageWorkKey,
  MapWork,
  SearchWork,
  type CatalogWork,
  workKey,
  workFailureKey,
  type PassContext,
  ClassificationWork,
} from "./work.ts";

export interface CatalogSynchronizationOptions {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly overridesPath: string;
  readonly thumbnailConcurrency: number;
  readonly classification?: ClassificationOptions;
  readonly imageFailures?: ImageFailureRegistry;
  readonly beforeImageWork?: (map: MapNode, variant: FileListing, kind: DerivedImageKind) => Effect.Effect<void>;
  readonly beforeMapIndexWrite?: (map: MapNode, present: ReadonlySet<string>) => Effect.Effect<void>;
  readonly beforeClearWorkFailure?: (failureKey: string) => Effect.Effect<void>;
  readonly onMinimum?: Effect.Effect<void>;
  readonly sourcePolicyFileSystem?: SourcePolicyFileSystem;
  /** Zero disables the engine's periodic reconciliation. */
  readonly reconcileIntervalMs: number;
}

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

function logDiagnostics(listing: FolderListing, maps: readonly MapNode[]): void {
  const archives: string[] = [];
  const pending = [listing];

  for (let folder = pending.pop(); folder; folder = pending.pop()) {
    for (const file of folder.files) {
      if (file.name.toLowerCase().endsWith(".zip")) {
        const path = folder.path === "" ? file.name : `${folder.path}/${file.name}`;
        archives.push(path);
        log.info("Generate", "ZIP archive ignored", { path, size: file.size });
      }
    }

    pending.push(...folder.subfolders);
  }

  const likelyDumps = maps.filter((map) => map.variants.length > 60);

  for (const map of likelyDumps) log.warn("Generate", "Likely dump", { path: map.sourcePath, variants: map.variants.length });
  log.info("Generate", "Collection diagnostics", { zipArchives: archives.length, likelyDumps: likelyDumps.length });
}

function variantSourcePath(map: MapNode, variant: FileListing): string {
  return map.sourcePath === "" ? variant.name : `${map.sourcePath}/${variant.name}`;
}

/**
 * The TTRPG declaration of a live session. The engine owns scanning, scheduling, reconciliation and shutdown;
 * this module only gives the observed source its meaning and says what each index depends on.
 */
function catalogLiveOptions(
  options: CatalogSynchronizationOptions,
): LiveOptions<CatalogWork, FileSystemError | DerivedImageFailure, never> {
  const imageFailures = options.imageFailures ?? createImageFailureRegistry();

  const classification = options.classification
    ? { ...options.classification, status: options.classification.status ?? createClassificationStatus() }
    : undefined;

  let retainedFailureKeys = new Set<string>();
  const pendingStaleFailureKeys = new Set<string>();

  const live: LiveOptions<CatalogWork, FileSystemError | DerivedImageFailure, never> = {
    sourcePath: options.filesPath,
    outputPath: options.dataPath,
    statePath: catalogStatePath(options.dataPath),
    includeSource: (path) => includeObservableCollectionSource(options.filesPath, path, options.sourcePolicyFileSystem),
    reconcileIntervalMs: options.reconcileIntervalMs,
    handle: handleCatalogWork,
    concurrency: options.thumbnailConcurrency,
    onMinimum: options.onMinimum,
    key: workKey,
    failureKey: workFailureKey,
    freshness: {
      describe: (work) => {
        if (!(work instanceof ImageWork)) return undefined;

        if (work.pass.failedInitialMaps.has(work.map.path)) return undefined;

        return {
          sourcePaths: [variantSourcePath(work.map, work.variant)],
          resultKind: "ttrpg-derived-image",
          processingVersion: "2",
          outputPaths: [
            previewPath(work.map.path, work.variant.name),
            `${previewPath(work.map.path, work.variant.name)}.source.json`,
            thumbnailPath(work.map.path, work.variant.name),
            `${thumbnailPath(work.map.path, work.variant.name)}.source.json`,
          ],
        };
      },
    },
    recovery: {
      existing: mtimeOrNull(`${options.dataPath}/${INDEX_FILE}`).pipe(
        Effect.map((mtime) => mtime !== null),
        Effect.catch(() => Effect.succeed(false)),
      ),
    },
    declare: (entries: readonly SourceEntry[], request) =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        const listing = listingFromEntries(entries);

        const { root } = classifyCollection(listing);
        const { categories, maps } = collectNodes(root);

        logDiagnostics(listing, maps);

        const overrides = yield* loadCoverOverrides(options.overridesPath);
        warnUnknownCoverOverrides(maps, overrides);
        const metadata = yield* loadMetadataSources(listing, options.filesPath);
        const dimensions = yield* readVariantDimensions(maps, options.filesPath);
        const passMaps = yield* Effect.forEach(maps, (map) => enrichMap(selectMapCover(map, overrides, dimensions), metadata, dimensions));

        classification?.status.beginPass();
        classification?.status.retain(new Set(passMaps.map((map) => map.path)));
        const classifications = new Map<CatalogPath, Classification>();
        const freshClassificationMaps = new Set<CatalogPath>();

        if (classification) {
          yield* Effect.forEach(passMaps, (map) => {
            if (isAnimatedVariant(map.cover.name)) {
              classification.status.skipAnimatedOnly(map.path);

              return Effect.void;
            }

            const key = classificationCacheKey(map.cover.name, map.cover.size, map.cover.mtimeMs);

            return readClassificationCache(options.dataPath, key).pipe(
              Effect.flatMap((cached) => {
                if (cached?.promptVersion === CLASSIFICATION_PROMPT_VERSION) {
                  classifications.set(map.path, {
                    tags: cached.tags,
                    summary: cached.summary,
                    model: cached.model,
                    promptVersion: cached.promptVersion,
                  });

                  return Effect.void;
                }

                const preview = join(options.dataPath, previewPath(map.path, map.cover.name));
                const expectedSignature = sourceSignature(map.cover.mtimeMs, map.cover.size);

                return Effect.all([
                  mtimeOrNull(preview),
                  readTextFile(`${preview}.source.json`).pipe(Effect.catchTag("FileSystemNotFound", () => Effect.succeed(null))),
                ]).pipe(
                  Effect.map(([previewMtime, previewSignature]) => {
                    if (previewMtime !== null && previewSignature === expectedSignature) freshClassificationMaps.add(map.path);
                  }),
                  Effect.catch(() => Effect.void),
                );
              }),
            );
          });
        }

        const pass: PassContext = {
          filesPath: options.filesPath,
          dataPath: options.dataPath,
          dimensions,
          imageFailures,
          force: request.force,
          beforeImageWork: options.beforeImageWork,
          beforeMapIndexWrite: options.beforeMapIndexWrite,
          categories: new Map(categories.map((category) => [category.path, category])),
          maps: passMaps,
          mapIndexLocks: new Map(),
          refreshLocks: new Map(),
          initialMapWritesRemaining: { count: passMaps.length },
          failedInitialMaps: new Set(),
          classification,
          classifications,
          classificationLock: classification ? Semaphore.makeUnsafe(classification.concurrency ?? 1) : undefined,
        };

        const declaredImageKeys = new Set(
          passMaps.flatMap((map) =>
            map.variants.flatMap((variant) => [
              imageWorkKey(map.path, variant.name, "preview"),
              imageWorkKey(map.path, variant.name, "thumbnail"),
            ]),
          ),
        );

        imageFailures.retain(declaredImageKeys);

        const work =
          passMaps.length === 0
            ? [...categories.map((category) => new CategoryWork({ category, pass })), new SearchWork({ pass })]
            : [
                ...passMaps.map((map) => new MapWork({ map, pass })),
                new FinalizeIndexesWork({ pass }),
                ...passMaps.map((map) => new ImageWork({ map, variant: map.cover, pass })),
                ...passMaps.flatMap((map) =>
                  map.variants.flatMap((variant) => (variant === map.cover ? [] : [new ImageWork({ map, variant, pass })])),
                ),
                ...passMaps.flatMap((map) =>
                  classification && freshClassificationMaps.has(map.path) ? [new ClassificationWork({ map, pass })] : [],
                ),
              ];

        const declaredFailureKeys = new Set(work.map(workFailureKey));

        for (const failureKey of retainedFailureKeys) {
          if (!declaredFailureKeys.has(failureKey)) pendingStaleFailureKeys.add(failureKey);
        }

        const staleFailures = [...pendingStaleFailureKeys].map(
          (failureKey) =>
            new ClearWorkFailure({
              failureKey,
              beforeClear: options.beforeClearWorkFailure,
              onCleared: () => {
                pendingStaleFailureKeys.delete(failureKey);
              },
            }),
        );

        retainedFailureKeys = declaredFailureKeys;

        return {
          minimum: [new CategoryWork({ category: root, pass })],
          work: [...staleFailures, ...work],
          publish: Effect.gen(function* () {
            const manifest = yield* expectedOutputManifest(categories, maps, options.dataPath, options.overridesPath);
            yield* pruneOrphans(options.dataPath, manifest, startedAt);
            yield* Effect.sync(() => log.info("Generate", "Generation finished", { categories: categories.length, maps: maps.length }));
          }),
        };
      }),
  };

  return live;
}

/** The handle returns at once; the caller keeps the Effect scope open. */
export function startCatalogSynchronization(options: CatalogSynchronizationOptions) {
  return startLiveSynchronization(catalogLiveOptions(options));
}

/** Resolves after the first pass finished. */
export function openCatalogSynchronization(options: CatalogSynchronizationOptions) {
  return openLiveSynchronization(catalogLiveOptions(options));
}
