import type { CategoryNode, MapNode } from "./classify.ts";
import type { CatalogPath, CategoryIndex, Cover, MapIndex } from "./model.ts";

/** Leading underscore keeps derived files apart from mirrored folder names, which come from the collection. */
const THUMBNAIL_DIR = "_thumbnails";

/** The full original file name is kept so `a.jpg` and `a.png` in one map never share a thumbnail. */
export function thumbnailPath(mapPath: CatalogPath, variantFile: string): CatalogPath {
  return `${mapPath}/${THUMBNAIL_DIR}/${variantFile}.webp`;
}

/** Answers whether the thumbnail of a map's cover exists in the output tree. */
export type ThumbnailAvailability = (map: MapNode) => boolean;

function coverOf(map: MapNode, hasThumbnail: ThumbnailAvailability): Cover {
  return { variant: map.cover.name, thumbnail: hasThumbnail(map) ? thumbnailPath(map.path, map.cover.name) : null };
}

export function categoryIndex(category: CategoryNode, hasThumbnail: ThumbnailAvailability): CategoryIndex {
  return {
    kind: "category",
    name: category.name,
    path: category.path,
    categories: category.categories.map((child) => ({ name: child.name, path: child.path })),
    maps: category.maps.map((map) => ({
      name: map.name,
      path: map.path,
      variantCount: map.variants.length,
      cover: coverOf(map, hasThumbnail),
    })),
  };
}

export function mapIndex(map: MapNode, hasThumbnail: ThumbnailAvailability): MapIndex {
  return {
    kind: "map",
    name: map.name,
    path: map.path,
    cover: coverOf(map, hasThumbnail),
    variants: map.variants.map((variant) => ({ file: variant.name, size: variant.size })),
  };
}
