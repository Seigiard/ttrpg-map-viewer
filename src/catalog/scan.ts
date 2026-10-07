import { Effect } from "effect";
import { join } from "node:path";
import { log } from "../logging/index.ts";
import type { FileListing, FolderListing } from "./classify.ts";
import { type FileSystemError, readDirectory, statPath } from "./file-system.ts";
import type { CatalogPath } from "./model.ts";

function childPath(parent: CatalogPath, name: string): CatalogPath {
  return parent === "" ? name : `${parent}/${name}`;
}

function listFolder(collectionRoot: string, path: CatalogPath, name: string): Effect.Effect<FolderListing, FileSystemError> {
  return Effect.gen(function* () {
    const absolute = join(collectionRoot, path);
    const entries = yield* readDirectory(absolute);
    const files: FileListing[] = [];
    const subfolders: FolderListing[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      // Symlinks are neither followed nor listed: they could loop or point outside the collection.
      if (entry.isDirectory()) {
        subfolders.push(yield* listSubfolder(collectionRoot, childPath(path, entry.name), entry.name));
      } else if (entry.isFile()) {
        const stats = yield* statPath(join(absolute, entry.name));
        files.push({ name: entry.name, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }

    return { name, path, files, subfolders };
  });
}

/** An unreadable subfolder is logged and left out instead of failing the whole catalog. */
function listSubfolder(collectionRoot: string, path: CatalogPath, name: string): Effect.Effect<FolderListing> {
  return listFolder(collectionRoot, path, name).pipe(
    Effect.catch((error) => {
      log.warn("Scan", "Folder skipped", { path, error: error.message });

      return Effect.succeed({ name, path, files: [], subfolders: [] });
    }),
  );
}

export function scanCollection(collectionRoot: string): Effect.Effect<FolderListing, FileSystemError> {
  return listFolder(collectionRoot, "", "");
}
