import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ensureDerivedImage, THUMBNAIL_MAX_SIZE } from "../../src/catalog/thumbnail.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "thumbnail-test-"));
  directories.push(directory);

  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ensureDerivedImage", () => {
  test("does not enlarge a still image that is already under the maximum size", async () => {
    // #given
    const root = await temporaryDirectory();
    const original = join(root, "original.png");
    const destination = join(root, "derived", "original.webp");
    await mkdir(join(root, "derived"), { recursive: true });
    await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } })
      .png()
      .toFile(original);
    const originalStats = await stat(original);

    // #when
    await Effect.runPromise(
      ensureDerivedImage(original, originalStats.mtimeMs, originalStats.size, destination, THUMBNAIL_MAX_SIZE, false),
    );

    // #then
    expect(await sharp(destination).metadata()).toEqual(expect.objectContaining({ format: "webp", width: 64, height: 32 }));
  });
});
