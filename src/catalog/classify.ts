import { type CatalogPath, LOOSE_MAP_SEGMENT, type MapMetadata, type VariantMetadata } from "./model.ts";

const VARIANT_EXTENSIONS: ReadonlySet<string> = new Set(["webp", "jpg", "jpeg", "png", "webm", "mp4"]);

const ANIMATED_VARIANT_EXTENSIONS: ReadonlySet<string> = new Set(["webm", "mp4"]);

export interface FileListing {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly metadata?: VariantMetadata;
}

/** One folder of the collection as found on disk, before any domain meaning is given to it. */
export interface FolderListing {
  readonly name: string;
  readonly path: CatalogPath;
  readonly files: readonly FileListing[];
  readonly subfolders: readonly FolderListing[];
}

export interface MapNode {
  readonly kind: "map";
  readonly name: string;
  /** Collection-relative folder containing this Map's Originals. */
  readonly sourcePath: CatalogPath;
  readonly path: CatalogPath;
  /** Sorted by name; never empty. */
  readonly variants: readonly [FileListing, ...FileListing[]];
  readonly cover: FileListing;
  readonly metadata?: MapMetadata;
}

export interface CategoryNode {
  readonly kind: "category";
  readonly name: string;
  readonly path: CatalogPath;
  readonly categories: readonly CategoryNode[];
  readonly maps: readonly MapNode[];
}

export interface Classification {
  readonly root: CategoryNode;
}

const nameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareNames(a: string, b: string): number {
  return nameCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function isVariantFile(name: string): boolean {
  if (name.startsWith(".")) return false;

  const dot = name.lastIndexOf(".");

  return dot > 0 && VARIANT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function isAnimatedVariant(name: string): boolean {
  const dot = name.lastIndexOf(".");

  return dot > 0 && ANIMATED_VARIANT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function classifyCollection(root: FolderListing): Classification {
  function classifyFolder(folder: FolderListing): CategoryNode | MapNode | null {
    const variants = folder.files.filter((file) => isVariantFile(file.name)).sort((a, b) => compareNames(a.name, b.name));
    const [first, ...rest] = variants;

    if (first) {
      const map: MapNode = {
        kind: "map",
        name: folder.name,
        sourcePath: folder.path,
        path: folder.path,
        variants: [first, ...rest],
        cover: first,
      };

      if (folder.subfolders.length === 0) return map;

      return classifyCategory({ ...folder, files: [] }, { ...map, path: `${folder.path}/${LOOSE_MAP_SEGMENT}` });
    }

    return classifyCategory(folder);
  }

  function classifyCategory(folder: FolderListing, looseMap?: MapNode): CategoryNode | null {
    const categories: CategoryNode[] = [];
    const maps: MapNode[] = [];

    for (const subfolder of [...folder.subfolders].sort((a, b) => compareNames(a.name, b.name))) {
      const node = classifyFolder(subfolder);

      if (node?.kind === "map") maps.push(node);
      else if (node) categories.push(node);
    }

    if (looseMap) maps.unshift(looseMap);

    if (categories.length === 0 && maps.length === 0) return null;

    return { kind: "category", name: folder.name, path: folder.path, categories, maps };
  }

  // The root is always a category, even when empty, so the catalog has a landing page.
  const rootNode = classifyCategory(root) ?? { kind: "category", name: root.name, path: root.path, categories: [], maps: [] };

  return { root: rootNode };
}
