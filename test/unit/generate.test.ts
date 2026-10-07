import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateCatalog, type GenerationSummary } from "../../src/catalog/generate.ts";
import { RegenerationController } from "../../src/catalog/regeneration.ts";
import type { CategoryIndex, MapIndex } from "../../src/catalog/model.ts";

const TINY = 64;

const LARGE_WIDTH = 3000;

const LARGE_HEIGHT = 2000;

let workDir: string;

let collection: string;

let output: string;

interface GenerateLog {
  readonly msg: string;
  readonly path?: string;
  readonly size?: number;
  readonly variants?: number;
  readonly zipArchives?: number;
  readonly likelyDumps?: number;
}

function parseGenerateLog(message: string): GenerateLog {
  // SAFETY: this test captures only JSON emitted by the generator's logger.
  return JSON.parse(message) as GenerateLog;
}

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

function generate(overridesPath = join(workDir, "no-overrides.json")): Promise<GenerationSummary> {
  return Effect.runPromise(generateCatalog({ filesPath: collection, dataPath: output, overridesPath, thumbnailConcurrency: 2 }));
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
    const index = join(output, "Pack 09", "Ancient Ruins", "index.json");

    const [thumbnailMtimeBefore, indexMtimeBefore] = await Promise.all([
      stat(thumb).then(({ mtimeMs }) => mtimeMs),
      stat(index).then(({ mtimeMs }) => mtimeMs),
    ]);

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
    expect(await Promise.all([stat(thumb).then(({ mtimeMs }) => mtimeMs), stat(index).then(({ mtimeMs }) => mtimeMs)])).toEqual([
      thumbnailMtimeBefore,
      indexMtimeBefore,
    ]);
  });

  test("rebuilds a missing thumbnail from its fresh preview without decoding the original", async () => {
    // #given
    const thumbnail = join(output, "czepuku", "CZEPEKU Fantasy Maps", "Monster Fighting Pit", "_thumbnails", "Empty Day.jpg.webp");
    await rm(thumbnail);

    // #when
    const summary = await generate();

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
    await writeFile(join(collection, "Broken", "Map", "ORIGINAL.png"), "not an image");

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
    expect(map.cover).toEqual({ variant: "ORIGINAL.png", thumbnail: null });
  });

  test("chooses a preferred still variant and applies a cover override on regeneration", async () => {
    // #given
    const czepeku = join(collection, "Cover selection", "Czepeku");
    const pack = join(collection, "Cover selection", "Pack");
    const overridden = join(collection, "Cover selection", "Overridden");
    const overridesPath = join(workDir, "overrides.json");
    await image(join(czepeku, "ORIGINAL DAY.webp"), TINY, TINY, "webp");
    await image(join(czepeku, "BIG NEST EGGS DAY.webp"), LARGE_WIDTH, LARGE_HEIGHT, "webp");
    await image(join(pack, "Ruins_BaseDayGL.png"), TINY, TINY, "png");
    await image(join(pack, "Ruins_BaseNightGrid.png"), LARGE_WIDTH, LARGE_HEIGHT, "png");
    await image(join(overridden, "Day.jpg"), TINY, TINY, "jpeg");
    await image(join(overridden, "Night.jpg"), LARGE_WIDTH, LARGE_HEIGHT, "jpeg");

    // #when
    await generate();

    const [czepekuIndex, packIndex] = await Promise.all([
      readJson<MapIndex>(join(output, "Cover selection", "Czepeku", "index.json")),
      readJson<MapIndex>(join(output, "Cover selection", "Pack", "index.json")),
    ]);

    await writeFile(overridesPath, JSON.stringify({ covers: { "Cover selection/Overridden": "Night.jpg" } }));
    await generate(overridesPath);
    const overriddenIndex = await readJson<MapIndex>(join(output, "Cover selection", "Overridden", "index.json"));

    // #then
    expect(czepekuIndex.cover.variant).toBe("ORIGINAL DAY.webp");
    expect(packIndex.cover.variant).toBe("Ruins_BaseDayGL.png");
    expect(overriddenIndex.cover.variant).toBe("Night.jpg");
  });

  test("writes a mixed folder's loose variants as a map with separate catalog and Original paths", async () => {
    // #given
    await image(join(collection, "Mixed", "Day.jpg"), TINY, TINY, "jpeg");
    await image(join(collection, "Mixed", "Child", "Night.jpg"), TINY, TINY, "jpeg");

    // #when
    await generate();

    const [category, looseMap] = await Promise.all([
      readJson<CategoryIndex>(join(output, "Mixed", "index.json")),
      readJson<MapIndex>(join(output, "Mixed", "._loose", "index.json")),
    ]);

    const looseVariantSize = (await stat(join(collection, "Mixed", "Day.jpg"))).size;

    // #then
    expect({ category, looseMap }).toEqual({
      category: {
        kind: "category",
        name: "Mixed",
        path: "Mixed",
        categories: [],
        maps: [
          {
            name: "Mixed",
            path: "Mixed/._loose",
            variantCount: 1,
            cover: { variant: "Day.jpg", thumbnail: "Mixed/._loose/_thumbnails/Day.jpg.webp" },
          },
          {
            name: "Child",
            path: "Mixed/Child",
            variantCount: 1,
            cover: { variant: "Night.jpg", thumbnail: "Mixed/Child/_thumbnails/Night.jpg.webp" },
          },
        ],
      },
      looseMap: {
        kind: "map",
        name: "Mixed",
        path: "Mixed/._loose",
        originalPath: "Mixed",
        cover: { variant: "Day.jpg", thumbnail: "Mixed/._loose/_thumbnails/Day.jpg.webp" },
        variants: [
          {
            file: "Day.jpg",
            size: looseVariantSize,
            animated: false,
            thumbnail: "Mixed/._loose/_thumbnails/Day.jpg.webp",
            preview: "Mixed/._loose/_previews/Day.jpg.webp",
          },
        ],
      },
    });
  });

  test("logs all ZIP archives and maps with more than 60 variants as likely dumps", async () => {
    // #given
    const dump = join(collection, "battlemaps");
    const archive = join(dump, "Archive.ZIP");
    await image(join(dump, "Map 1.jpg"), TINY, TINY, "jpeg");
    await Promise.all(Array.from({ length: 60 }, (_, index) => copyFile(join(dump, "Map 1.jpg"), join(dump, `Map ${index + 2}.jpg`))));
    await writeFile(archive, "archive");
    const originalLevel = process.env.LOG_LEVEL;
    const originalLog = console.log;
    const originalError = console.error;
    const messages: GenerateLog[] = [];
    process.env.LOG_LEVEL = "info";
    console.log = (message: string) => messages.push(parseGenerateLog(message));
    console.error = (message: string) => messages.push(parseGenerateLog(message));

    // #when
    try {
      await generate();
    } finally {
      process.env.LOG_LEVEL = originalLevel;
      console.log = originalLog;
      console.error = originalError;
    }

    // #then
    const [rootArchive, dumpArchive] = await Promise.all([
      stat(join(collection, "Printable Maps.zip")),
      stat(join(collection, "battlemaps", "Archive.ZIP")),
    ]);

    expect({
      zipArchives: messages.flatMap(({ msg, path, size }) => (msg === "ZIP archive ignored" ? [{ path, size }] : [])),
      likelyDumps: messages.flatMap(({ msg, path, variants }) => (msg === "Likely dump" ? [{ path, variants }] : [])),
      summary: messages.flatMap(({ msg, zipArchives, likelyDumps }) =>
        msg === "Collection diagnostics" ? [{ zipArchives, likelyDumps }] : [],
      ),
    }).toEqual({
      zipArchives: [
        { path: "battlemaps/Archive.ZIP", size: dumpArchive.size },
        { path: "Printable Maps.zip", size: rootArchive.size },
      ],
      likelyDumps: [{ path: "battlemaps", variants: 61 }],
      summary: [{ zipArchives: 2, likelyDumps: 1 }],
    });
  });

  test("adds and removes a map on successive full regeneration passes without leaving Catalog orphans", async () => {
    // #given
    const added = join(collection, "Live", "Added", "Day.jpg");
    const catalog = join(output, "Live", "Added");
    await image(added, TINY, TINY, "jpeg");

    // #when
    await generate();
    const beforeRemoval = await readJson<MapIndex>(join(catalog, "index.json"));
    await rm(join(collection, "Live"), { recursive: true });
    await generate();

    // #then
    expect(beforeRemoval.path).toBe("Live/Added");
    expect(await Bun.file(join(catalog, "index.json")).exists()).toBe(false);
    expect(await Bun.file(join(catalog, "_thumbnails", "Day.jpg.webp")).exists()).toBe(false);
  });

  test("keeps the existing catalog when a pass finds an empty collection", async () => {
    // #given
    const emptyCollection = join(workDir, "empty-collection");
    await mkdir(emptyCollection, { recursive: true });
    await generate();
    const before = await snapshot(output);

    // #when
    await Effect.runPromise(
      generateCatalog({
        filesPath: emptyCollection,
        dataPath: output,
        overridesPath: join(workDir, "no-overrides.json"),
        thumbnailConcurrency: 2,
      }),
    );
    const derivedImagesAfter = (await snapshot(output)).filter((line) => line.includes("_thumbnails/") || line.includes("_previews/"));

    // #then
    expect(derivedImagesAfter).toEqual(before.filter((line) => line.includes("_thumbnails/") || line.includes("_previews/")));
    expect(derivedImagesAfter.length).toBeGreaterThan(0);
  });

  test("regenerates a Variant restored with an older mtime", async () => {
    // #given
    const original = join(collection, "Pack 09", "Ancient Ruins", "Ruins_BaseDayGL.png");
    const preview = join(output, "Pack 09", "Ancient Ruins", "_previews", "Ruins_BaseDayGL.png.webp");
    const originalContents = await readFile(original);
    await writeFile(original, originalContents);
    await utimes(original, new Date(1_000), new Date(1_000));

    // #when
    const summary = await generate();

    // #then
    expect(summary.previewsCreated).toBe(1);
    expect((await sharp(preview).metadata()).format).toBe("webp");
  });
});

describe("RegenerationController", () => {
  test("coalesces triggers that arrive while a regeneration pass is running", async () => {
    // #given
    let releaseFirstPass: (() => void) | undefined;
    let calls = 0;

    const firstPass = new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    });

    const controller = new RegenerationController({
      debounceMs: 0,
      reconcileIntervalMs: 60_000,
      regenerate: async () => {
        calls += 1;

        if (calls === 1) await firstPass;
      },
      onError: () => undefined,
    });

    // #when
    const initial = controller.start();
    controller.trigger();
    controller.trigger();
    await Bun.sleep(10);
    releaseFirstPass?.();
    await initial;
    await Bun.sleep(10);
    controller.stop();

    // #then
    expect(calls).toBe(2);
  });
});
