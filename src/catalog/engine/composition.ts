import { openLiveSynchronization, startLiveSynchronization, type LiveOptions, type SourceEntry } from "@seigiard/sync-engine";
import { Effect } from "effect";
import { log } from "../../logging/index.ts";
import { classifyCollection, type CategoryNode, type FileListing, type FolderListing, type MapNode } from "../classify.ts";
import { loadCoverOverrides, warnUnknownCoverOverrides } from "../cover.ts";
import { mtimeOrNull, type FileSystemError } from "../file-system.ts";
import { loadMetadataSources } from "../metadata.ts";
import { INDEX_FILE } from "../model.ts";
import { expectedOutputManifest, pruneOrphans } from "../output-manifest.ts";
import type { DerivedImageKind } from "../thumbnail.ts";
import { handleCatalogWork } from "./handlers.ts";
import { createImageFailureRegistry, type ImageFailureRegistry } from "./image-status.ts";
import { listingFromEntries } from "./listing.ts";
import { catalogStatePath, includeObservableCollectionSource } from "./policy.ts";
import { CategoryWork, ImageWork, imageWorkKey, MapWork, SearchWork, type CatalogWork, workKey, type PassContext } from "./work.ts";

export interface CatalogSynchronizationOptions {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly overridesPath: string;
  readonly thumbnailConcurrency: number;
  readonly imageFailures?: ImageFailureRegistry;
  readonly beforeImageWork?: (map: MapNode, variant: FileListing, kind: DerivedImageKind) => Effect.Effect<void>;
  readonly beforeMapIndexWrite?: (map: MapNode, present: ReadonlySet<string>) => Effect.Effect<void>;
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

/**
 * The TTRPG declaration of a live session. The engine owns scanning, scheduling, reconciliation and shutdown;
 * this module only gives the observed source its meaning and says what each index depends on.
 */
export function catalogLiveOptions(options: CatalogSynchronizationOptions): LiveOptions<CatalogWork, FileSystemError, never> {
  const imageFailures = options.imageFailures ?? createImageFailureRegistry();
  const unobservableSources = new Set<string>();

  return {
    sourcePath: options.filesPath,
    outputPath: options.dataPath,
    statePath: catalogStatePath(options.dataPath),
    includeSource: (path) =>
      includeObservableCollectionSource(options.filesPath, path, (unobservable) => unobservableSources.add(unobservable)),
    reconcileIntervalMs: options.reconcileIntervalMs,
    handle: handleCatalogWork,
    concurrency: options.thumbnailConcurrency,
    key: workKey,
    failureKey: workKey,
    recovery: {
      existing: mtimeOrNull(`${options.dataPath}/${INDEX_FILE}`).pipe(
        Effect.map((mtime) => mtime !== null),
        Effect.catch(() => Effect.succeed(false)),
      ),
    },
    declare: (entries: readonly SourceEntry[], request) =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        const preservePrefixes = [...unobservableSources];
        unobservableSources.clear();
        const listing = listingFromEntries(entries);
        const { root } = classifyCollection(listing);
        const { categories, maps } = collectNodes(root);

        logDiagnostics(listing, maps);

        const overrides = yield* loadCoverOverrides(options.overridesPath);
        warnUnknownCoverOverrides(maps, overrides);
        const metadata = yield* loadMetadataSources(listing, options.filesPath);

        const pass: PassContext = {
          filesPath: options.filesPath,
          dataPath: options.dataPath,
          listing,
          overrides,
          metadata,
          imageFailures,
          force: request.force,
          beforeImageWork: options.beforeImageWork,
          beforeMapIndexWrite: options.beforeMapIndexWrite,
          categories: new Map(categories.map((category) => [category.path, category])),
          maps,
        };

        const declaredImageKeys = new Set(
          maps.flatMap((map) =>
            map.variants.flatMap((variant) => [
              imageWorkKey(map.path, variant.name, "preview"),
              imageWorkKey(map.path, variant.name, "thumbnail"),
            ]),
          ),
        );

        imageFailures.retain(declaredImageKeys);

        return {
          minimum: [new CategoryWork({ category: root, pass })],
          work: [
            ...maps.map((map) => new MapWork({ map, pass, cascadeIndexes: false })),
            ...categories.map((category) => new CategoryWork({ category, pass })),
            new SearchWork({ pass }),
            ...maps.flatMap((map) => [
              new ImageWork({ map, variant: map.cover, kind: "preview", pass }),
              ...map.variants.flatMap((variant) => (variant === map.cover ? [] : [new ImageWork({ map, variant, kind: "preview", pass })])),
            ]),
          ],
          publish: expectedOutputManifest(categories, maps, options.dataPath, options.overridesPath, preservePrefixes).pipe(
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
