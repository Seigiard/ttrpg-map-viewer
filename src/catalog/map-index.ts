import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { MapIndex } from "./model.ts";

export interface CatalogStorage {
  readonly filesPath: string;
  readonly dataPath: string;
}

export function isCatalogPath(path: string, allowRoot = false): boolean {
  if (path === "") return allowRoot;

  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isVariantFile(file: string): boolean {
  return file !== "" && file !== "." && file !== ".." && !file.includes("/") && !file.includes("\\");
}

function isInside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);

  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

/** Reads only a generated Map index and rejects paths that cannot name Originals safely. */
export async function readMapIndex(dataPath: string, path: string): Promise<MapIndex | null> {
  try {
    // SAFETY: index.json is generated against the MapIndex contract; these checks reject a non-Map or invalid paths.
    const index = JSON.parse(await readFile(resolve(dataPath, path, "index.json"), "utf8")) as MapIndex;

    return index.kind === "map" && isCatalogPath(index.originalPath, true) && index.variants.every((variant) => isVariantFile(variant.file))
      ? index
      : null;
  } catch {
    return null;
  }
}

/** Resolves an Original below the real Collection root, rejecting escaping symlinks. */
export async function resolveOriginal(storage: CatalogStorage, index: MapIndex, file: string): Promise<string | null> {
  const collectionRoot = await realpath(storage.filesPath).catch(() => null);

  if (collectionRoot === null) return null;
  const original = await realpath(resolve(collectionRoot, index.originalPath, file)).catch(() => null);

  return original !== null && isInside(collectionRoot, original) ? original : null;
}
