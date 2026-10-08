import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { isCatalogPath, isVariantFile, readMapIndex, resolveOriginal, type CatalogStorage } from "./catalog/map-index.ts";
import { printImagePath } from "./catalog/folder-index.ts";
import { PRINT_IMAGE_MAX_SIZE } from "./catalog/model.ts";
import { sourceSignature } from "./catalog/thumbnail.ts";

let printImageQueue = Promise.resolve();

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function printImageUrl(path: string, variant: string): string {
  return `/_catalog/${path.split("/").map(encodeURIComponent).join("/")}/_print/${encodeURIComponent(variant)}.jpg`;
}

async function isFresh(destination: string, signature: string): Promise<boolean> {
  const [image, storedSignature] = await Promise.all([
    stat(destination).catch(() => null),
    Bun.file(`${destination}.source.json`)
      .text()
      .catch(() => null),
  ]);

  return image?.isFile() === true && storedSignature === signature;
}

async function ensurePrintImage(original: string, destination: string, signature: string): Promise<void> {
  const previous = printImageQueue;
  let release: () => void = () => undefined;
  printImageQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    if (await isFresh(destination, signature)) return;

    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp.jpg`;
    await sharp(original, { limitInputPixels: false })
      .resize(PRINT_IMAGE_MAX_SIZE, PRINT_IMAGE_MAX_SIZE, { fit: "inside", withoutEnlargement: true })
      .toColorspace("srgb")
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(temporary);
    await rename(temporary, destination);
    await Bun.write(`${destination}.source.json.tmp`, signature);
    await rename(`${destination}.source.json.tmp`, `${destination}.source.json`);
  } finally {
    release();
  }
}

/** Generates a cached Print image only for a still Variant named by its Map's generated index. */
export async function printImageResponse(request: Request, storage: CatalogStorage): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  const variantFile = url.searchParams.get("variant");

  if (request.method !== "GET" || path === null || variantFile === null || !isCatalogPath(path) || !isVariantFile(variantFile)) {
    return new Response("Bad request", { status: 400 });
  }

  const index = await readMapIndex(storage.dataPath, path);
  const variant = index?.variants.find(({ file }) => file === variantFile);

  if (!index || !variant || variant.animated) return notFound();
  const original = await resolveOriginal(storage, index, variant.file);

  if (original === null) return notFound();
  const originalStats = await stat(original).catch(() => null);

  if (originalStats === null || !originalStats.isFile()) return notFound();
  const destination = join(storage.dataPath, printImagePath(path, variant.file));

  try {
    await ensurePrintImage(original, destination, sourceSignature(originalStats.mtimeMs, originalStats.size));
  } catch {
    return new Response("Print image generation failed", { status: 500 });
  }

  return Response.redirect(new URL(printImageUrl(path, variant.file), url), 302);
}
