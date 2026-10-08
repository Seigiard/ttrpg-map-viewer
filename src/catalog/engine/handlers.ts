import { Effect, Match } from "effect";
import { join } from "node:path";
import { type CategoryNode, type FileListing, type MapNode } from "../classify.ts";
import { selectMapCover } from "../cover.ts";
import { mtimeOrNull, readTextFile, type FileSystemError, writeTextFileIfChanged } from "../file-system.ts";
import { categoryIndexFromPublished, mapIndex, previewPath, searchIndexFromPublished, thumbnailPath } from "../folder-index.ts";
import { enrichMap, readVariantDimensions } from "../metadata.ts";
import { type CatalogPath, INDEX_FILE, type MapIndex, SEARCH_FILE } from "../model.ts";
import { CategoryWork, type CatalogWork, type MapWork, type PassContext, SearchWork } from "./work.ts";

function parentOf(path: CatalogPath): CatalogPath {
  const slash = path.lastIndexOf("/");

  return slash === -1 ? "" : path.slice(0, slash);
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

    const hasDerivedImage = (_map: MapNode, variant: FileListing, kind: "thumbnail" | "preview") =>
      present.has(`${variant.name}\u0000${kind}`);

    yield* writeTextFileIfChanged(
      join(pass.dataPath, enriched.path, INDEX_FILE),
      JSON.stringify(mapIndex(enriched, hasDerivedImage, dimensions)),
    );

    const parent = pass.categories.get(parentOf(map.path));

    return [...(parent ? [new CategoryWork({ category: parent, pass })] : []), new SearchWork({ pass })];
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
    }),
  );
}
