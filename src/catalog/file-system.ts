import { Data, Effect } from "effect";
import type { Dirent, Stats } from "node:fs";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ownedPromise } from "../utils/owned-promise.ts";

interface FailureProps {
  readonly operation: string;
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}

export class FileSystemNotFound extends Data.TaggedError("FileSystemNotFound")<FailureProps> {}

export class FileSystemFailure extends Data.TaggedError("FileSystemFailure")<FailureProps> {}

export type FileSystemError = FileSystemNotFound | FileSystemFailure;

function errnoCode(cause: unknown): string | undefined {
  // SAFETY: this mapper is the catch boundary for node:fs failures, which expose errno on `code`.
  return (cause as NodeJS.ErrnoException).code;
}

function fsEffect<A>(operation: string, path: string, run: () => Promise<A>): Effect.Effect<A, FileSystemError> {
  return ownedPromise(run, (cause) => {
    const code = errnoCode(cause);
    const props = { operation, path, cause, message: `${operation} ${path} failed: ${code ?? String(cause)}` };

    return code === "ENOENT" ? new FileSystemNotFound(props) : new FileSystemFailure(props);
  });
}

export function readDirectory(path: string): Effect.Effect<Dirent[], FileSystemError> {
  return fsEffect("readdir", path, () => readdir(path, { withFileTypes: true }));
}

export function statPath(path: string): Effect.Effect<Stats, FileSystemError> {
  return fsEffect("stat", path, () => stat(path));
}

/** Modification time, or null when the path does not exist. */
export function mtimeOrNull(path: string): Effect.Effect<number | null, FileSystemError> {
  return statPath(path).pipe(
    Effect.map((stats) => stats.mtimeMs),
    Effect.catchTag("FileSystemNotFound", () => Effect.succeed(null)),
  );
}

export function ensureParentDirectory(path: string): Effect.Effect<void, FileSystemError> {
  const parent = dirname(path);

  return fsEffect("mkdir", parent, async () => {
    await mkdir(parent, { recursive: true });
  });
}

/** Writes through a temp file and rename, so nginx never serves a half-written file. */
export function writeFileAtomically(path: string, content: string): Effect.Effect<void, FileSystemError> {
  const temporary = `${path}.tmp`;

  return ensureParentDirectory(path).pipe(
    Effect.andThen(() =>
      fsEffect("writeFile", path, async () => {
        await writeFile(temporary, content);
        await rename(temporary, path);
      }),
    ),
  );
}
