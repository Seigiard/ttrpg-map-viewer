import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    expect(summary).toEqual({ categories: 4, maps: 3, thumbnailsCreated: 3, thumbnailsFresh: 0, thumbnailsFailed: 0 });
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
          variantCount: 2,
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
    expect(map.variants.map((variant) => variant.file)).toEqual(["Empty Day.jpg", "Original Night.jpg"]);
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

  test("a second run reuses thumbnails that are newer than their originals", async () => {
    // #given
    const thumb = join(output, "Pack 09", "Ancient Ruins", "_thumbnails", "Ruins_BaseDayGL.png.webp");
    const mtimeBefore = (await stat(thumb)).mtimeMs;

    // #when
    const summary = await generate();

    // #then
    expect(summary.thumbnailsCreated).toBe(0);
    expect(summary.thumbnailsFresh).toBe(3);
    expect((await stat(thumb)).mtimeMs).toBe(mtimeBefore);
  });

  test("a cover that cannot be decoded gets a null thumbnail instead of failing the catalog", async () => {
    // #given
    await image(join(collection, "Broken", "Map", "keep.jpg"), TINY, TINY, "jpeg");
    await writeFile(join(collection, "Broken", "Map", "a-broken.png"), "not an image");

    // #when
    const summary = await generate();
    const map = await readJson<MapIndex>(join(output, "Broken", "Map", "index.json"));

    // #then
    expect(summary.thumbnailsFailed).toBe(1);
    expect(map.cover).toEqual({ variant: "a-broken.png", thumbnail: null });
  });
});
