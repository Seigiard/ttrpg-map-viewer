import { Effect, Match } from "effect";
import { join } from "node:path";
import { isAnimatedVariant, type CategoryNode, type FileListing, type MapNode } from "../classify.ts";
import {
  mtimeOrNull,
  readDirectory,
  readTextFile,
  removePath,
  statPath,
  type FileSystemError,
  writeTextFileIfChanged,
} from "../file-system.ts";
import { categoryIndexFromPublished, mapIndex, previewPath, searchIndexFromPublished, thumbnailPath } from "../folder-index.ts";
import { type CatalogPath, type CategoryIndex, INDEX_FILE, type MapIndex, SEARCH_FILE } from "../model.ts";
import { ensureDerivedImage, PREVIEW_MAX_SIZE, THUMBNAIL_MAX_SIZE, type DerivedImageFailure, type DerivedImageKind } from "../thumbnail.ts";
import { type CatalogWork, FinalizeIndexesWork, ImageWork, imageWorkKey, MapWork, type PassContext } from "./work.ts";

function parentOf(path: CatalogPath): CatalogPath {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? "" : path.slice(0, slash);
}

function hasImageFailure(pass: PassContext, map: MapNode, variant: FileListing, kind: DerivedImageKind): boolean {
  const failures = new Set(pass.imageFailures.snapshot().map((failure) => failure.work));

  return (
    failures.has(imageWorkKey(map.path, variant.name, kind)) ||
    (kind === "thumbnail" && failures.has(imageWorkKey(map.path, variant.name, "preview")))
  );
}

function imageFailureMessage(error: FileSystemError | DerivedImageFailure): string {
  return error.message;
}

function forgetDerivedSignature(pass: PassContext, path: CatalogPath): Effect.Effect<void, FileSystemError> {
  return removePath(join(pass.dataPath, `${path}.source.json`));
}

/** A reference is published only when its target already exists in the output tree. */
function existingDerivedImages(map: MapNode, dataPath: string): Effect.Effect<ReadonlySet<string>, FileSystemError> {
  const candidates = map.variants.flatMap((variant) => [
    { key: `${variant.name}\u0000thumbnail`, path: thumbnailPath(map.path, variant.name) },
    { key: `${variant.name}\u0000preview`, path: previewPath(map.path, variant.name) },
  ]);

  return Effect.forEach(candidates, ({ key, path }) =>
    mtimeOrNull(join(dataPath, path)).pipe(Effect.map((mtime) => (mtime === null ? [] : [key]))),
  ).pipe(Effect.map((keys) => new Set(keys.flat())));
}

function writeMapIndex(map: MapNode, pass: PassContext): Effect.Effect<void, FileSystemError> {
  return Effect.gen(function* () {
    const present = yield* existingDerivedImages(map, pass.dataPath);

    const hasDerivedImage = (candidate: MapNode, variant: FileListing, kind: DerivedImageKind) =>
      !hasImageFailure(pass, candidate, variant, kind) && present.has(`${variant.name}\u0000${kind}`);

    if (pass.beforeMapIndexWrite) yield* pass.beforeMapIndexWrite(map, present);

    yield* writeTextFileIfChanged(
      join(pass.dataPath, map.path, INDEX_FILE),
      JSON.stringify(mapIndex(map, hasDerivedImage, pass.dimensions)),
    );
  });
}

function handleMap({ map, pass }: MapWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    yield* writeMapIndex(map, pass).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          pass.failedInitialMaps.add(map.path);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          pass.initialMapWritesRemaining.count = Math.max(0, pass.initialMapWritesRemaining.count - 1);
        }),
      ),
    );

    return [];
  });
}

function handleFinalizeIndexes({ pass }: FinalizeIndexesWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  if (pass.initialMapWritesRemaining.count > 0)
    return Effect.sleep(10).pipe(Effect.andThen(Effect.suspend(() => handleFinalizeIndexes(new FinalizeIndexesWork({ pass })))));

  return Effect.gen(function* () {
    yield* Effect.forEach(
      pass.categories.values(),
      (category) => (pass.skippedDirectories.has(category.path) ? Effect.void : handleCategory(category, pass)),
      { discard: true },
    );
    yield* handleSearch(pass);

    return [];
  });
}

function renderPreview(map: MapNode, variant: FileListing, pass: PassContext): Effect.Effect<void, FileSystemError | DerivedImageFailure> {
  return Effect.gen(function* () {
    const original = join(pass.filesPath, map.sourcePath, variant.name);

    if (pass.beforeImageWork) yield* pass.beforeImageWork(map, variant, "preview");

    yield* ensureDerivedImage(
      original,
      variant.mtimeMs,
      variant.size,
      join(pass.dataPath, previewPath(map.path, variant.name)),
      PREVIEW_MAX_SIZE,
      isAnimatedVariant(variant.name),
      pass.force,
    );
  });
}

function renderThumbnail(
  map: MapNode,
  variant: FileListing,
  pass: PassContext,
): Effect.Effect<void, FileSystemError | DerivedImageFailure> {
  return Effect.gen(function* () {
    if (pass.beforeImageWork) yield* pass.beforeImageWork(map, variant, "thumbnail");

    const preview = join(pass.dataPath, previewPath(map.path, variant.name));
    const previewStats = yield* statPath(preview);
    yield* ensureDerivedImage(
      preview,
      previewStats.mtimeMs,
      previewStats.size,
      join(pass.dataPath, thumbnailPath(map.path, variant.name)),
      THUMBNAIL_MAX_SIZE,
      false,
      pass.force,
    );
  });
}

function handleImage({ map, variant, pass }: ImageWork): Effect.Effect<readonly CatalogWork[], FileSystemError | DerivedImageFailure> {
  return Effect.gen(function* () {
    if (pass.initialMapWritesRemaining.count > 0)
      return yield* Effect.sleep(10).pipe(Effect.andThen(Effect.suspend(() => handleImage(new ImageWork({ map, variant, pass })))));

    if (pass.failedInitialMaps.has(map.path)) return [];

    const previewKey = imageWorkKey(map.path, variant.name, "preview");
    const thumbnailKey = imageWorkKey(map.path, variant.name, "thumbnail");

    const previewResult = yield* renderPreview(map, variant, pass).pipe(
      Effect.map(() => ({ ok: true as const })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );

    if (!previewResult.ok) {
      pass.imageFailures.record(previewKey, imageFailureMessage(previewResult.error));
      pass.imageFailures.record(thumbnailKey, imageFailureMessage(previewResult.error));
      yield* forgetDerivedSignature(pass, previewPath(map.path, variant.name));
      yield* forgetDerivedSignature(pass, thumbnailPath(map.path, variant.name));
      yield* writeMapIndex(map, pass);

      return [];
    }

    pass.imageFailures.clear(previewKey);

    const thumbnailResult = yield* renderThumbnail(map, variant, pass).pipe(
      Effect.map(() => ({ ok: true as const })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );

    if (thumbnailResult.ok) {
      pass.imageFailures.clear(previewKey);
      pass.imageFailures.clear(thumbnailKey);
    } else {
      pass.imageFailures.record(thumbnailKey, imageFailureMessage(thumbnailResult.error));
      yield* forgetDerivedSignature(pass, thumbnailPath(map.path, variant.name));
    }

    yield* writeMapIndex(map, pass);

    if (variant === map.cover) {
      const parent = pass.categories.get(parentOf(map.path));

      if (parent && !pass.skippedDirectories.has(parent.path)) yield* handleCategory(parent, pass);
      yield* handleSearch(pass);
    }

    return [];
  });
}

function parsePublishedMap(content: string): MapIndex | null {
  try {
    // SAFETY: the file was written against the MapIndex contract; the kind check rejects anything else.
    const index = JSON.parse(content) as MapIndex;

    return index.kind === "map" ? index : null;
  } catch {
    return null;
  }
}

function parsePublishedCategory(content: string): CategoryIndex | null {
  try {
    // SAFETY: the file was written against the CategoryIndex contract; the kind check rejects anything else.
    const index = JSON.parse(content) as CategoryIndex;

    return index.kind === "category" ? index : null;
  } catch {
    return null;
  }
}

function readPublishedMap(dataPath: string, path: CatalogPath): Effect.Effect<MapIndex | null, FileSystemError> {
  return readTextFile(join(dataPath, path, INDEX_FILE)).pipe(
    Effect.map(parsePublishedMap),
    Effect.catchTag("FileSystemNotFound", () => Effect.succeed(null)),
  );
}

function readPublishedCategory(dataPath: string, path: CatalogPath): Effect.Effect<CategoryIndex | null, FileSystemError> {
  return readTextFile(join(dataPath, path, INDEX_FILE)).pipe(
    Effect.map(parsePublishedCategory),
    Effect.catchTag("FileSystemNotFound", () => Effect.succeed(null)),
  );
}

function collectPublishedMaps(dataPath: string, path: CatalogPath): Effect.Effect<readonly MapIndex[], FileSystemError> {
  return Effect.gen(function* () {
    const self = yield* readPublishedMap(dataPath, path);

    if (self) return [self];

    const entries = yield* readDirectory(join(dataPath, path)).pipe(Effect.catchTag("FileSystemNotFound", () => Effect.succeed([])));

    const nested = yield* Effect.forEach(
      entries.filter((entry) => entry.isDirectory()),
      (entry) => collectPublishedMaps(dataPath, path === "" ? entry.name : `${path}/${entry.name}`),
      { concurrency: 16 },
    );

    return nested.flat();
  });
}

function skippedPublishedMaps(pass: PassContext): Effect.Effect<readonly MapIndex[], FileSystemError> {
  return Effect.forEach(pass.skippedDirectories, (path) => collectPublishedMaps(pass.dataPath, path), { concurrency: 16 }).pipe(
    Effect.map((indexes) => indexes.flat()),
  );
}

function handleCategory(category: CategoryNode, pass: PassContext): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const published = yield* Effect.forEach(category.maps, (map) => readPublishedMap(pass.dataPath, map.path));
    const preserved = (yield* skippedPublishedMaps(pass)).filter((index) => parentOf(index.path) === category.path);

    const byPath = new Map([
      ...published.flatMap((index) => (index ? [[index.path, index] as const] : [])),
      ...preserved.map((index) => [index.path, index] as const),
    ]);

    const index = categoryIndexFromPublished(category, byPath);

    const preservedCategories = yield* Effect.forEach(pass.skippedDirectories, (path) => readPublishedCategory(pass.dataPath, path), {
      concurrency: 16,
    });

    const extraCategories = preservedCategories.flatMap((index) =>
      index && parentOf(index.path) === category.path ? [{ name: index.name, path: index.path }] : [],
    );

    const extraMaps = preserved
      .filter((map) => !index.maps.some((card) => card.path === map.path))
      .map((map) => ({
        name: map.name,
        path: map.path,
        variantCount: map.variants.length,
        cover: map.cover,
        author: map.author,
        tags: map.tags,
        mapSize: map.mapSize,
      }));

    yield* writeTextFileIfChanged(
      join(pass.dataPath, category.path, INDEX_FILE),
      JSON.stringify({
        ...index,
        categories: [...index.categories, ...extraCategories.filter((extra) => !index.categories.some((card) => card.path === extra.path))],
        maps: [...index.maps, ...extraMaps],
      }),
    );

    return [];
  });
}

function handleSearch(pass: PassContext): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const published = yield* Effect.forEach(pass.maps, (map) => readPublishedMap(pass.dataPath, map.path), { concurrency: 16 });
    const preserved = yield* skippedPublishedMaps(pass);

    yield* writeTextFileIfChanged(
      join(pass.dataPath, SEARCH_FILE),
      JSON.stringify(searchIndexFromPublished([...published.flatMap((index) => (index ? [index] : [])), ...preserved])),
    );

    return [];
  });
}

export function handleCatalogWork(work: CatalogWork): Effect.Effect<readonly CatalogWork[], FileSystemError | DerivedImageFailure> {
  return Match.value(work).pipe(
    Match.tagsExhaustive({
      MapWork: handleMap,
      CategoryWork: ({ category, pass }) =>
        pass.skippedDirectories.has(category.path) ? Effect.succeed([]) : handleCategory(category, pass),
      SearchWork: ({ pass }) => handleSearch(pass),
      FinalizeIndexesWork: handleFinalizeIndexes,
      ImageWork: handleImage,
    }),
  );
}
