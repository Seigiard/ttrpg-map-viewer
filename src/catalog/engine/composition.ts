import { openLiveSynchronization, startLiveSynchronization, type LiveOptions, type SourceEntry } from "@seigiard/sync-engine";
import { Effect } from "effect";
import { log } from "../../logging/index.ts";
import { classifyCollection, type CategoryNode, type FolderListing, type MapNode } from "../classify.ts";
import { loadCoverOverrides, warnUnknownCoverOverrides } from "../cover.ts";
import type { FileSystemError } from "../file-system.ts";
import { loadMetadataSources } from "../metadata.ts";
import { expectedOutputManifest, pruneOrphans } from "../output-manifest.ts";
import { handleCatalogWork } from "./handlers.ts";
import { createImageFailureRegistry, type ImageFailureRegistry } from "./image-status.ts";
import { listingFromEntries } from "./listing.ts";
import { catalogStatePath, includeCollectionSource } from "./policy.ts";
import { CategoryWork, ImageWork, MapWork, SearchWork, type CatalogWork, workKey, type PassContext } from "./work.ts";

export interface CatalogSynchronizationOptions {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly overridesPath: string;
  readonly thumbnailConcurrency: number;
  readonly imageFailures?: ImageFailureRegistry;
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

  return {
    sourcePath: options.filesPath,
    outputPath: options.dataPath,
    statePath: catalogStatePath(options.dataPath),
    includeSource: includeCollectionSource,
    reconcileIntervalMs: options.reconcileIntervalMs,
    handle: handleCatalogWork,
    concurrency: options.thumbnailConcurrency,
    key: workKey,
    failureKey: workKey,
    declare: (entries: readonly SourceEntry[]) =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        const listing = listingFromEntries(entries);
        const { root } = classifyCollection(listing);
        const { categories, maps } = collectNodes(root);

        logDiagnostics(listing, maps);

        // The existing catalog stays when a readable collection has no maps (changed deliberately in the production switch).
        if (maps.length === 0) {
          log.warn("Generate", "Collection has no maps; keeping existing catalog output", { files: options.filesPath });

          return { work: [], publish: Effect.void };
        }

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
          categories: new Map(categories.map((category) => [category.path, category])),
          maps,
        };

        return {
          work: [
            ...maps.map((map) => new MapWork({ map, pass })),
            ...maps.flatMap((map) => [
              new ImageWork({ map, variant: map.cover, kind: "preview", pass }),
              ...map.variants.flatMap((variant) => (variant === map.cover ? [] : [new ImageWork({ map, variant, kind: "preview", pass })])),
            ]),
            ...categories.map((category) => new CategoryWork({ category, pass })),
            new SearchWork({ pass }),
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
