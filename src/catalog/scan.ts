import { Effect } from "effect";
import { join } from "node:path";
import { log } from "../logging/index.ts";
import type { FileListing, FolderListing } from "./classify.ts";
import { type FileSystemError, readDirectory, statPath } from "./file-system.ts";
import type { CatalogPath } from "./model.ts";

function childPath(parent: CatalogPath, name: string): CatalogPath {
  return parent === "" ? name : `${parent}/${name}`;
}

interface ScanState {
  hadReadFailure: boolean;
}

export interface CollectionScan {
  readonly listing: FolderListing;
  readonly hadReadFailure: boolean;
}

function listFolder(
  collectionRoot: string,
  path: CatalogPath,
  name: string,
  state: ScanState,
): Effect.Effect<FolderListing, FileSystemError> {
  return Effect.gen(function* () {
    const absolute = join(collectionRoot, path);
    const entries = yield* readDirectory(absolute);
    const files: FileListing[] = [];
    const subfolders: FolderListing[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      // Symlinks are neither followed nor listed: they could loop or point outside the collection.
      if (entry.isDirectory()) {
        const subfolder = yield* listSubfolder(collectionRoot, childPath(path, entry.name), entry.name, state);

        if (subfolder) subfolders.push(subfolder);
      } else if (entry.isFile()) {
        const stats = yield* statPath(join(absolute, entry.name));
        files.push({ name: entry.name, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    }

    return { name, path, files, subfolders };
  });
}

/** An unreadable subfolder is left out so its old Catalog index is never rewritten as empty. */
function listSubfolder(
  collectionRoot: string,
  path: CatalogPath,
  name: string,
  state: ScanState,
): Effect.Effect<FolderListing | undefined> {
  return listFolder(collectionRoot, path, name, state).pipe(
    Effect.catch((error) => {
      state.hadReadFailure = true;
      log.warn("Scan", "Folder skipped", { path, error: error.message });

      return Effect.succeed(undefined);
    }),
  );
}

export function scanCollection(collectionRoot: string): Effect.Effect<CollectionScan, FileSystemError> {
  const state: ScanState = { hadReadFailure: false };

  return listFolder(collectionRoot, "", "", state).pipe(Effect.map((listing) => ({ listing, hadReadFailure: state.hadReadFailure })));
}
