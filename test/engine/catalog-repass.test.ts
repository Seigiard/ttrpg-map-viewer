import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireOutputTree } from "@seigiard/sync-engine";
import { Effect, Exit } from "effect";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCatalogSynchronization } from "../../src/catalog/engine/composition.ts";
import type { CategoryIndex, MapIndex, SearchIndex } from "../../src/catalog/model.ts";
import { createWorkspace, image, LAKESIDE, PIT, type Workspace } from "./collection-fixture.ts";
import { passOf, sessionOptions, withSession } from "./session.ts";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  await rm(workspace.root, { recursive: true, force: true });
});

async function readJson<T>(path: string): Promise<T> {
  // SAFETY: the test reads files written against the FolderIndex contract.
  return JSON.parse(await readFile(path, "utf8")) as T;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const searchPaths = async () => (await readJson<SearchIndex>(join(workspace.output, "search.json"))).maps.map((map) => map.path);

describe("a later pass in the same engine session", () => {
  test("publishes a map added to the source and updates its category and the search index", async () => {
    // #given
    await withSession(workspace, async (session) => {
      expect(await searchPaths()).not.toContain("Pack 09/New Keep");

      // #when
      await image(join(workspace.collection, "Pack 09", "New Keep", "Keep Day.png"), 40, 40, "png");
      await passOf(session);
    });

    // #then
    expect(await searchPaths()).toContain("Pack 09/New Keep");
    expect(
      (await readJson<MapIndex>(join(workspace.output, "Pack 09", "New Keep", "index.json"))).variants.map((variant) => variant.file),
    ).toEqual(["Keep Day.png"]);
    expect((await readJson<CategoryIndex>(join(workspace.output, "Pack 09", "index.json"))).maps.map((map) => map.name)).toEqual([
      "Ancient Ruins",
      "New Keep",
    ]);
  });

  test("removes the output of a source that is confirmed gone, and keeps the engine state", async () => {
    // #given
    await withSession(workspace, async (session) => {
      expect(await exists(join(workspace.output, "Mixed", "Inner", "index.json"))).toBe(true);

      // #when
      await rm(join(workspace.collection, "Mixed", "Inner"), { recursive: true });
      await passOf(session);
    });

    // #then
    expect(await exists(join(workspace.output, "Mixed", "Inner"))).toBe(false);
    expect(await searchPaths()).not.toContain("Mixed/Inner");
    // Only the loose files remain, so the folder is a map now and its loose-map output is gone.
    expect((await readJson<MapIndex>(join(workspace.output, "Mixed", "index.json"))).kind).toBe("map");
    expect(await exists(join(workspace.output, "Mixed", "._loose"))).toBe(false);
    expect((await readJson<CategoryIndex>(join(workspace.output, "index.json"))).maps.map((map) => map.path)).toEqual(["Mixed"]);
    expect(await exists(join(workspace.output, ".sync-engine"))).toBe(true);
  });

  test("reclassifies a map folder that gains a child folder into a category with a loose map", async () => {
    // #given
    await withSession(workspace, async (session) => {
      // #when
      await image(join(workspace.collection, "Pack 09", "Ancient Ruins", "Crypt", "Crypt.png"), 40, 40, "png");
      await passOf(session);
    });

    // #then
    const ruins = await readJson<CategoryIndex>(join(workspace.output, "Pack 09", "Ancient Ruins", "index.json"));

    expect(ruins.kind).toBe("category");
    expect(ruins.maps.map((map) => map.path)).toEqual(["Pack 09/Ancient Ruins/._loose", "Pack 09/Ancient Ruins/Crypt"]);
    expect((await readJson<MapIndex>(join(workspace.output, "Pack 09", "Ancient Ruins", "._loose", "index.json"))).originalPath).toBe(
      "Pack 09/Ancient Ruins",
    );
  });

  test("reads a cover override that lives outside the collection on the next pass", async () => {
    // #given
    await withSession(workspace, async (session) => {
      expect((await readJson<MapIndex>(join(workspace.output, PIT, "index.json"))).cover.variant).toBe("Empty Day.jpg");
      await writeFile(workspace.overrides, JSON.stringify({ covers: { [PIT]: "Rain.webm" } }));

      // #when
      await passOf(session);
    });

    // #then
    expect((await readJson<MapIndex>(join(workspace.output, PIT, "index.json"))).cover.variant).toBe("Rain.webm");
    expect(
      (await readJson<CategoryIndex>(join(workspace.output, "czepuku", "CZEPEKU Fantasy Maps", "index.json"))).maps[0]!.cover.variant,
    ).toBe("Rain.webm");
  });

  test("a restart over a published output rewrites nothing that did not change", async () => {
    // #given
    await withSession(workspace, async () => undefined);
    const files = ["index.json", "search.json", join(PIT, "index.json")].map((path) => join(workspace.output, path));
    const before = await Promise.all(files.map((path) => stat(path).then(({ mtimeMs }) => mtimeMs)));

    // #when
    await withSession(workspace, async () => undefined);

    // #then
    expect(await Promise.all(files.map((path) => stat(path).then(({ mtimeMs }) => mtimeMs)))).toEqual(before);
  });
});

describe("failures", () => {
  test("a failed map write is reported, independent work finishes, and the next pass repairs it", async () => {
    // #given
    await withSession(workspace, async (session) => {
      const lakesideBefore = await readFile(join(workspace.output, LAKESIDE, "index.json"), "utf8");
      // A regular file where the new map's output folder must go makes its write fail at the filesystem boundary.
      await writeFile(join(workspace.output, "Pack 09", "New Keep"), "stale file in the way");
      await image(join(workspace.collection, "Pack 09", "New Keep", "Keep Day.png"), 40, 40, "png");
      await image(join(workspace.collection, "Pack 09", "Other", "Other.png"), 40, 40, "png");

      // #when
      await passOf(session);
      const failed = await Effect.runPromise(session.status);

      // #then
      expect(failed.work.state).toBe("complete-with-errors");
      expect(failed.work.errors.map(({ work }) => (work._tag === "MapWork" ? work.map.path : work._tag))).toEqual(["Pack 09/New Keep"]);
      expect(await searchPaths()).toContain("Pack 09/Other");
      expect(await searchPaths()).not.toContain("Pack 09/New Keep");
      expect((await readJson<CategoryIndex>(join(workspace.output, "Pack 09", "index.json"))).maps.map((map) => map.name)).toEqual([
        "Ancient Ruins",
        "Other",
      ]);
      expect(await readFile(join(workspace.output, LAKESIDE, "index.json"), "utf8")).toBe(lakesideBefore);

      // #when
      await passOf(session);

      // #then
      expect((await Effect.runPromise(session.status)).work.errors).toEqual([]);
      expect(await searchPaths()).toContain("Pack 09/New Keep");
    });
  });

  test("an unreadable source root retains every published index, and a restored source recovers", async () => {
    // #given
    await withSession(workspace, async (session) => {
      const indexBefore = await readFile(join(workspace.output, "index.json"), "utf8");
      const searchBefore = await readFile(join(workspace.output, "search.json"), "utf8");
      const moved = `${workspace.collection}-away`;
      await rename(workspace.collection, moved);

      // #when
      await Effect.runPromise(session.requestPass());
      const exit = await Effect.runPromise(Effect.exit(session.awaitCompletion));

      // #then
      expect(Exit.isFailure(exit)).toBe(true);
      expect((await Effect.runPromise(session.status)).failure).not.toBeNull();
      expect(await readFile(join(workspace.output, "index.json"), "utf8")).toBe(indexBefore);
      expect(await readFile(join(workspace.output, "search.json"), "utf8")).toBe(searchBefore);
      expect(await exists(join(workspace.output, PIT, "index.json"))).toBe(true);

      // #when
      await rename(moved, workspace.collection);
      await passOf(session);

      // #then
      expect((await Effect.runPromise(session.status)).failure).toBeNull();
    });
  });
});

describe("output ownership", () => {
  test("a second owner of the same output tree is refused while a legacy holder keeps the lease", async () => {
    // #given
    await mkdir(workspace.output, { recursive: true });
    const release = await Effect.runPromise(acquireOutputTree(workspace.output, join(workspace.output, ".sync-engine")));

    try {
      // #when
      const exit = await Effect.runPromise(Effect.exit(Effect.scoped(openCatalogSynchronization(sessionOptions(workspace)))));

      // #then
      expect(Exit.isFailure(exit)).toBe(true);
      expect(await exists(join(workspace.output, "index.json"))).toBe(false);
    } finally {
      await release();
    }
  });
});
