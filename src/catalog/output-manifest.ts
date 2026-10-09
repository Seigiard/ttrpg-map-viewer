import { Effect } from "effect";
import { isAbsolute, join, relative } from "node:path";
import { isAnimatedVariant, type CategoryNode, type MapNode } from "./classify.ts";
import { mtimeOrNull, readDirectory, readTextFile, removePath, type FileSystemError } from "./file-system.ts";
import { previewPath, printImagePath, thumbnailPath } from "./folder-index.ts";
import { INDEX_FILE, SEARCH_FILE } from "./model.ts";
import { sourceSignature } from "./thumbnail.ts";

const CONCURRENCY = 16;

/** Engine ownership state inside the output tree: a lock inode and freshness records. It is never catalog output. */
export const ENGINE_STATE_DIRECTORY = ".sync-engine";

export interface OutputManifest {
  readonly paths: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

export function expectedOutputManifest(
  categories: readonly CategoryNode[],
  maps: readonly MapNode[],
  dataPath: string,
  overridesPath: string,
): Effect.Effect<OutputManifest, FileSystemError> {
  const paths = new Set([
    SEARCH_FILE,
    ...categories.map((category) => join(category.path, INDEX_FILE)),
    ...maps.flatMap((map) => [
      join(map.path, INDEX_FILE),
      ...map.variants.flatMap((variant) => [
        previewPath(map.path, variant.name),
        `${previewPath(map.path, variant.name)}.source.json`,
        thumbnailPath(map.path, variant.name),
        `${thumbnailPath(map.path, variant.name)}.source.json`,
      ]),
    ]),
  ]);

  const overridesRelativePath = relative(dataPath, overridesPath);

  if (overridesRelativePath !== "" && !isAbsolute(overridesRelativePath) && !overridesRelativePath.startsWith("..")) {
    paths.add(overridesRelativePath);
  }

  return Effect.forEach(
    maps.flatMap((map) =>
      map.variants
        .filter((variant) => !isAnimatedVariant(variant.name))
        .map((variant) => ({ variant, path: printImagePath(map.path, variant.name) })),
    ),
    ({ variant, path }) => {
      const destination = join(dataPath, path);
      const signature = sourceSignature(variant.mtimeMs, variant.size);

      return Effect.all([
        mtimeOrNull(destination),
        readTextFile(`${destination}.source.json`).pipe(Effect.catchTag("FileSystemNotFound", () => Effect.succeed(null))),
      ]).pipe(
        Effect.map(([imageMtime, storedSignature]) =>
          imageMtime !== null && storedSignature === signature ? [path, `${path}.source.json`] : [],
        ),
      );
    },
    { concurrency: CONCURRENCY },
  ).pipe(
    Effect.map((printPaths) => {
      for (const path of printPaths.flat()) paths.add(path);

      const directories = new Set<string>();

      for (const map of maps) directories.add(join(map.path, "_print"));

      for (const path of paths) {
        for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
          directories.add(path.slice(0, slash));
        }
      }

      return { paths, directories };
    }),
  );
}

/** Removes output that the manifest does not expect. Recent or temporary print files survive a pass. */
export function pruneOrphans(
  dataPath: string,
  manifest: OutputManifest,
  passStartedAt: number,
  relativePath = "",
): Effect.Effect<void, FileSystemError> {
  const absolutePath = join(dataPath, relativePath);

  return Effect.gen(function* () {
    const entries = yield* readDirectory(absolutePath);

    yield* Effect.forEach(
      entries,
      (entry) => {
        const childPath = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        const childAbsolutePath = join(dataPath, childPath);

        if (relativePath === "" && entry.name === ENGINE_STATE_DIRECTORY) return Effect.void;

        if (entry.isDirectory()) {
          const hasExpectedChild = manifest.directories.has(childPath);

          return hasExpectedChild ? pruneOrphans(dataPath, manifest, passStartedAt, childPath) : removePath(childAbsolutePath);
        }

        if (manifest.paths.has(childPath)) return Effect.void;

        const isPrintFile = childPath.includes("/_print/");

        if (!isPrintFile) return removePath(childAbsolutePath);

        return mtimeOrNull(childAbsolutePath).pipe(
          Effect.flatMap((mtime) =>
            childPath.includes(".tmp") || (mtime !== null && mtime > passStartedAt) ? Effect.void : removePath(childAbsolutePath),
          ),
        );
      },
      { concurrency: CONCURRENCY, discard: true },
    );
  });
}
