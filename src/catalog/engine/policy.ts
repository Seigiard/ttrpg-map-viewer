import { accessSync, constants, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_STATE_DIRECTORY } from "../output-manifest.ts";

export type UnobservableSourceKind = "directory" | "file";

export type SourceObservabilityOverride = (path: string) => UnobservableSourceKind | "observable" | undefined;

/** Hidden collection entries are never catalogued, so the engine state directory cannot collide with a source name. */
export function includeCollectionSource(path: string): boolean {
  return !path.split("/").some((name) => name.startsWith("."));
}

export function includeObservableCollectionSource(
  sourcePath: string,
  path: string,
  onUnobservable?: (path: string, kind: UnobservableSourceKind) => void,
  override?: SourceObservabilityOverride,
): boolean {
  if (!includeCollectionSource(path)) return false;

  const overridden = override?.(path);

  if (overridden === "observable") return true;

  if (overridden === "file") {
    onUnobservable?.(path, overridden);

    return true;
  }

  if (overridden === "directory") {
    onUnobservable?.(path, overridden);

    return false;
  }

  try {
    const absolute = join(sourcePath, path);
    const info = lstatSync(absolute);

    if (info.isDirectory()) readdirSync(absolute);
    else accessSync(absolute, constants.F_OK);

    return true;
  } catch {
    onUnobservable?.(path, "directory");

    return false;
  }
}

/** The state shares DATA's persistence and ownership mount. */
export function catalogStatePath(dataPath: string): string {
  return join(dataPath, ENGINE_STATE_DIRECTORY);
}
