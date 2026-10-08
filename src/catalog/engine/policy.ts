import { join } from "node:path";
import { ENGINE_STATE_DIRECTORY } from "../output-manifest.ts";

/** Hidden collection entries are never catalogued, so the engine state directory cannot collide with a source name. */
export function includeCollectionSource(path: string): boolean {
  return !path.split("/").some((name) => name.startsWith("."));
}

/** The state shares DATA's persistence and ownership mount. */
export function catalogStatePath(dataPath: string): string {
  return join(dataPath, ENGINE_STATE_DIRECTORY);
}
