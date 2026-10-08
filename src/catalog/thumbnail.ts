import { Data, Effect } from "effect";
import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import sharp from "sharp";
import { ownedPromise } from "../utils/owned-promise.ts";
import { ensureParentDirectory, type FileSystemError, mtimeOrNull, readTextFile, writeFileAtomically } from "./file-system.ts";

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

const DERIVED_IMAGE_PROCESSING_VERSION = "1";

export function sourceSignature(mtimeMs: number, size: number): string {
  return JSON.stringify({ mtimeMs, size, version: DERIVED_IMAGE_PROCESSING_VERSION });
}

function sourceSignaturePath(destination: string): string {
  return `${destination}.source.json`;
}

function renderStillImage(original: string, destination: string, maxSize: number): Effect.Effect<void, DerivedImageFailure> {
  const temporary = `${destination}.tmp.webp`;

  return ownedPromise(
    async () => {
      // limitInputPixels: false — collection originals reach 16000×22000, above sharp's default pixel cap.
      try {
        await sharp(original, { limitInputPixels: false })
          .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
          .toColorspace("srgb")
          .webp({ quality: 80 })
          .toFile(temporary);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    (cause) => new DerivedImageFailure({ original, cause, message: `derived image of ${original} failed: ${String(cause)}` }),
  );
}

function renderVideoFrame(original: string, destination: string, maxSize: number): Effect.Effect<void, DerivedImageFailure> {
  const temporary = `${destination}.tmp.webp`;
  const frame = `${destination}.frame.png`;

  return ownedPromise(
    (signal) =>
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
        let interrupted = false;

        const interrupt = () => {
          interrupted = true;
          process.kill("SIGTERM");
          setTimeout(() => {
            if (process.exitCode === null) process.kill("SIGKILL");
          }, 1_000).unref();
        };

        if (signal.aborted) interrupt();
        else signal.addEventListener("abort", interrupt, { once: true });

        process.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        process.once("error", reject);
        process.once("close", (code, signalName) => {
          signal.removeEventListener("abort", interrupt);

          if (interrupted) reject(new Error(`ffmpeg interrupted by ${signalName ?? "shutdown"}`));
          else if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited with ${code}: ${stderr}`));
        });
      })
        .then(() => sharp(frame, { limitInputPixels: false }).toColorspace("srgb").webp({ quality: 80 }).toFile(temporary))
        .then(() => rename(temporary, destination))
        .finally(() => Promise.all([rm(frame, { force: true }), rm(temporary, { force: true })]).then(() => undefined)),
    (cause) => new DerivedImageFailure({ original, cause, message: `video frame of ${original} failed: ${String(cause)}` }),
  );
}

/** Makes a derived WebP unless its stored Original signature matches the current Original. */
export function ensureDerivedImage(
  original: string,
  originalMtimeMs: number,
  originalSize: number,
  destination: string,
  maxSize: number,
  animated: boolean,
): Effect.Effect<DerivedImageOutcome, DerivedImageFailure | FileSystemError> {
  return Effect.gen(function* () {
    const signature = sourceSignature(originalMtimeMs, originalSize);

    const existingSignature = yield* readTextFile(sourceSignaturePath(destination)).pipe(
      Effect.catchTag("FileSystemNotFound", () => Effect.succeed(null)),
    );

    const existingMtime = yield* mtimeOrNull(destination);

    if (existingMtime !== null && existingSignature === signature) return "fresh";

    yield* ensureParentDirectory(destination);
    yield* animated ? renderVideoFrame(original, destination, maxSize) : renderStillImage(original, destination, maxSize);
    yield* writeFileAtomically(sourceSignaturePath(destination), signature);

    return "created";
  });
}
