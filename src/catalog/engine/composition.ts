import { openLiveSynchronization, startLiveSynchronization, type LiveOptions, type SourceEntry } from "@seigiard/sync-engine";
import { Effect } from "effect";
import { log } from "../../logging/index.ts";
import { classifyCollection, type CategoryNode, type FileListing, type FolderListing, type MapNode } from "../classify.ts";
import { loadCoverOverrides, selectMapCover, warnUnknownCoverOverrides } from "../cover.ts";
import { mtimeOrNull, type FileSystemError } from "../file-system.ts";
import { previewPath, thumbnailPath } from "../folder-index.ts";
import { enrichMap, loadMetadataSources, readVariantDimensions } from "../metadata.ts";
import { INDEX_FILE } from "../model.ts";
import { expectedOutputManifest, pruneOrphans } from "../output-manifest.ts";
import type { DerivedImageFailure, DerivedImageKind } from "../thumbnail.ts";
import { handleCatalogWork } from "./handlers.ts";
import { createImageFailureRegistry, type ImageFailureRegistry } from "./image-status.ts";
import { listingFromEntries } from "./listing.ts";
import { catalogStatePath, includeObservableCollectionSource, type SourcePolicyFileSystem } from "./policy.ts";
import {
  CategoryWork,
  FinalizeIndexesWork,
  ImageWork,
  imageWorkKey,
  MapWork,
  SearchWork,
  type CatalogWork,
  workKey,
  type PassContext,
} from "./work.ts";

export interface CatalogSynchronizationOptions {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly overridesPath: string;
  readonly thumbnailConcurrency: number;
  readonly imageFailures?: ImageFailureRegistry;
  readonly beforeImageWork?: (map: MapNode, variant: FileListing, kind: DerivedImageKind) => Effect.Effect<void>;
  readonly beforeMapIndexWrite?: (map: MapNode, present: ReadonlySet<string>) => Effect.Effect<void>;
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

function orderedVariants(map: MapNode): readonly FileListing[] {
  return [map.cover, ...map.variants.filter((variant) => variant !== map.cover)];
}

/**
 * The TTRPG declaration of a live session. The engine owns scanning, scheduling, reconciliation and shutdown;
 * this module only gives the observed source its meaning and says what each index depends on.
 */
function catalogLiveOptions(
  options: CatalogSynchronizationOptions,
): LiveOptions<CatalogWork, FileSystemError | DerivedImageFailure, never> {
  const imageFailures = options.imageFailures ?? createImageFailureRegistry();

  return {
    sourcePath: options.filesPath,
    outputPath: options.dataPath,
    statePath: catalogStatePath(options.dataPath),
    includeSource: (path) => includeObservableCollectionSource(options.filesPath, path, options.sourcePolicyFileSystem),
    reconcileIntervalMs: options.reconcileIntervalMs,
    handle: handleCatalogWork,
    concurrency: options.thumbnailConcurrency,
    key: workKey,
    failureKey: workKey,
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
        const { categories: allCategories, maps } = collectNodes(root);
        const categories = allCategories;

        logDiagnostics(listing, maps);

        const overrides = yield* loadCoverOverrides(options.overridesPath);
        warnUnknownCoverOverrides(maps, overrides);
        const metadata = yield* loadMetadataSources(listing, options.filesPath);
        const dimensions = yield* readVariantDimensions(maps, options.filesPath);
        const passMaps = yield* Effect.forEach(maps, (map) => enrichMap(selectMapCover(map, overrides, dimensions), metadata, dimensions));

        const pass: PassContext = {
          filesPath: options.filesPath,
          dataPath: options.dataPath,
          dimensions,
          imageFailures,
          force: request.force,
          beforeImageWork: options.beforeImageWork,
          beforeMapIndexWrite: options.beforeMapIndexWrite,
          categories: new Map(allCategories.map((category) => [category.path, category])),
          maps: passMaps,
          mapIndexLocks: new Map(),
          refreshLocks: new Map(),
          initialMapWritesRemaining: { count: passMaps.length },
          failedInitialMaps: new Set(),
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

        return {
          minimum: [new CategoryWork({ category: root, pass })],
          work:
            passMaps.length === 0
              ? [...categories.map((category) => new CategoryWork({ category, pass })), new SearchWork({ pass })]
              : [
                  ...passMaps.map((map) => new MapWork({ map, pass })),
                  new FinalizeIndexesWork({ pass }),
                  ...passMaps.map((map) => new ImageWork({ map, variant: map.cover, pass })),
                  ...passMaps.flatMap((map) =>
                    orderedVariants(map)
                      .filter((variant) => variant !== map.cover)
                      .map((variant) => new ImageWork({ map, variant, pass })),
                  ),
                ],
          publish: expectedOutputManifest(categories, maps, options.dataPath, options.overridesPath).pipe(
            Effect.andThen((manifest) => pruneOrphans(options.dataPath, manifest, startedAt)),
            Effect.tap(() =>
              Effect.sync(() => log.info("Generate", "Generation finished", { categories: categories.length, maps: maps.length })),
            ),
          ),
        };
      }),
  };
}

/** The handle returns at once; the caller keeps the Effect scope open. */
export function startCatalogSynchronization(options: CatalogSynchronizationOptions) {
  return startLiveSynchronization(catalogLiveOptions(options));
}

/** Resolves after the first pass finished. */
export function openCatalogSynchronization(options: CatalogSynchronizationOptions) {
  return openLiveSynchronization(catalogLiveOptions(options));
}
