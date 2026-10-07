import type { CatalogPath } from "./model.ts";

/** Still images only; animated variants (webm/mp4) arrive with the map page work. */
const VARIANT_EXTENSIONS: ReadonlySet<string> = new Set(["webp", "jpg", "jpeg", "png"]);

export interface FileListing {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
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
  readonly path: CatalogPath;
  /** Sorted by name; never empty. */
  readonly variants: readonly [FileListing, ...FileListing[]];
  readonly cover: FileListing;
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
  /** Folders whose subfolders were not catalogued because the folder itself is a map. */
  readonly mixedFolders: readonly CatalogPath[];
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

export function classifyCollection(root: FolderListing): Classification {
  const mixedFolders: CatalogPath[] = [];

  function classifyFolder(folder: FolderListing): CategoryNode | MapNode | null {
    const variants = folder.files.filter((file) => isVariantFile(file.name)).sort((a, b) => compareNames(a.name, b.name));
    const [first, ...rest] = variants;

    if (first) {
      if (folder.subfolders.length > 0) mixedFolders.push(folder.path);

      return { kind: "map", name: folder.name, path: folder.path, variants: [first, ...rest], cover: first };
    }

    return classifyCategory(folder);
  }

  function classifyCategory(folder: FolderListing): CategoryNode | null {
    const categories: CategoryNode[] = [];
    const maps: MapNode[] = [];

    for (const subfolder of [...folder.subfolders].sort((a, b) => compareNames(a.name, b.name))) {
      const node = classifyFolder(subfolder);

      if (node?.kind === "map") maps.push(node);
      else if (node) categories.push(node);
    }

    if (categories.length === 0 && maps.length === 0) return null;

    return { kind: "category", name: folder.name, path: folder.path, categories, maps };
  }

  // The root is always a category, even when empty, so the catalog has a landing page.
  const rootNode = classifyCategory(root) ?? { kind: "category", name: root.name, path: root.path, categories: [], maps: [] };

  return { root: rootNode, mixedFolders };
}
