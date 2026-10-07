import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateCatalog, type GenerationSummary } from "../../src/catalog/generate.ts";
import type { CategoryIndex, MapIndex } from "../../src/catalog/model.ts";

const TINY = 64;

const LARGE_WIDTH = 3000;

const LARGE_HEIGHT = 2000;

let workDir: string;

let collection: string;

let output: string;

async function image(path: string, width: number, height: number, format: "jpeg" | "png" | "webp"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } } })
    .toFormat(format)
    .toFile(path);
}

async function video(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const process = spawn("ffmpeg", ["-f", "lavfi", "-i", "color=c=red:s=64x32:d=0.1", "-an", "-y", path]);

    process.once("error", reject);
    process.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

async function readJson<T>(path: string): Promise<T> {
  // SAFETY: the test reads files the generator wrote against the FolderIndex contract.
  return (await Bun.file(path).json()) as T;
}

/** Every file under `dir` with its size and mtime, to prove the collection is left untouched. */
async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });

  const lines = await Promise.all(
    entries.map(async (entry) => {
      const stats = await stat(join(dir, entry));

      return `${entry}|${stats.size}|${stats.mtimeMs}`;
    }),
  );

  return lines.sort();
}

function generate(): Promise<GenerationSummary> {
  return Effect.runPromise(generateCatalog({ filesPath: collection, dataPath: output, thumbnailConcurrency: 2 }));
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "catalog-test-"));
  collection = join(workDir, "collection");
  output = join(workDir, "out");

  const pit = join(collection, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit");
  await image(join(pit, "Original Night.jpg"), TINY, TINY, "jpeg");
  await image(join(pit, "Empty Day.jpg"), LARGE_WIDTH, LARGE_HEIGHT, "png");
  await video(join(pit, "Rain.webm"));
  await image(join(collection, "czepuku", "CZEPEKU Fantasy Maps", "Serene Lakeside", "BRIDGE DAY.webp"), TINY, TINY / 2, "webp");
  await image(join(collection, "Pack 09", "Ancient Ruins", "Ruins_BaseDayGL.png"), TINY, TINY, "png");
  await writeFile(join(collection, "Printable Maps.zip"), "not really a zip");
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("generateCatalog", () => {
  test("writes one index.json per category and map into the output tree, leaving the collection untouched", async () => {
    // #given
    const before = await snapshot(collection);

    // #when
    const summary = await generate();

    // #then
    expect(summary).toEqual({
      categories: 4,
      maps: 3,
      thumbnailsCreated: 5,
      thumbnailsFresh: 0,
      thumbnailsFailed: 0,
      previewsCreated: 5,
      previewsFresh: 0,
      previewsFailed: 0,
    });
    expect(await snapshot(collection)).toEqual(before);

    expect(await readJson<CategoryIndex>(join(output, "index.json"))).toEqual({
      kind: "category",
      name: "",
      path: "",
      categories: [
        { name: "czepuku", path: "czepuku" },
        { name: "Pack 09", path: "Pack 09" },
      ],
      maps: [],
    });

    expect(await readJson<CategoryIndex>(join(output, "czepuku", "CZEPEKU Fantasy Maps", "index.json"))).toEqual({
      kind: "category",
      name: "CZEPEKU Fantasy Maps",
      path: "czepuku/CZEPEKU Fantasy Maps",
      categories: [],
      maps: [
        {
          name: "Monster Fighting Pit",
          path: "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit",
          variantCount: 3,
          cover: {
            variant: "Empty Day.jpg",
            thumbnail: "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit/_thumbnails/Empty Day.jpg.webp",
          },
        },
        {
          name: "Serene Lakeside",
          path: "czepuku/CZEPEKU Fantasy Maps/Serene Lakeside",
          variantCount: 1,
          cover: {
            variant: "BRIDGE DAY.webp",
            thumbnail: "czepuku/CZEPEKU Fantasy Maps/Serene Lakeside/_thumbnails/BRIDGE DAY.webp.webp",
          },
        },
      ],
    });

    const map = await readJson<MapIndex>(join(output, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit", "index.json"));
    expect(map.kind).toBe("map");
    expect(map.cover.variant).toBe("Empty Day.jpg");
    expect(map.variants.map(({ file, animated, thumbnail, preview }) => ({ file, animated, thumbnail, preview }))).toEqual([
      {
        file: "Empty Day.jpg",
        animated: false,
        thumbnail: "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit/_thumbnails/Empty Day.jpg.webp",
        preview: "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit/_previews/Empty Day.jpg.webp",
      },
      {
        file: "Original Night.jpg",
        animated: false,
        thumbnail: "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit/_thumbnails/Original Night.jpg.webp",
        preview: "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit/_previews/Original Night.jpg.webp",
      },
      {
        file: "Rain.webm",
        animated: true,
        thumbnail: "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit/_thumbnails/Rain.webm.webp",
        preview: "czepuku/CZEPEKU Fantasy Maps/Monster Fighting Pit/_previews/Rain.webm.webp",
      },
    ]);
  });

  test("thumbnails are WebP and fit inside 512 px without enlarging small originals", async () => {
    // #given
    const large = join(output, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit", "_thumbnails", "Empty Day.jpg.webp");
    const small = join(output, "czepuku", "CZEPEKU Fantasy Maps", "Serene Lakeside", "_thumbnails", "BRIDGE DAY.webp.webp");

    // #when
    const [largeMeta, smallMeta] = await Promise.all([sharp(large).metadata(), sharp(small).metadata()]);

    // #then
    expect([largeMeta.format, largeMeta.width, largeMeta.height]).toEqual(["webp", 512, 341]);
    expect([smallMeta.format, smallMeta.width, smallMeta.height]).toEqual(["webp", TINY, TINY / 2]);
  });

  test("every variant gets a 2048 px WebP preview, and animated variants get one from a video frame", async () => {
    // #given
    const still = join(output, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit", "_previews", "Empty Day.jpg.webp");
    const animated = join(output, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit", "_previews", "Rain.webm.webp");

    // #when
    const [stillMeta, animatedMeta] = await Promise.all([sharp(still).metadata(), sharp(animated).metadata()]);

    // #then
    expect([stillMeta.format, stillMeta.width, stillMeta.height, animatedMeta.format, animatedMeta.width, animatedMeta.height]).toEqual([
      "webp",
      2048,
      1365,
      "webp",
      TINY,
      TINY / 2,
    ]);
  });

  test("a second run reuses thumbnails that are newer than their originals", async () => {
    // #given
    const thumb = join(output, "Pack 09", "Ancient Ruins", "_thumbnails", "Ruins_BaseDayGL.png.webp");
    const mtimeBefore = (await stat(thumb)).mtimeMs;

    // #when
    const summary = await generate();

    // #then
    expect(summary).toEqual({
      categories: 4,
      maps: 3,
      thumbnailsCreated: 0,
      thumbnailsFresh: 5,
      thumbnailsFailed: 0,
      previewsCreated: 0,
      previewsFresh: 5,
      previewsFailed: 0,
    });
    expect((await stat(thumb)).mtimeMs).toBe(mtimeBefore);
  });

  test("rebuilds a stale thumbnail from its fresh preview without decoding the original", async () => {
    // #given
    const mapPath = join(collection, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit");
    const original = join(mapPath, "Empty Day.jpg");
    const preview = join(output, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit", "_previews", "Empty Day.jpg.webp");
    const thumbnail = join(output, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit", "_thumbnails", "Empty Day.jpg.webp");
    const [originalContents, originalStats, previewStats] = await Promise.all([readFile(original), stat(original), stat(preview)]);
    await rm(thumbnail);
    await writeFile(original, "no longer decodable");
    await utimes(original, new Date(previewStats.mtimeMs - 1000), new Date(previewStats.mtimeMs - 1000));

    // #when
    const summary = await generate().finally(async () => {
      await writeFile(original, originalContents);
      await utimes(original, originalStats.atime, originalStats.mtime);
    });

    // #then
    expect(summary).toEqual({
      categories: 4,
      maps: 3,
      thumbnailsCreated: 1,
      thumbnailsFresh: 4,
      thumbnailsFailed: 0,
      previewsCreated: 0,
      previewsFresh: 5,
      previewsFailed: 0,
    });
    expect((await sharp(thumbnail).metadata()).format).toBe("webp");
  });

  test("a cover that cannot be decoded gets a null thumbnail instead of failing the catalog", async () => {
    // #given
    await image(join(collection, "Broken", "Map", "keep.jpg"), TINY, TINY, "jpeg");
    await writeFile(join(collection, "Broken", "Map", "a-broken.png"), "not an image");

    // #when
    const summary = await generate();
    const map = await readJson<MapIndex>(join(output, "Broken", "Map", "index.json"));

    // #then
    expect(summary).toEqual({
      categories: 5,
      maps: 4,
      thumbnailsCreated: 1,
      thumbnailsFresh: 5,
      thumbnailsFailed: 1,
      previewsCreated: 1,
      previewsFresh: 5,
      previewsFailed: 1,
    });
    expect(map.cover).toEqual({ variant: "a-broken.png", thumbnail: null });
  });
});
