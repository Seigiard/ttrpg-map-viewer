import type { SourceEntry } from "@seigiard/sync-engine";
import type { FileListing, FolderListing } from "../classify.ts";
import type { CatalogPath } from "../model.ts";

function parentOf(path: CatalogPath): CatalogPath {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? "" : path.slice(0, slash);
}

function nameOf(path: CatalogPath): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Rebuilds the folder tree the classifier reads from the engine's source observations. */
export function listingFromEntries(entries: readonly SourceEntry[]): FolderListing {
  const children = new Map<CatalogPath, SourceEntry[]>();

  for (const entry of entries) {
    const siblings = children.get(parentOf(entry.path)) ?? [];

    siblings.push(entry);
    children.set(parentOf(entry.path), siblings);
  }

  function folder(path: CatalogPath): FolderListing {
    const siblings = children.get(path) ?? [];

    const files: FileListing[] = siblings
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({ name: nameOf(entry.path), size: entry.size, mtimeMs: entry.mtimeMs }));

    const subfolders = siblings.filter((entry) => entry.kind === "directory").map((entry) => folder(entry.path));

    return { name: nameOf(path), path, files, subfolders };
  }

  return folder("");
}
