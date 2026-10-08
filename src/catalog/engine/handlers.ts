import { Effect, Match } from "effect";
import { join } from "node:path";
import { isAnimatedVariant, type CategoryNode, type FileListing, type MapNode } from "../classify.ts";
import { selectMapCover } from "../cover.ts";
import { mtimeOrNull, readTextFile, statPath, type FileSystemError, writeTextFileIfChanged } from "../file-system.ts";
import { categoryIndexFromPublished, mapIndex, previewPath, searchIndexFromPublished, thumbnailPath } from "../folder-index.ts";
import { enrichMap, readVariantDimensions } from "../metadata.ts";
import { type CatalogPath, INDEX_FILE, type MapIndex, SEARCH_FILE } from "../model.ts";
import { ensureDerivedImage, PREVIEW_MAX_SIZE, THUMBNAIL_MAX_SIZE, type DerivedImageKind } from "../thumbnail.ts";
import { CategoryWork, type CatalogWork, ImageWork, MapWork, type PassContext, SearchWork } from "./work.ts";

function parentOf(path: CatalogPath): CatalogPath {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? "" : path.slice(0, slash);
}

function imageFailureKey(map: MapNode, variant: FileListing, kind: DerivedImageKind): string {
  return `image:${map.path}:${variant.name}:${kind}`;
}

function hasImageFailure(pass: PassContext, map: MapNode, variant: FileListing, kind: DerivedImageKind): boolean {
  const failures = new Set(pass.imageFailures.snapshot().map((failure) => failure.work));

  return (
    failures.has(imageFailureKey(map, variant, kind)) || (kind === "thumbnail" && failures.has(imageFailureKey(map, variant, "preview")))
  );
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

function handleMap({ map, pass }: MapWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const dimensions = yield* readVariantDimensions([map], pass.filesPath);
    const enriched = yield* enrichMap(selectMapCover(map, pass.overrides, dimensions), pass.metadata, dimensions);
    const present = yield* existingDerivedImages(enriched, pass.dataPath);

    const hasDerivedImage = (candidate: MapNode, variant: FileListing, kind: DerivedImageKind) =>
      !hasImageFailure(pass, candidate, variant, kind) && present.has(`${variant.name}\u0000${kind}`);

    if (pass.beforeMapIndexWrite) yield* pass.beforeMapIndexWrite(enriched, present);

    yield* writeTextFileIfChanged(
      join(pass.dataPath, enriched.path, INDEX_FILE),
      JSON.stringify(mapIndex(enriched, hasDerivedImage, dimensions)),
    );

    const parent = pass.categories.get(parentOf(map.path));

    return [...(parent ? [new CategoryWork({ category: parent, pass })] : []), new SearchWork({ pass })];
  });
}

function handleImage({ map, variant, kind, pass }: ImageWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const original = join(pass.filesPath, map.sourcePath, variant.name);
    const key = imageFailureKey(map, variant, kind);

    if (pass.beforeImageWork) yield* pass.beforeImageWork(map, variant, kind);

    const result = yield* Effect.gen(function* () {
      if (kind === "preview") {
        yield* ensureDerivedImage(
          original,
          variant.mtimeMs,
          variant.size,
          join(pass.dataPath, previewPath(map.path, variant.name)),
          PREVIEW_MAX_SIZE,
          isAnimatedVariant(variant.name),
        );

        return [new ImageWork({ map, variant, kind: "thumbnail", pass }), new MapWork({ map, pass })] as const;
      }

      const preview = join(pass.dataPath, previewPath(map.path, variant.name));
      const previewStats = yield* statPath(preview);
      yield* ensureDerivedImage(
        preview,
        previewStats.mtimeMs,
        previewStats.size,
        join(pass.dataPath, thumbnailPath(map.path, variant.name)),
        THUMBNAIL_MAX_SIZE,
        false,
      );

      return [new MapWork({ map, pass })] as const;
    }).pipe(
      Effect.map((work) => ({ ok: true as const, work })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );

    if (result.ok) {
      pass.imageFailures.clear(key);

      return result.work;
    }

    pass.imageFailures.record(key, result.error.message);

    return [new MapWork({ map, pass })];
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

function readPublishedMap(dataPath: string, path: CatalogPath): Effect.Effect<MapIndex | null, FileSystemError> {
  return readTextFile(join(dataPath, path, INDEX_FILE)).pipe(
    Effect.map(parsePublishedMap),
    Effect.catchTag("FileSystemNotFound", () => Effect.succeed(null)),
  );
}

function handleCategory(category: CategoryNode, dataPath: string): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const published = yield* Effect.forEach(category.maps, (map) => readPublishedMap(dataPath, map.path));
    const byPath = new Map(published.flatMap((index) => (index ? [[index.path, index] as const] : [])));

    yield* writeTextFileIfChanged(join(dataPath, category.path, INDEX_FILE), JSON.stringify(categoryIndexFromPublished(category, byPath)));

    return [];
  });
}

function handleSearch(pass: PassContext): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const published = yield* Effect.forEach(pass.maps, (map) => readPublishedMap(pass.dataPath, map.path), { concurrency: 16 });

    yield* writeTextFileIfChanged(
      join(pass.dataPath, SEARCH_FILE),
      JSON.stringify(searchIndexFromPublished(published.flatMap((index) => (index ? [index] : [])))),
    );

    return [];
  });
}

export function handleCatalogWork(work: CatalogWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Match.value(work).pipe(
    Match.tagsExhaustive({
      MapWork: handleMap,
      CategoryWork: ({ category, pass }) => handleCategory(category, pass.dataPath),
      SearchWork: ({ pass }) => handleSearch(pass),
      ImageWork: handleImage,
    }),
  );
}
