import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { ENGINE_STATE_DIRECTORY } from "../output-manifest.ts";

type UnobservableSourceKind = "directory" | "file";

export interface UnobservableSource {
  readonly kind: UnobservableSourceKind;
  readonly message: string;
}

export interface SourcePolicyFileSystem {
  readonly lstatSync: (path: string) => Stats;
  readonly readdirSync: (path: string) => void;
}

export const nodeSourcePolicyFileSystem: SourcePolicyFileSystem = { lstatSync, readdirSync };

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

  return classifySourceObservation(sourcePath, path, onUnobservable, fileSystem);
}

function classifySourceObservation(
  sourcePath: string,
  path: string,
  onUnobservable: ((path: string, source: UnobservableSource) => void) | undefined,
  fileSystem: SourcePolicyFileSystem,
): boolean {
  const absolute = join(sourcePath, path);

  try {
    const info = fileSystem.lstatSync(absolute);

    if (info.isDirectory()) fileSystem.readdirSync(absolute);

    return true;
  } catch (error) {
    // SAFETY: Node fs throws Error-like values here; tests inject the same shape plus optional `code`.
    const observedError = error as NodeJS.ErrnoException;

    try {
      const info = fileSystem.lstatSync(absolute);

      if (info.isDirectory()) onUnobservable?.(path, { kind: "directory", message: observedError.message });

      return !info.isDirectory();
    } catch (retryError) {
      // SAFETY: Node fs throws Error-like values here; tests inject the same shape plus optional `code`.
      const observedRetryError = retryError as NodeJS.ErrnoException;

      if (isAbsent(observedRetryError)) return false;

      onUnobservable?.(path, { kind: unobservableKindForFailedRetry(path), message: observedRetryError.message });

      return false;
    }
  }
}

function unobservableKindForFailedRetry(path: string): UnobservableSourceKind {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);

  return name.includes(".") ? "file" : "directory";
}

export function isConfirmedAbsent(error: NodeJS.ErrnoException): boolean {
  return isAbsent(error);
}

function isAbsent(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** The state shares DATA's persistence and ownership mount. */
export function catalogStatePath(dataPath: string): string {
  return join(dataPath, ENGINE_STATE_DIRECTORY);
}
