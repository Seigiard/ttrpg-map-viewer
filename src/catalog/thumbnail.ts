import { Data, Effect } from "effect";
import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import sharp from "sharp";
import { ownedPromise } from "../utils/owned-promise.ts";
import { ensureParentDirectory, type FileSystemError, mtimeOrNull } from "./file-system.ts";

export const THUMBNAIL_MAX_SIZE = 512;

export const PREVIEW_MAX_SIZE = 2048;

// libvips' operation cache keeps decoded tiles of huge originals alive between calls; one-shot resizes gain nothing from it.
sharp.cache(false);

export type DerivedImageKind = "thumbnail" | "preview";

export class DerivedImageFailure extends Data.TaggedError("DerivedImageFailure")<{
  readonly original: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type DerivedImageOutcome = "created" | "fresh";

function renderStillImage(original: string, destination: string, maxSize: number): Effect.Effect<void, DerivedImageFailure> {
  const temporary = `${destination}.tmp.webp`;

  return ownedPromise(
    async () => {
      // limitInputPixels: false — collection originals reach 16000×22000, above sharp's default pixel cap.
      await sharp(original, { limitInputPixels: false })
        .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
        .toColorspace("srgb")
        .webp({ quality: 80 })
        .toFile(temporary);
      await rename(temporary, destination);
    },
    (cause) => new DerivedImageFailure({ original, cause, message: `derived image of ${original} failed: ${String(cause)}` }),
  );
}

function renderVideoFrame(original: string, destination: string, maxSize: number): Effect.Effect<void, DerivedImageFailure> {
  const temporary = `${destination}.tmp.webp`;
  const frame = `${destination}.frame.png`;

  return ownedPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        const process = spawn("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          original,
          "-frames:v",
          "1",
          "-vf",
          `scale=min(${maxSize}\\,iw):min(${maxSize}\\,ih):force_original_aspect_ratio=decrease`,
          "-update",
          "1",
          frame,
        ]);

        let stderr = "";

        process.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        process.once("error", reject);
        process.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr}`))));
      })
        .then(() => sharp(frame, { limitInputPixels: false }).toColorspace("srgb").webp({ quality: 80 }).toFile(temporary))
        .then(() => rename(temporary, destination))
        .finally(() => rm(frame, { force: true })),
    (cause) => new DerivedImageFailure({ original, cause, message: `video frame of ${original} failed: ${String(cause)}` }),
  );
}

/** Makes a derived WebP unless one at least as new as the original already exists. */
export function ensureDerivedImage(
  original: string,
  originalMtimeMs: number,
  destination: string,
  maxSize: number,
  animated: boolean,
): Effect.Effect<DerivedImageOutcome, DerivedImageFailure | FileSystemError> {
  return Effect.gen(function* () {
    const existingMtime = yield* mtimeOrNull(destination);

    if (existingMtime !== null && existingMtime >= originalMtimeMs) return "fresh";

    yield* ensureParentDirectory(destination);
    yield* animated ? renderVideoFrame(original, destination, maxSize) : renderStillImage(original, destination, maxSize);

    return "created";
  });
}
