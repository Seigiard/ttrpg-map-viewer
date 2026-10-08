// The index.json contract between the generator and the SPA. Browser-importable: no node builtins, no Bun globals.

export const INDEX_FILE = "index.json";

/** Global, compact data for client-side Map search. */
export const SEARCH_FILE = "search.json";

/** Largest image side that Planar may load into a browser canvas. */
export const PRINT_IMAGE_MAX_SIZE = 12_000;

/** Paths are collection-relative, "/"-joined, without leading or trailing slash; the collection root is "". */
export type CatalogPath = string;

/**
 * Last catalog-path segment of the extra map holding a mixed folder's own variants. Hidden collection folders are never
 * scanned, so it cannot clash with a catalogued child folder.
 */
export const LOOSE_MAP_SEGMENT = "._loose";

/** Map extent in grid cells. */
export interface MapSize {
  readonly width: number;
  readonly height: number;
}

export interface MapMetadata {
  readonly author?: string;
  readonly tags?: readonly string[];
  readonly mapSize?: MapSize;
}

export interface VariantMetadata {
  /** Image pixels per grid cell. */
  readonly gridScale?: number;
  /** Grid metadata sources may set this even when it matches the Map's map size. */
  readonly mapSize?: MapSize;
}

export interface Cover {
  /** File name of the variant chosen as the cover. */
  readonly variant: string;
  /** Output-tree-relative path of the cover's thumbnail; null when it could not be made. */
  readonly thumbnail: CatalogPath | null;
}

export interface CategoryCard {
  readonly name: string;
  readonly path: CatalogPath;
}

export interface MapCard extends MapMetadata {
  readonly name: string;
  readonly path: CatalogPath;
  readonly variantCount: number;
  readonly cover: Cover;
}

export interface SearchMap extends Pick<MapMetadata, "author" | "tags"> {
  readonly name: string;
  readonly path: CatalogPath;
  /** Names of the Categories that contain the Map, ordered from the collection root. */
  readonly categoryPath: readonly string[];
  /** Output-tree-relative path of the Cover Thumbnail; null when it could not be made. */
  readonly thumbnail: CatalogPath | null;
  readonly variantCount: number;
}

export interface SearchIndex {
  readonly maps: readonly SearchMap[];
}

export interface Variant extends VariantMetadata {
  /** File name under MapIndex.originalPath. */
  readonly file: string;
  readonly size: number;
  /** Pixel width of the Original, when its image header could be read. */
  readonly width?: number;
  /** Pixel height of the Original, when its image header could be read. */
  readonly height?: number;
  /** Whether the original is a video loop instead of a still image. */
  readonly animated: boolean;
  /** Output-tree-relative path of the variant's thumbnail; null when it could not be made. */
  readonly thumbnail: CatalogPath | null;
  /** Output-tree-relative path of the variant's preview; null when it could not be made. */
  readonly preview: CatalogPath | null;
}

export interface CategoryIndex {
  readonly kind: "category";
  readonly name: string;
  readonly path: CatalogPath;
  readonly categories: readonly CategoryCard[];
  readonly maps: readonly MapCard[];
}

export interface MapIndex extends MapMetadata {
  readonly kind: "map";
  readonly name: string;
  readonly path: CatalogPath;
  /** Collection-relative folder containing the Map's Originals. */
  readonly originalPath: CatalogPath;
  readonly cover: Cover;
  readonly variants: readonly Variant[];
}

export type FolderIndex = CategoryIndex | MapIndex;
