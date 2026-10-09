import { Data, Effect, Match } from "effect";
import type { CategoryNode, FileListing, FolderListing, MapNode } from "../classify.ts";
import type { CoverOverrides } from "../cover.ts";
import type { MetadataSources } from "../metadata.ts";
import type { CatalogPath } from "../model.ts";
import type { DerivedImageKind } from "../thumbnail.ts";
import type { ImageFailureRegistry } from "./image-status.ts";

/** What one pass learned from the source observation; work items share it. */
export interface PassContext {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly listing: FolderListing;
  readonly overrides: CoverOverrides;
  readonly metadata: MetadataSources;
  readonly imageFailures: ImageFailureRegistry;
  readonly force: boolean;
  readonly beforeImageWork?: (map: MapNode, variant: FileListing, kind: DerivedImageKind) => Effect.Effect<void>;
  readonly beforeMapIndexWrite?: (map: MapNode, present: ReadonlySet<string>) => Effect.Effect<void>;
  readonly categories: ReadonlyMap<CatalogPath, CategoryNode>;
  readonly maps: readonly MapNode[];
  readonly skippedDirectories: ReadonlySet<CatalogPath>;
  readonly initialMapWritesRemaining: { count: number };
  readonly failedInitialMaps: Set<CatalogPath>;
}

export class MapWork extends Data.TaggedClass("MapWork")<{
  readonly map: MapNode;
  readonly pass: PassContext;
  readonly cascadeIndexes: boolean;
  readonly initial: boolean;
}> {}

export class CategoryWork extends Data.TaggedClass("CategoryWork")<{ readonly category: CategoryNode; readonly pass: PassContext }> {}

export class SearchWork extends Data.TaggedClass("SearchWork")<{ readonly pass: PassContext }> {}

export class FinalizeIndexesWork extends Data.TaggedClass("FinalizeIndexesWork")<{ readonly pass: PassContext }> {}

export class ImageWork extends Data.TaggedClass("ImageWork")<{
  readonly map: MapNode;
  readonly variant: FileListing;
  readonly remaining: readonly FileListing[];
  readonly pass: PassContext;
}> {}

export type CatalogWork = MapWork | CategoryWork | SearchWork | FinalizeIndexesWork | ImageWork;

export function imageWorkKey(mapPath: CatalogPath, variantName: string, kind: DerivedImageKind): string {
  return JSON.stringify(["image", mapPath, variantName, kind]);
}

/** Equal keys combine while pending, so a category or the search index runs once after the maps it depends on. */
export function workKey(work: CatalogWork): string {
  return Match.value(work).pipe(
    Match.tagsExhaustive({
      MapWork: ({ map }) => `map:${map.path}`,
      CategoryWork: ({ category }) => `category:${category.path}`,
      SearchWork: () => "search",
      FinalizeIndexesWork: () => "finalize-indexes",
      ImageWork: ({ map, variant }) => imageWorkKey(map.path, variant.name, "preview"),
    }),
  );
}
