import { Data, Effect } from "effect";
import { rename } from "node:fs/promises";
import sharp from "sharp";
import { ownedPromise } from "../utils/owned-promise.ts";
import { ensureParentDirectory, type FileSystemError, mtimeOrNull } from "./file-system.ts";

export const THUMBNAIL_MAX_SIZE = 512;

// libvips' operation cache keeps decoded tiles of huge originals alive between calls; one-shot resizes gain nothing from it.
sharp.cache(false);

export class ThumbnailFailure extends Data.TaggedError("ThumbnailFailure")<{
  readonly original: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type ThumbnailOutcome = "created" | "fresh";

function renderThumbnail(original: string, destination: string): Effect.Effect<void, ThumbnailFailure> {
  const temporary = `${destination}.tmp`;

  return ownedPromise(
    async () => {
      // limitInputPixels: false — collection originals reach 16000×22000, above sharp's default pixel cap.
      await sharp(original, { limitInputPixels: false })
        .resize(THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE, { fit: "inside", withoutEnlargement: true })
        .toColorspace("srgb")
        .webp({ quality: 80 })
        .toFile(temporary);
      await rename(temporary, destination);
    },
    (cause) => new ThumbnailFailure({ original, cause, message: `thumbnail of ${original} failed: ${String(cause)}` }),
  );
}

/** Makes the thumbnail unless one at least as new as the original already exists. */
export function ensureThumbnail(
  original: string,
  originalMtimeMs: number,
  destination: string,
): Effect.Effect<ThumbnailOutcome, ThumbnailFailure | FileSystemError> {
  return Effect.gen(function* () {
    const existingMtime = yield* mtimeOrNull(destination);

    if (existingMtime !== null && existingMtime >= originalMtimeMs) return "fresh";

    yield* ensureParentDirectory(destination);
    yield* renderThumbnail(original, destination);

    return "created";
  });
}
