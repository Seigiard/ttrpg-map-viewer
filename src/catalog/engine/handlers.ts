import { Data, Effect, Match, Schedule, Semaphore } from "effect";
import { join } from "node:path";
import sharp from "sharp";
import { isAnimatedVariant, type CategoryNode, type FileListing, type MapNode } from "../classify.ts";
import {
  CLASSIFICATION_IMAGE_MAX_SIZE,
  CLASSIFICATION_PROMPT_VERSION,
  classificationCacheKey,
  normalizeClassifierResponse,
  writeClassificationCache,
} from "../classification.ts";
import { mtimeOrNull, readTextFile, removePath, statPath, type FileSystemError, writeTextFileIfChanged } from "../file-system.ts";
import { categoryIndexFromPublished, mapIndex, previewPath, searchIndexFromPublished, thumbnailPath } from "../folder-index.ts";
import { type CatalogPath, INDEX_FILE, type MapIndex, SEARCH_FILE } from "../model.ts";
import {
  ensureDerivedImage,
  PREVIEW_MAX_SIZE,
  sourceSignature,
  THUMBNAIL_MAX_SIZE,
  type DerivedImageFailure,
  type DerivedImageKind,
} from "../thumbnail.ts";
import { ClassificationWork, type CatalogWork, FinalizeIndexesWork, ImageWork, imageWorkKey, MapWork, type PassContext } from "./work.ts";
import { parentOf } from "./listing.ts";
import { ownedPromise } from "../../utils/owned-promise.ts";

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

function lockFor(locks: Map<CatalogPath, Semaphore.Semaphore>, path: CatalogPath): Semaphore.Semaphore {
  const lock = locks.get(path) ?? Semaphore.makeUnsafe(1);

  locks.set(path, lock);

  return lock;
}

/** A reference is published only when its target already exists in the output tree. */
function existingDerivedImages(map: MapNode, dataPath: string): Effect.Effect<ReadonlySet<string>, FileSystemError> {
  const candidates = map.variants.flatMap((variant) => [
    { key: `${variant.name}\u0000thumbnail`, path: thumbnailPath(map.path, variant.name) },
    { key: `${variant.name}\u0000preview`, path: previewPath(map.path, variant.name) },
  ]);

  return Effect.forEach(candidates, ({ key, path }) =>
    Effect.all([mtimeOrNull(join(dataPath, path)), mtimeOrNull(join(dataPath, `${path}.source.json`))]).pipe(
      Effect.map(([imageMtime, signatureMtime]) => (imageMtime === null || signatureMtime === null ? [] : [key])),
    ),
  ).pipe(Effect.map((keys) => new Set(keys.flat())));
}

function writeMapIndex(map: MapNode, pass: PassContext): Effect.Effect<void, FileSystemError> {
  return Semaphore.withPermits(
    lockFor(pass.mapIndexLocks, map.path),
    1,
    Effect.gen(function* () {
      const present = yield* existingDerivedImages(map, pass.dataPath);

      const hasDerivedImage = (candidate: MapNode, variant: FileListing, kind: DerivedImageKind) =>
        !hasImageFailure(pass, candidate, variant, kind) && present.has(`${variant.name}\u0000${kind}`);

      if (pass.beforeMapIndexWrite) yield* pass.beforeMapIndexWrite(map, present);

      yield* writeTextFileIfChanged(
        join(pass.dataPath, map.path, INDEX_FILE),
        JSON.stringify(mapIndex(map, hasDerivedImage, pass.dimensions, pass.classifications.get(map.path))),
      );
    }),
  );
}

function refreshCategory(category: CategoryNode, pass: PassContext): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Semaphore.withPermits(lockFor(pass.refreshLocks, `category:${category.path}`), 1, handleCategory(category, pass));
}

function refreshSearch(pass: PassContext): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Semaphore.withPermits(lockFor(pass.refreshLocks, "search"), 1, handleSearch(pass));
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
    yield* Effect.forEach(pass.categories.values(), (category) => refreshCategory(category, pass), { discard: true });
    yield* refreshSearch(pass);

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
    } else {
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
    }

    if (variant === map.cover) {
      const parent = pass.categories.get(parentOf(map.path));

      if (parent) yield* refreshCategory(parent, pass);
      yield* refreshSearch(pass);
    }

    if (
      previewResult.ok &&
      variant === map.cover &&
      pass.classification &&
      !isAnimatedVariant(variant.name) &&
      !pass.classifications.has(map.path)
    )
      return [new ClassificationWork({ map, pass })];

    return [];
  });
}

class ClassificationImageFailure extends Data.TaggedError("ClassificationImageFailure")<{
  readonly message: string;
}> {}

function classificationImage(preview: string): Effect.Effect<Uint8Array, ClassificationImageFailure> {
  return ownedPromise(
    () =>
      sharp(preview, { limitInputPixels: false })
        .resize(CLASSIFICATION_IMAGE_MAX_SIZE, CLASSIFICATION_IMAGE_MAX_SIZE, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer(),
    (cause) => new ClassificationImageFailure({ message: `classification image failed: ${String(cause)}` }),
  );
}

function refreshClassification(map: MapNode, pass: PassContext): Effect.Effect<void, FileSystemError> {
  return Effect.gen(function* () {
    yield* writeMapIndex(map, pass);

    const parent = pass.categories.get(parentOf(map.path));

    if (parent) yield* refreshCategory(parent, pass);
    yield* refreshSearch(pass);
  });
}

export function handleClassification({ map, pass }: ClassificationWork): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  const classification = pass.classification;
  const classificationLock = pass.classificationLock;

  if (!classification || !classificationLock) return Effect.succeed([]);

  const status = classification.status;

  return Effect.gen(function* () {
    if (pass.initialMapWritesRemaining.count > 0)
      return yield* Effect.sleep(10).pipe(
        Effect.andThen(Effect.suspend(() => handleClassification(new ClassificationWork({ map, pass })))),
      );

    if (pass.failedInitialMaps.has(map.path)) return [];

    if (pass.classifications.has(map.path)) return [];

    if (status.snapshot().state !== "enabled") return [];

    if (hasImageFailure(pass, map, map.cover, "preview")) return [];

    const preview = join(pass.dataPath, previewPath(map.path, map.cover.name));
    const previewMtime = yield* mtimeOrNull(preview);

    const previewSignature = yield* readTextFile(`${preview}.source.json`).pipe(
      Effect.catchTag("FileSystemNotFound", () => Effect.succeed(null)),
    );

    if (previewMtime === null || previewSignature !== sourceSignature(map.cover.mtimeMs, map.cover.size)) return [];

    if (classification.maxCalls !== undefined && status.snapshot().calls >= classification.maxCalls) return [];

    const key = classificationCacheKey(map.cover.name, map.cover.size, map.cover.mtimeMs);

    return yield* Semaphore.withPermits(
      classificationLock,
      1,
      Effect.gen(function* () {
        if (status.snapshot().state !== "enabled") return [];

        if (classification.maxCalls !== undefined && status.snapshot().calls >= classification.maxCalls) return [];

        const image = yield* classificationImage(preview).pipe(
          Effect.catchTag("ClassificationImageFailure", (error) =>
            Effect.sync(() => {
              status.recordError(map.path, error.message);

              return null;
            }),
          ),
        );

        if (image === null) return [];

        const request = {
          image,
          mediaType: "image/webp" as const,
          name: map.name,
          categoryPath: map.path.split("/").slice(0, -1),
          author: map.metadata?.author,
        };

        const response = yield* Effect.suspend(() => {
          if (!status.tryStartCall(classification.maxCalls)) return Effect.succeed(null);

          return classification.classifier(request);
        }).pipe(
          Effect.retry({
            while: (error) =>
              error.retryable && (classification.maxCalls === undefined || status.snapshot().calls < classification.maxCalls),
            schedule: Schedule.exponential("100 millis").pipe(Schedule.upTo({ times: 2 })),
          }),
        );

        if (response === null) return [];

        const normalized = normalizeClassifierResponse(response);

        const result = {
          tags: normalized.tags,
          summary: normalized.summary,
          model: normalized.model,
          promptVersion: CLASSIFICATION_PROMPT_VERSION,
        };

        yield* writeClassificationCache(pass.dataPath, key, {
          ...result,
          raw: response.raw,
          requestedAt: new Date().toISOString(),
        });
        pass.classifications.set(map.path, result);
        status.clearError(map.path);
        yield* refreshClassification(map, pass);

        return [];
      }).pipe(
        Effect.catchTag("ClassifierFailure", (error) =>
          Effect.sync(() => {
            status.recordError(map.path, error.message);

            if (!error.retryable) status.stop(error.message);

            return [];
          }),
        ),
      ),
    );
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

function handleCategory(category: CategoryNode, pass: PassContext): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const published = yield* Effect.forEach(category.maps, (map) => readPublishedMap(pass.dataPath, map.path));

    const byPath = new Map(published.flatMap((index) => (index ? [[index.path, index] as const] : [])));

    const index = categoryIndexFromPublished(category, byPath);

    yield* writeTextFileIfChanged(join(pass.dataPath, category.path, INDEX_FILE), JSON.stringify(index));

    return [];
  });
}

function handleSearch(pass: PassContext): Effect.Effect<readonly CatalogWork[], FileSystemError> {
  return Effect.gen(function* () {
    const published = yield* Effect.forEach(pass.maps, (map) => readPublishedMap(pass.dataPath, map.path), { concurrency: 16 });

    const byPath = new Map(published.flatMap((index) => (index ? [[index.path, index] as const] : [])));

    yield* writeTextFileIfChanged(join(pass.dataPath, SEARCH_FILE), JSON.stringify(searchIndexFromPublished([...byPath.values()])));

    return [];
  });
}

export function handleCatalogWork(work: CatalogWork): Effect.Effect<readonly CatalogWork[], FileSystemError | DerivedImageFailure> {
  return Match.value(work).pipe(
    Match.tagsExhaustive({
      MapWork: handleMap,
      CategoryWork: ({ category, pass }) => refreshCategory(category, pass),
      SearchWork: ({ pass }) => refreshSearch(pass),
      FinalizeIndexesWork: handleFinalizeIndexes,
      ImageWork: handleImage,
      ClassificationWork: handleClassification,
      ClearWorkFailure: ({ beforeClear, onCleared, failureKey }) =>
        (beforeClear ? beforeClear(failureKey) : Effect.void).pipe(Effect.andThen(Effect.sync(() => onCleared(failureKey))), Effect.as([])),
    }),
  );
}
