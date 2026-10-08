import { isAnimatedVariant, type CategoryNode, type FileListing, type MapNode } from "./classify.ts";
import { type VariantDimensions, variantKey } from "./metadata.ts";
import type { CatalogPath, CategoryIndex, Cover, MapCard, MapIndex, SearchIndex } from "./model.ts";

/** Leading underscore keeps derived files apart from mirrored folder names, which come from the collection. */
const THUMBNAIL_DIR = "_thumbnails";

const PREVIEW_DIR = "_previews";

/** The full original file name is kept so `a.jpg` and `a.png` in one map never share a thumbnail. */
export function thumbnailPath(mapPath: CatalogPath, variantFile: string): CatalogPath {
  return `${mapPath}/${THUMBNAIL_DIR}/${variantFile}.webp`;
}

/** The full original file name is kept so `a.jpg` and `a.png` in one map never share a preview. */
export function previewPath(mapPath: CatalogPath, variantFile: string): CatalogPath {
  return `${mapPath}/${PREVIEW_DIR}/${variantFile}.webp`;
}

/** Print images use JPEG to reduce the client-side canvas decode and transfer cost. */
export function printImagePath(mapPath: CatalogPath, variantFile: string): CatalogPath {
  return `${mapPath}/_print/${variantFile}.jpg`;
}

/** Answers whether a derived image exists in the output tree. */
export type DerivedImageAvailability = (map: MapNode, variant: FileListing, kind: "thumbnail" | "preview") => boolean;

function coverOf(map: MapNode, hasDerivedImage: DerivedImageAvailability): Cover {
  return {
    variant: map.cover.name,
    thumbnail: hasDerivedImage(map, map.cover, "thumbnail") ? thumbnailPath(map.path, map.cover.name) : null,
  };
}

export function mapIndex(map: MapNode, hasDerivedImage: DerivedImageAvailability, dimensions: VariantDimensions): MapIndex {
  return {
    kind: "map",
    name: map.name,
    path: map.path,
    originalPath: map.sourcePath,
    cover: coverOf(map, hasDerivedImage),
    ...map.metadata,
    variants: map.variants.map((variant) => {
      const dimensionsForVariant = dimensions.get(variantKey(map, variant));

      return {
        file: variant.name,
        size: variant.size,
        ...dimensionsForVariant,
        animated: isAnimatedVariant(variant.name),
        thumbnail: hasDerivedImage(map, variant, "thumbnail") ? thumbnailPath(map.path, variant.name) : null,
        preview: hasDerivedImage(map, variant, "preview") ? previewPath(map.path, variant.name) : null,
        ...variant.metadata,
      };
    }),
  };
}

/** A map's card as its published index states it, so category listings follow what a reader can actually open. */
export function mapCardFromIndex(index: MapIndex): MapCard {
  return {
    name: index.name,
    path: index.path,
    variantCount: index.variants.length,
    cover: index.cover,
    author: index.author,
    tags: index.tags,
    mapSize: index.mapSize,
  };
}

/** Lists the category's own maps that already have a published index. */
export function categoryIndexFromPublished(category: CategoryNode, published: ReadonlyMap<CatalogPath, MapIndex>): CategoryIndex {
  return {
    kind: "category",
    name: category.name,
    path: category.path,
    categories: category.categories.map((child) => ({ name: child.name, path: child.path })),
    maps: category.maps.flatMap((map) => {
      const index = published.get(map.path);

      return index ? [mapCardFromIndex(index)] : [];
    }),
  };
}

export function searchIndexFromPublished(published: readonly MapIndex[]): SearchIndex {
  return {
    maps: published
      .map((index) => ({
        name: index.name,
        path: index.path,
        categoryPath: index.path.split("/").slice(0, -1),
        thumbnail: index.cover.thumbnail,
        variantCount: index.variants.length,
        author: index.author,
        tags: index.tags,
      }))
      .sort((a, b) => a.path.localeCompare(b.path, "en", { sensitivity: "base" })),
  };
}
