import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { printImageResponse } from "../../src/print-image.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "print-image-test-"));
  directories.push(directory);

  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("printImageResponse", () => {
  test("creates a 12000 px Print image once and redirects later requests to the cached Catalog file", async () => {
    // #given
    const root = await temporaryDirectory();
    const filesPath = join(root, "collection");
    const dataPath = join(root, "catalog");
    const original = join(filesPath, "Map", "Huge.png");
    await mkdir(join(dataPath, "Map"), { recursive: true });
    await mkdir(join(filesPath, "Map"), { recursive: true });
    await sharp({ create: { width: 13_000, height: 1_000, channels: 3, background: "red" } })
      .png()
      .toFile(original);
    await writeFile(
      join(dataPath, "Map", "index.json"),
      JSON.stringify({ kind: "map", name: "Map", originalPath: "Map", variants: [{ file: "Huge.png", animated: false }] }),
    );
    const request = new Request("http://catalog/api/print-image?path=Map&variant=Huge.png");

    // #when
    const first = await printImageResponse(request, { filesPath, dataPath });
    const print = join(dataPath, "Map", "_print", "Huge.png.jpg");
    const firstMtime = (await stat(print)).mtimeMs;
    const second = await printImageResponse(request, { filesPath, dataPath });

    // #then
    expect({
      first: [first.status, first.headers.get("location")],
      second: [second.status, second.headers.get("location")],
      metadata: await sharp(print).metadata(),
      mtime: (await stat(print)).mtimeMs,
    }).toEqual({
      first: [302, "http://catalog/_catalog/Map/_print/Huge.png.jpg"],
      second: [302, "http://catalog/_catalog/Map/_print/Huge.png.jpg"],
      metadata: expect.objectContaining({ format: "jpeg", width: 12_000, height: 923 }),
      mtime: firstMtime,
    });
  });

  test("rejects a Variant that is not named by the Map index", async () => {
    // #given
    const root = await temporaryDirectory();
    const filesPath = join(root, "collection");
    const dataPath = join(root, "catalog");
    await mkdir(join(dataPath, "Map"), { recursive: true });
    await writeFile(join(dataPath, "Map", "index.json"), JSON.stringify({ kind: "map", originalPath: "Map", variants: [] }));

    // #when
    const response = await printImageResponse(new Request("http://catalog/api/print-image?path=Map&variant=Unknown.png"), {
      filesPath,
      dataPath,
    });

    // #then
    expect(response.status).toBe(404);
  });
});
