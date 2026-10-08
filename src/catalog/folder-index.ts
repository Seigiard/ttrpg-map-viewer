import { isAnimatedVariant, type CategoryNode, type FileListing, type MapNode } from "./classify.ts";
import { type VariantDimensions, variantKey } from "./metadata.ts";
import type { CatalogPath, CategoryIndex, Cover, MapIndex, SearchIndex } from "./model.ts";

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

export function categoryIndex(category: CategoryNode, hasDerivedImage: DerivedImageAvailability): CategoryIndex {
  return {
    kind: "category",
    name: category.name,
    path: category.path,
    categories: category.categories.map((child) => ({ name: child.name, path: child.path })),
    maps: category.maps.map((map) => ({
      name: map.name,
      path: map.path,
      variantCount: map.variants.length,
      cover: coverOf(map, hasDerivedImage),
      ...map.metadata,
    })),
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

export function searchIndex(maps: readonly MapNode[], hasDerivedImage: DerivedImageAvailability): SearchIndex {
  return {
    maps: maps
      .map((map) => ({
        name: map.name,
        path: map.path,
        categoryPath: map.path.split("/").slice(0, -1),
        thumbnail: hasDerivedImage(map, map.cover, "thumbnail") ? thumbnailPath(map.path, map.cover.name) : null,
        variantCount: map.variants.length,
        author: map.metadata?.author,
        tags: map.metadata?.tags,
      }))
      .sort((a, b) => a.path.localeCompare(b.path, "en", { sensitivity: "base" })),
  };
}
