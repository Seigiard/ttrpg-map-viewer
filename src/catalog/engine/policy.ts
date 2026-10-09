import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_STATE_DIRECTORY } from "../output-manifest.ts";

export type UnobservableSourceKind = "directory";

/** Hidden collection entries are never catalogued, so the engine state directory cannot collide with a source name. */
function includeCollectionSource(path: string): boolean {
  return !path.split("/").some((name) => name.startsWith("."));
}

export function includeObservableCollectionSource(
  sourcePath: string,
  path: string,
  onUnobservable?: (path: string, kind: UnobservableSourceKind) => void,
): boolean {
  if (!includeCollectionSource(path)) return false;

  try {
    const absolute = join(sourcePath, path);
    const info = lstatSync(absolute);

    if (info.isDirectory()) readdirSync(absolute);

    return true;
  } catch {
    try {
      const absolute = join(sourcePath, path);
      const info = lstatSync(absolute);

      if (info.isDirectory()) onUnobservable?.(path, "directory");
    } catch {
      // A vanished path is not a preserved directory. Let the next scan observe it if it returns.
    }

    return false;
  }
}

/** The state shares DATA's persistence and ownership mount. */
export function catalogStatePath(dataPath: string): string {
  return join(dataPath, ENGINE_STATE_DIRECTORY);
}
