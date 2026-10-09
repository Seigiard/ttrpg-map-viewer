import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { ENGINE_STATE_DIRECTORY } from "../output-manifest.ts";

export interface SourcePolicyFileSystem {
  readonly lstatSync: (path: string) => Stats;
  readonly readdirSync: (path: string) => void;
}

const nodeSourcePolicyFileSystem: SourcePolicyFileSystem = { lstatSync, readdirSync };

/** Hidden collection entries are never catalogued, so the engine state directory cannot collide with a source name. */
function includeCollectionSource(path: string): boolean {
  return !path.split("/").some((name) => name.startsWith("."));
}

export function includeObservableCollectionSource(
  sourcePath: string,
  path: string,
  fileSystem: SourcePolicyFileSystem = nodeSourcePolicyFileSystem,
): boolean {
  if (!includeCollectionSource(path)) return false;

  return classifySourceObservation(sourcePath, path, fileSystem);
}

function classifySourceObservation(sourcePath: string, path: string, fileSystem: SourcePolicyFileSystem): boolean {
  const absolute = join(sourcePath, path);

  try {
    const info = fileSystem.lstatSync(absolute);

    if (info.isDirectory()) fileSystem.readdirSync(absolute);

    return true;
  } catch (error) {
    // SAFETY: Node fs throws Error-like values here; tests inject the same shape plus optional `code`.
    const observedError = error as NodeJS.ErrnoException;

    if (isConfirmedAbsent(observedError)) return false;

    throw new Error(`source:${path}: ${observedError.message}`);
  }
}

function isConfirmedAbsent(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** The state shares DATA's persistence and ownership mount. */
export function catalogStatePath(dataPath: string): string {
  return join(dataPath, ENGINE_STATE_DIRECTORY);
}
