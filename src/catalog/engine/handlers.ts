import { Effect, Match } from "effect";
import { join } from "node:path";
import { isAnimatedVariant, type CategoryNode, type FileListing, type MapNode } from "../classify.ts";
import { selectMapCover } from "../cover.ts";
import { mtimeOrNull, readTextFile, statPath, type FileSystemError, writeTextFileIfChanged } from "../file-system.ts";
import { categoryIndexFromPublished, mapIndex, previewPath, searchIndexFromPublished, thumbnailPath } from "../folder-index.ts";
import { enrichMap, readVariantDimensions } from "../metadata.ts";
import { type CatalogPath, INDEX_FILE, type MapIndex, SEARCH_FILE } from "../model.ts";
import { ensureDerivedImage, PREVIEW_MAX_SIZE, THUMBNAIL_MAX_SIZE, type DerivedImageFailure, type DerivedImageKind } from "../thumbnail.ts";
import {
  CategoryWork,
  type CatalogWork,
  FinalizeIndexesWork,
  ImageWork,
  imageWorkKey,
  MapWork,
  type PassContext,
  SearchWork,
} from "./work.ts";

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

function orderedVariants(map: MapNode): readonly FileListing[] {
  return [map.cover, ...map.variants.filter((variant) => variant !== map.cover)];
}

function indexCascades(map: MapNode, pass: PassContext): readonly CatalogWork[] {
  const parent = pass.categories.get(parentOf(map.path));

  return [
    ...(parent && !pass.skippedDirectories.has(parent.path) ? [new CategoryWork({ category: parent, pass })] : []),
    new SearchWork({ pass }),
  ];
}

function writeMapIndex(map: MapNode, pass: PassContext, cascadeIndexes: boolean): Effect.Effect<readonly CatalogWork[], FileSystemError> {
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

    return cascadeIndexes && pass.initialMapWritesRemaining.count === 0 ? indexCascades(enriched, pass) : [];
  });
}

function handleMap({ map, pass, cascadeIndexes, initial }: MapWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const variants = orderedVariants(map);

    yield* writeMapIndex(map, pass, false).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (initial) pass.initialMapWritesRemaining.count = Math.max(0, pass.initialMapWritesRemaining.count - 1);
        }),
      ),
    );

    if (initial) {
      const first = variants[0];

      if (first) pass.initialImages.push({ map, variant: first, remaining: variants.slice(1) });
    }

    const cascades = cascadeIndexes && pass.initialMapWritesRemaining.count === 0 ? indexCascades(map, pass) : [];

    return [...cascades];
  });
}

function handleFinalizeIndexes({ pass }: FinalizeIndexesWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  if (pass.initialMapWritesRemaining.count > 0) return Effect.sleep(10).pipe(Effect.as([new FinalizeIndexesWork({ pass })]));

  return Effect.succeed([
    ...[...pass.categories.values()].flatMap((category) =>
      pass.skippedDirectories.has(category.path) ? [] : [new CategoryWork({ category, pass })],
    ),
    new SearchWork({ pass }),
    ...pass.initialImages.splice(0).map(({ map, variant, remaining }) => new ImageWork({ map, variant, remaining, pass })),
  ]);
}

function renderDerivedImages(
  map: MapNode,
  variant: FileListing,
  pass: PassContext,
): Effect.Effect<void, FileSystemError | DerivedImageFailure> {
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

function handleImage({ map, variant, remaining, pass }: ImageWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const previewKey = imageWorkKey(map.path, variant.name, "preview");
    const thumbnailKey = imageWorkKey(map.path, variant.name, "thumbnail");

    const result = yield* renderDerivedImages(map, variant, pass).pipe(
      Effect.map(() => ({ ok: true as const })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );

    if (result.ok) {
      pass.imageFailures.clear(previewKey);
      pass.imageFailures.clear(thumbnailKey);
    } else {
      pass.imageFailures.record(previewKey, result.error.message);
      pass.imageFailures.record(thumbnailKey, result.error.message);
    }

    const cascades = yield* writeMapIndex(map, pass, true);
    const next = remaining[0];

    return [...cascades, ...(next ? [new ImageWork({ map, variant: next, remaining: remaining.slice(1), pass })] : [])];
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
      CategoryWork: ({ category, pass }) =>
        pass.skippedDirectories.has(category.path) ? Effect.succeed([]) : handleCategory(category, pass.dataPath),
      SearchWork: ({ pass }) => handleSearch(pass),
      FinalizeIndexesWork: handleFinalizeIndexes,
      ImageWork: handleImage,
    }),
  );
}
