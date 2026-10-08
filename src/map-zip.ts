import { downloadZip } from "client-zip";
import { open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { MapIndex } from "./catalog/model.ts";

interface MapZipConfig {
  readonly filesPath: string;
  readonly dataPath: string;
}

interface OriginalFile {
  readonly file: string;
  readonly handle: FileHandle;
  readonly size: number;
  readonly lastModified: Date;
}

function isCatalogPath(path: string, allowRoot = false): boolean {
  if (path === "") return allowRoot;

  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isVariantFile(file: string): boolean {
  return file !== "" && file !== "." && file !== ".." && !file.includes("/") && !file.includes("\\");
}

function isInside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);

  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function zipFileName(mapName: string): string {
  return `${mapName}.zip`;
}

function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function closeWhenStreamEnds(stream: ReadableStream<Uint8Array>, originals: readonly OriginalFile[]): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let closed = false;

  const closeHandles = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all(originals.map(({ handle }) => handle.close().catch(() => undefined)));
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          await closeHandles();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        await closeHandles();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await closeHandles();
    },
  });
}

/** Streams only the Originals named by a generated Map index. */
export async function mapZipResponse(request: Request, config: MapZipConfig): Promise<Response> {
  const path = new URL(request.url).searchParams.get("path");

  if (request.method !== "GET" || path === null || !isCatalogPath(path)) return new Response("Bad request", { status: 400 });

  let index: MapIndex;

  try {
    // SAFETY: index.json is generated against the MapIndex contract; these checks reject a non-Map or invalid paths.
    index = JSON.parse(await readFile(resolve(config.dataPath, path, "index.json"), "utf8")) as MapIndex;

    if (
      index.kind !== "map" ||
      !isCatalogPath(index.originalPath, true) ||
      !index.variants.every((variant) => isVariantFile(variant.file))
    ) {
      return notFound();
    }
  } catch {
    return notFound();
  }

  const collectionRoot = await realpath(config.filesPath).catch(() => null);

  if (collectionRoot === null) return notFound();

  const originals: OriginalFile[] = [];

  try {
    for (const variant of index.variants) {
      const requested = resolve(collectionRoot, index.originalPath, variant.file);
      const original = await realpath(requested);
      const handle = await open(original);
      const details = await handle.stat();

      if (!isInside(collectionRoot, original) || !details.isFile()) {
        await handle.close();

        throw new Error("Original is outside the collection or is not a file");
      }

      originals.push({ file: variant.file, handle, size: details.size, lastModified: details.mtime });
    }
  } catch {
    await Promise.all(originals.map(({ handle }) => handle.close()));

    return notFound();
  }

  const archive = downloadZip(
    originals.map(({ file, handle, size, lastModified }) => ({
      input: handle.readableWebStream({ autoClose: false }),
      name: file,
      size,
      lastModified,
    })),
    { metadata: originals.map(({ file, size, lastModified }) => ({ name: file, size, lastModified })) },
  );

  const headers = new Headers(archive.headers);
  headers.set("Content-Disposition", contentDisposition(zipFileName(index.name)));
  headers.set("Content-Type", "application/zip");
  headers.set("X-Accel-Buffering", "no");

  return new Response(archive.body === null ? null : closeWhenStreamEnds(archive.body, originals), { headers });
}
