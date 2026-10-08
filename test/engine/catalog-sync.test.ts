import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readMapIndex, resolveOriginal } from "../../src/catalog/map-index.ts";
import type { CategoryIndex, MapIndex, SearchIndex } from "../../src/catalog/model.ts";
import { createWorkspace, LAKESIDE, PIT, type Workspace } from "./collection-fixture.ts";
import { withSession } from "./session.ts";

let workspace: Workspace;

beforeAll(async () => {
  workspace = await createWorkspace();
});

afterAll(async () => {
  await rm(workspace.root, { recursive: true, force: true });
});

async function readJson<T>(path: string): Promise<T> {
  // SAFETY: the test reads files written against the FolderIndex contract.
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("catalog indexes built by the shared engine", () => {
  test("the first full pass writes category, map and search indexes without touching the collection", async () => {
    // #given
    const pitSizes = await Promise.all(
      ["Empty Day.jpg", "Original Night.jpg", "Rain.webm"].map((name) => stat(join(workspace.collection, PIT, name))),
    );

    // #when
    await withSession(workspace, async () => undefined);

    // #then
    expect(await readJson<CategoryIndex>(join(workspace.output, "index.json"))).toEqual({
      kind: "category",
      name: "",
      path: "",
      categories: [
        { name: "czepuku", path: "czepuku" },
        { name: "Mixed", path: "Mixed" },
        { name: "Pack 09", path: "Pack 09" },
      ],
      maps: [],
    });

    expect(await readJson<CategoryIndex>(join(workspace.output, "czepuku", "CZEPEKU Fantasy Maps", "index.json"))).toEqual({
      kind: "category",
      name: "CZEPEKU Fantasy Maps",
      path: "czepuku/CZEPEKU Fantasy Maps",
      categories: [],
      maps: [
        {
          name: "Monster Fighting Pit",
          path: PIT,
          variantCount: 3,
          cover: { variant: "Empty Day.jpg", thumbnail: `${PIT}/_thumbnails/Empty Day.jpg.webp` },
          author: "Czepeku",
          tags: ["Maps & Scenes", "map"],
          mapSize: { width: 30, height: 20 },
        },
        {
          name: "Serene Lakeside",
          path: LAKESIDE,
          variantCount: 1,
          cover: { variant: "BRIDGE DAY.webp", thumbnail: `${LAKESIDE}/_thumbnails/BRIDGE DAY.webp.webp` },
          author: "Czepeku",
          tags: ["Maps & Scenes", "scene"],
        },
      ],
    });

    expect(await readJson<CategoryIndex>(join(workspace.output, "Mixed", "index.json"))).toEqual({
      kind: "category",
      name: "Mixed",
      path: "Mixed",
      categories: [],
      maps: [
        {
          name: "Mixed",
          path: "Mixed/._loose",
          variantCount: 1,
          cover: { variant: "Loose.png", thumbnail: "Mixed/._loose/_thumbnails/Loose.png.webp" },
        },
        {
          name: "Inner",
          path: "Mixed/Inner",
          variantCount: 1,
          cover: { variant: "Room.jpg", thumbnail: "Mixed/Inner/_thumbnails/Room.jpg.webp" },
        },
      ],
    });

    expect(await readJson<MapIndex>(join(workspace.output, PIT, "index.json"))).toEqual({
      kind: "map",
      name: "Monster Fighting Pit",
      path: PIT,
      originalPath: PIT,
      cover: { variant: "Empty Day.jpg", thumbnail: `${PIT}/_thumbnails/Empty Day.jpg.webp` },
      author: "Czepeku",
      tags: ["Maps & Scenes", "map"],
      mapSize: { width: 30, height: 20 },
      variants: [
        {
          file: "Empty Day.jpg",
          size: pitSizes[0]!.size,
          width: 300,
          height: 200,
          animated: false,
          thumbnail: `${PIT}/_thumbnails/Empty Day.jpg.webp`,
          preview: `${PIT}/_previews/Empty Day.jpg.webp`,
          mapSize: { width: 30, height: 20 },
          gridScale: 100,
        },
        {
          file: "Original Night.jpg",
          size: pitSizes[1]!.size,
          width: 64,
          height: 64,
          animated: false,
          thumbnail: `${PIT}/_thumbnails/Original Night.jpg.webp`,
          preview: `${PIT}/_previews/Original Night.jpg.webp`,
          mapSize: { width: 30, height: 20 },
          gridScale: 100,
        },
        {
          file: "Rain.webm",
          size: pitSizes[2]!.size,
          animated: true,
          thumbnail: `${PIT}/_thumbnails/Rain.webm.webp`,
          preview: `${PIT}/_previews/Rain.webm.webp`,
        },
      ],
    });

    expect((await readJson<MapIndex>(join(workspace.output, "Mixed", "._loose", "index.json"))).originalPath).toBe("Mixed");

    expect(await readJson<SearchIndex>(join(workspace.output, "search.json"))).toEqual({
      maps: [
        {
          name: "Monster Fighting Pit",
          path: PIT,
          categoryPath: ["czepuku", "CZEPEKU Fantasy Maps"],
          thumbnail: `${PIT}/_thumbnails/Empty Day.jpg.webp`,
          variantCount: 3,
          author: "Czepeku",
          tags: ["Maps & Scenes", "map"],
        },
        {
          name: "Serene Lakeside",
          path: LAKESIDE,
          categoryPath: ["czepuku", "CZEPEKU Fantasy Maps"],
          thumbnail: `${LAKESIDE}/_thumbnails/BRIDGE DAY.webp.webp`,
          variantCount: 1,
          author: "Czepeku",
          tags: ["Maps & Scenes", "scene"],
        },
        {
          name: "Mixed",
          path: "Mixed/._loose",
          categoryPath: ["Mixed"],
          thumbnail: "Mixed/._loose/_thumbnails/Loose.png.webp",
          variantCount: 1,
        },
        {
          name: "Inner",
          path: "Mixed/Inner",
          categoryPath: ["Mixed"],
          thumbnail: "Mixed/Inner/_thumbnails/Room.jpg.webp",
          variantCount: 1,
        },
        {
          name: "Ancient Ruins",
          path: "Pack 09/Ancient Ruins",
          categoryPath: ["Pack 09"],
          thumbnail: "Pack 09/Ancient Ruins/_thumbnails/Ruins_BaseDayGL.png.webp",
          variantCount: 1,
        },
      ],
    });
  });

  test("every variant in a published map index resolves to its original in the collection", async () => {
    // #given
    await withSession(workspace, async () => undefined);
    const index = await readMapIndex(workspace.output, PIT);

    // #then
    expect(index).not.toBeNull();

    for (const variant of index!.variants) {
      const resolved = await resolveOriginal({ filesPath: workspace.collection, dataPath: workspace.output }, index!, variant.file);

      expect(resolved).not.toBeNull();
      expect(await sha256(resolved!)).toBe(await sha256(join(workspace.collection, PIT, variant.file)));
    }

    const loose = await readMapIndex(workspace.output, "Mixed/._loose");
    const looseOriginal = await resolveOriginal({ filesPath: workspace.collection, dataPath: workspace.output }, loose!, "Loose.png");

    expect(await sha256(looseOriginal!)).toBe(await sha256(join(workspace.collection, "Mixed", "Loose.png")));
  });
});
