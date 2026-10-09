import type { CatalogPath, CategoryCard, CategoryIndex, MapCard } from "../../src/catalog/model.ts";

export type IndexRow =
  | { readonly kind: "category"; readonly card: CategoryCard; readonly depth: number }
  | { readonly kind: "map"; readonly card: MapCard; readonly depth: number };

/**
 * Rows of the index as the reader sees them: each loaded Category lists its Categories, then its Maps, and an open
 * Category's rows follow it one level deeper. An open Category that is not loaded yet shows no rows until it is.
 */
export function visibleRows(
  categories: ReadonlyMap<CatalogPath, CategoryIndex>,
  open: ReadonlySet<CatalogPath>,
  path: CatalogPath = "",
  depth = 0,
): IndexRow[] {
  const index = categories.get(path);

  if (!index) return [];

  const rows: IndexRow[] = [];

  for (const card of index.categories) {
    rows.push({ kind: "category", card, depth });

    if (open.has(card.path)) rows.push(...visibleRows(categories, open, card.path, depth + 1));
  }

  for (const card of index.maps) rows.push({ kind: "map", card, depth });

  return rows;
}

/** Paths of the Categories that contain a path, from the collection root down; the root itself is "". */
export function ancestorPaths(path: CatalogPath): CatalogPath[] {
  if (path === "") return [];

  const segments = path.split("/");

  return segments.map((_, index) => segments.slice(0, index).join("/"));
}
