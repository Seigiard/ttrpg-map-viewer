import { constants, accessSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_STATE_DIRECTORY } from "../output-manifest.ts";

/** Hidden collection entries are never catalogued, so the engine state directory cannot collide with a source name. */
export function includeCollectionSource(path: string): boolean {
  return !path.split("/").some((name) => name.startsWith("."));
}

export function includeObservableCollectionSource(sourcePath: string, path: string, onUnobservable?: (path: string) => void): boolean {
  if (!includeCollectionSource(path)) return false;

  try {
    const absolute = join(sourcePath, path);
    const info = lstatSync(absolute);

    accessSync(absolute, info.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK);

    return true;
  } catch {
    onUnobservable?.(path);

    return false;
  }
}

/** The state shares DATA's persistence and ownership mount. */
export function catalogStatePath(dataPath: string): string {
  return join(dataPath, ENGINE_STATE_DIRECTORY);
}
