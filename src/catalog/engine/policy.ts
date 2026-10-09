import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { ENGINE_STATE_DIRECTORY } from "../output-manifest.ts";

type UnobservableSourceKind = "directory";

export interface UnobservableSource {
  readonly kind: UnobservableSourceKind;
  readonly message: string;
}

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
  onUnobservable?: (path: string, source: UnobservableSource) => void,
  fileSystem: SourcePolicyFileSystem = nodeSourcePolicyFileSystem,
): boolean {
  if (!includeCollectionSource(path)) return false;

  try {
    const absolute = join(sourcePath, path);
    const info = fileSystem.lstatSync(absolute);

    if (info.isDirectory()) fileSystem.readdirSync(absolute);

    return true;
  } catch (error) {
    // SAFETY: Node fs throws Error-like values here; tests inject the same shape plus optional `code`.
    const observedError = error as NodeJS.ErrnoException;

    try {
      const absolute = join(sourcePath, path);
      const info = fileSystem.lstatSync(absolute);

      if (info.isDirectory()) onUnobservable?.(path, { kind: "directory", message: observedError.message });
    } catch (retryError) {
      // SAFETY: Node fs throws Error-like values here; tests inject the same shape plus optional `code`.
      const observedRetryError = retryError as NodeJS.ErrnoException;

      if (isAbsent(observedRetryError)) return false;

      onUnobservable?.(path, { kind: "directory", message: observedRetryError.message });
    }

    return false;
  }
}

function isAbsent(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** The state shares DATA's persistence and ownership mount. */
export function catalogStatePath(dataPath: string): string {
  return join(dataPath, ENGINE_STATE_DIRECTORY);
}
