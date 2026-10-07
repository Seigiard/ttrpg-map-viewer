// The index.json contract between the generator and the SPA. Browser-importable: no node builtins, no Bun globals.

export const INDEX_FILE = "index.json";

/** Paths are collection-relative, "/"-joined, without leading or trailing slash; the collection root is "". */
export type CatalogPath = string;

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

export interface MapCard {
  readonly name: string;
  readonly path: CatalogPath;
  readonly variantCount: number;
  readonly cover: Cover;
}

export interface Variant {
  /** File name in the map folder; the original lives at the map path plus this name. */
  readonly file: string;
  readonly size: number;
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

export interface MapIndex {
  readonly kind: "map";
  readonly name: string;
  readonly path: CatalogPath;
  /** Collection-relative folder containing the Map's Originals. */
  readonly originalPath: CatalogPath;
  readonly cover: Cover;
  readonly variants: readonly Variant[];
}

export type FolderIndex = CategoryIndex | MapIndex;
