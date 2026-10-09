import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireOutputTree } from "@seigiard/sync-engine";
import { Deferred, Effect, Exit } from "effect";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCatalogSynchronization, startCatalogSynchronization } from "../../src/catalog/engine/composition.ts";
import { startEngineRuntime } from "../../src/catalog/engine/runtime.ts";
import type { CategoryIndex, MapIndex, SearchIndex } from "../../src/catalog/model.ts";
import { ownedPromise } from "../../src/utils/owned-promise.ts";
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

async function waitFor(path: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await exists(path)) return;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`${label} did not appear`);
}

const searchPaths = async () => (await readJson<SearchIndex>(join(workspace.output, "search.json"))).maps.map((map) => map.path);

describe("a later pass in the same engine session", () => {
  test("publishes category and search indexes before held preview work finishes", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // #given
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();

          const session = yield* startCatalogSynchronization({
            ...sessionOptions(workspace),
            beforeImageWork: (_map, _variant, kind) =>
              kind === "preview" ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void,
          });

          yield* Deferred.await(entered);

          // #when
          yield* ownedPromise(
            () => waitFor(join(workspace.output, "search.json"), "search index"),
            (cause) => new Error(String(cause)),
          );

          // #then
          const category = yield* ownedPromise(
            () => readJson<CategoryIndex>(join(workspace.output, "czepuku", "CZEPEKU Fantasy Maps", "index.json")),
            (cause) => new Error(String(cause)),
          );

          const search = yield* ownedPromise(
            () => readJson<SearchIndex>(join(workspace.output, "search.json")),
            (cause) => new Error(String(cause)),
          );

          expect(category.maps.map((map) => map.path)).toEqual([PIT, LAKESIDE]);
          expect(search.maps.map((map) => map.path)).toContain(PIT);
          expect(search.maps.find((map) => map.path === PIT)?.thumbnail).toBeNull();

          yield* Deferred.succeed(release, undefined);
          yield* session.awaitCompletion;
        }),
      ),
    );
  }, 15_000);

  test("publishes one map's derived references while a later map preview is still held", async () => {
    await image(join(workspace.collection, "AAA First", "First.png"), 40, 40, "png");
    await image(join(workspace.collection, "ZZZ Held", "Held.png"), 40, 40, "png");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // #given
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();

          const session = yield* startCatalogSynchronization({
            ...sessionOptions(workspace),
            beforeImageWork: (map, _variant, kind) =>
              map.path === "ZZZ Held" && kind === "preview"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
          });

          yield* Deferred.await(entered);

          // #when
          yield* ownedPromise(
            async () => {
              for (let attempt = 0; attempt < 50; attempt += 1) {
                const first = await readJson<MapIndex>(join(workspace.output, "AAA First", "index.json"));
                const variant = first.variants[0]!;

                if (
                  variant.preview === "AAA First/_previews/First.png.webp" &&
                  variant.thumbnail === "AAA First/_thumbnails/First.png.webp"
                )
                  return;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }

              throw new Error("first map references did not publish while later preview was held");
            },
            (cause) => new Error(String(cause)),
          );

          // #then
          const held = yield* ownedPromise(
            () => readJson<MapIndex>(join(workspace.output, "ZZZ Held", "index.json")),
            (cause) => new Error(String(cause)),
          );

          expect(held.variants[0]?.preview).toBeNull();
          yield* Deferred.succeed(release, undefined);
          yield* session.awaitCompletion;
        }),
      ),
    );
  }, 15_000);

  test("cold start publishes the first map's derived references while the last map preview is still held", async () => {
    await image(join(workspace.collection, "AAA First", "First.png"), 40, 40, "png");
    await image(join(workspace.collection, "MMM Middle", "Middle.png"), 40, 40, "png");
    await image(join(workspace.collection, "ZZZ Held", "Held.png"), 40, 40, "png");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // #given
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();

          const session = yield* startCatalogSynchronization({
            ...sessionOptions(workspace),
            beforeImageWork: (map, _variant, kind) =>
              map.path === "ZZZ Held" && kind === "preview"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
          });

          yield* Deferred.await(entered);

          // #when
          yield* ownedPromise(
            async () => {
              for (let attempt = 0; attempt < 50; attempt += 1) {
                const first = await readJson<MapIndex>(join(workspace.output, "AAA First", "index.json"));
                const variant = first.variants[0]!;

                if (
                  variant.preview === "AAA First/_previews/First.png.webp" &&
                  variant.thumbnail === "AAA First/_thumbnails/First.png.webp"
                )
                  return;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }

              throw new Error("first map references did not publish while the last map preview was held");
            },
            (cause) => new Error(String(cause)),
          );

          // #then
          const held = yield* ownedPromise(
            () => readJson<MapIndex>(join(workspace.output, "ZZZ Held", "index.json")),
            (cause) => new Error(String(cause)),
          );

          expect(held.variants[0]?.preview).toBeNull();
          yield* Deferred.succeed(release, undefined);
          yield* session.awaitCompletion;
        }),
      ),
    );
  }, 15_000);

  test("category and search indexes wait for slow initial map writes", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // #given
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let held = false;

          const session = yield* startCatalogSynchronization({
            ...sessionOptions(workspace),
            beforeMapIndexWrite: (map) => {
              if (held || map.path !== PIT) return Effect.void;
              held = true;

              return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
            },
          });

          yield* Deferred.await(entered);

          // #when
          yield* Effect.sleep(50);

          // #then
          const categoryExists = yield* ownedPromise(
            () => exists(join(workspace.output, "czepuku", "CZEPEKU Fantasy Maps", "index.json")),
            (cause) => new Error(String(cause)),
          );

          const searchExists = yield* ownedPromise(
            () => exists(join(workspace.output, "search.json")),
            (cause) => new Error(String(cause)),
          );

          expect([categoryExists, searchExists]).toEqual([false, false]);

          yield* Deferred.succeed(release, undefined);
          yield* session.awaitCompletion;
        }),
      ),
    );

    expect(
      (await readJson<CategoryIndex>(join(workspace.output, "czepuku", "CZEPEKU Fantasy Maps", "index.json"))).maps.map((map) => map.path),
    ).toContain(PIT);
    expect(await searchPaths()).toContain(PIT);
  }, 15_000);

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

  test("adding one variant reprocesses only the new variant", async () => {
    const imageWork = new Map<string, number>();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // #given
          const session = yield* startCatalogSynchronization({
            ...sessionOptions(workspace),
            beforeImageWork: (_map, variant, kind) =>
              Effect.sync(() => {
                imageWork.set(`${variant.name}:${kind}`, (imageWork.get(`${variant.name}:${kind}`) ?? 0) + 1);
              }),
          });

          yield* session.awaitCompletion;
          imageWork.clear();

          // #when
          const newVariant = join(PIT, "New Chamber.png");

          yield* ownedPromise(
            () => image(join(workspace.collection, newVariant), 64, 64, "png"),
            (cause) => new Error(String(cause)),
          );
          yield* session.notify([newVariant]);
          yield* session.awaitCompletion;
        }),
      ),
    );

    // #then
    expect([...imageWork].sort()).toEqual([
      ["New Chamber.png:preview", 1],
      ["New Chamber.png:thumbnail", 1],
    ]);
    expect((await readJson<MapIndex>(join(workspace.output, PIT, "index.json"))).variants.map((variant) => variant.file).sort()).toEqual([
      "Empty Day.jpg",
      "New Chamber.png",
      "Original Night.jpg",
      "Rain.webm",
    ]);
  }, 15_000);

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

  test("a forced pass recreates derived images even when the stored signature is fresh", async () => {
    // #given
    await withSession(workspace, async (session) => {
      const preview = join(workspace.output, PIT, "_previews", "Empty Day.jpg.webp");
      const before = await readFile(preview);
      await writeFile(preview, "not a webp");

      // #when
      await passOf(session, true);

      // #then
      expect(await readFile(preview)).toEqual(before);
    });
  });

  test("colon-bearing map and variant names do not collide in image scheduling", async () => {
    // #given
    await image(join(workspace.collection, "A", "B:C.png"), 40, 40, "png");
    await image(join(workspace.collection, "A:B", "C.png"), 40, 40, "png");

    // #when
    await withSession(workspace, async () => undefined);

    // #then
    expect((await readJson<MapIndex>(join(workspace.output, "A", "index.json"))).variants[0]?.preview).toBe("A/_previews/B:C.png.webp");
    expect((await readJson<MapIndex>(join(workspace.output, "A:B", "index.json"))).variants[0]?.preview).toBe("A:B/_previews/C.png.webp");
    expect(await exists(join(workspace.output, "A", "_thumbnails", "B:C.png.webp"))).toBe(true);
    expect(await exists(join(workspace.output, "A:B", "_thumbnails", "C.png.webp"))).toBe(true);
  });

  test("a readable empty source publishes an empty root catalog and prunes stale map output", async () => {
    // #given
    await withSession(workspace, async (session) => {
      expect(await searchPaths()).toContain(PIT);

      // #when
      await rm(workspace.collection, { recursive: true });
      await mkdir(workspace.collection);
      await passOf(session);
    });

    // #then
    expect(await readJson<CategoryIndex>(join(workspace.output, "index.json"))).toEqual({
      kind: "category",
      name: "",
      path: "",
      categories: [],
      maps: [],
    });
    expect(await readJson<SearchIndex>(join(workspace.output, "search.json"))).toEqual({ maps: [] });
    expect(await exists(join(workspace.output, PIT))).toBe(false);
    expect(await exists(join(workspace.output, ".sync-engine"))).toBe(true);
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

  test("a warm source failure remains available and reports pass errors until recovery", async () => {
    // #given
    await withSession(workspace, async () => undefined);
    const moved = `${workspace.collection}-away`;
    await rename(workspace.collection, moved);
    const runtime = startEngineRuntime(sessionOptions(workspace));

    try {
      // #when
      await runtime.ready;
      const failed = await runtime.status();

      // #then
      expect(failed.available).toBe(true);
      expect(failed.availableFrom).toBe("prior-output");
      expect(failed.completed).toBe(false);
      expect(failed.errors.map((error) => error.source)).toContain("pass");
      expect(await searchPaths()).toContain(PIT);

      // #when
      await rename(moved, workspace.collection);
      await runtime.requestPass();

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await runtime.status();

        if (status.completed && status.errors.length === 0) break;

        if (attempt === 49) throw new Error("runtime did not recover after the source was restored");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // #then
      const recovered = await runtime.status();
      expect(recovered.available).toBe(true);
      expect(recovered.completed).toBe(true);
      expect(recovered.errors).toEqual([]);
    } finally {
      await runtime.stop();

      if (!(await exists(workspace.collection))) await rename(moved, workspace.collection);
    }
  });

  test("an unreadable subfolder keeps its parent category, loose map and prior child output", async () => {
    const unobservable = new Set<string>();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // #given
          const session = yield* startCatalogSynchronization({
            ...sessionOptions(workspace),
            sourceObservability: (path) => (unobservable.has(path) ? "directory" : undefined),
          });

          yield* session.awaitCompletion;

          const innerBefore = yield* ownedPromise(
            () => readFile(join(workspace.output, "Mixed", "Inner", "index.json"), "utf8"),
            (cause) => new Error(String(cause)),
          );

          const looseBefore = yield* ownedPromise(
            () => readFile(join(workspace.output, "Mixed", "._loose", "index.json"), "utf8"),
            (cause) => new Error(String(cause)),
          );

          unobservable.add("Mixed/Inner");

          // #when
          yield* session.requestPass({ force: false });
          yield* session.awaitCompletion;

          // #then
          expect(
            yield* ownedPromise(
              () => readFile(join(workspace.output, "Mixed", "Inner", "index.json"), "utf8"),
              (cause) => new Error(String(cause)),
            ),
          ).toBe(innerBefore);
          expect(
            yield* ownedPromise(
              () => readFile(join(workspace.output, "Mixed", "._loose", "index.json"), "utf8"),
              (cause) => new Error(String(cause)),
            ),
          ).toBe(looseBefore);
          expect((yield* session.status).failure).toBeNull();
        }),
      ),
    );

    expect((await readJson<CategoryIndex>(join(workspace.output, "Mixed", "index.json"))).kind).toBe("category");
    expect(await exists(join(workspace.output, "Mixed", "._loose", "_thumbnails", "Loose.png.webp"))).toBe(true);
  });

  test("an unreadable image keeps its map and prior derived output", async () => {
    const unobservable = new Set<string>();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // #given
          const session = yield* startCatalogSynchronization({
            ...sessionOptions(workspace),
            sourceObservability: (path) => (unobservable.has(path) ? "file" : undefined),
          });

          yield* session.awaitCompletion;
          const preview = join(workspace.output, "Mixed", "Inner", "_previews", "Room.jpg.webp");
          const thumbnail = join(workspace.output, "Mixed", "Inner", "_thumbnails", "Room.jpg.webp");

          unobservable.add("Mixed/Inner/Room.jpg");
          yield* ownedPromise(
            () => writeFile(join(workspace.collection, "Mixed", "Inner", "Room.jpg"), "not an image"),
            (cause) => new Error(String(cause)),
          );

          // #when
          yield* session.requestPass({ force: false });
          yield* session.awaitCompletion;

          // #then
          expect(
            yield* ownedPromise(
              () => exists(preview),
              (cause) => new Error(String(cause)),
            ),
          ).toBe(true);
          expect(
            yield* ownedPromise(
              () => exists(thumbnail),
              (cause) => new Error(String(cause)),
            ),
          ).toBe(true);
        }),
      ),
    );

    expect(
      (await readJson<MapIndex>(join(workspace.output, "Mixed", "Inner", "index.json"))).variants.map((variant) => variant.file),
    ).toEqual(["Room.jpg"]);
  });

  test("a derived image failure stays visible while unrelated images publish", async () => {
    // #given
    await mkdir(join(workspace.output, PIT, "_previews", "Original Night.jpg.webp"), { recursive: true });
    const runtime = startEngineRuntime(sessionOptions(workspace));

    try {
      // #when
      await runtime.ready;
      const status = await runtime.status();
      const index = await readJson<MapIndex>(join(workspace.output, PIT, "index.json"));

      // #then
      expect(status.work.state).toBe("complete-with-errors");
      expect(status.work.errors.map((error) => error.work)).toContain(JSON.stringify(["image", PIT, "Original Night.jpg", "preview"]));
      expect(index.variants.find((variant) => variant.file === "Original Night.jpg")?.preview).toBeNull();
      expect(index.variants.find((variant) => variant.file === "Original Night.jpg")?.thumbnail).toBeNull();
      expect(index.variants.find((variant) => variant.file === "Empty Day.jpg")?.preview).toBe(`${PIT}/_previews/Empty Day.jpg.webp`);
      expect(await exists(join(workspace.output, PIT, "_thumbnails", "Empty Day.jpg.webp"))).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  test("image failures for deleted variants are cleared after the next successful scan", async () => {
    // #given
    await mkdir(join(workspace.output, PIT, "_previews", "Original Night.jpg.webp"), { recursive: true });
    const runtime = startEngineRuntime(sessionOptions(workspace));

    try {
      await runtime.ready;
      expect((await runtime.status()).work.errors.map((error) => error.work)).toContain(
        JSON.stringify(["image", PIT, "Original Night.jpg", "preview"]),
      );

      // #when
      await rm(join(workspace.collection, PIT, "Original Night.jpg"));
      await runtime.requestPass();

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await runtime.status();

        if (status.completed && status.work.errors.length === 0) break;

        if (attempt === 49) throw new Error("image failure did not clear after variant deletion");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // #then
      expect((await runtime.status()).work.errors).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  test("stopping during the first pass does not reject readiness", async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());

    const runtime = startEngineRuntime({
      ...sessionOptions(workspace),
      beforeImageWork: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    });

    try {
      // #given
      await Effect.runPromise(Deferred.await(entered));

      const readyOutcome = runtime.ready.then(
        () => "resolved" as const,
        () => "rejected" as const,
      );

      // #when
      const stopped = runtime.stop();
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await stopped;

      // #then
      expect(await Promise.race([readyOutcome, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10))])).not.toBe(
        "rejected",
      );
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await runtime.stop();
    }
  });

  test("same-map preview and thumbnail publication leaves the final index with both references", async () => {
    // #given / #when
    await withSession(workspace, async () => undefined);

    // #then
    const variant = (await readJson<MapIndex>(join(workspace.output, PIT, "index.json"))).variants.find(
      (candidate) => candidate.file === "Empty Day.jpg",
    );

    expect(variant?.preview).toBe(`${PIT}/_previews/Empty Day.jpg.webp`);
    expect(variant?.thumbnail).toBe(`${PIT}/_thumbnails/Empty Day.jpg.webp`);
  }, 15_000);

  test("a source change received during a running pass is published by a follow-up pass", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // #given
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let hasHeld = false;

          const session = yield* startCatalogSynchronization({
            ...sessionOptions(workspace),
            beforeMapIndexWrite: (map) => {
              if (hasHeld || map.path !== PIT) return Effect.void;
              hasHeld = true;

              return Effect.gen(function* () {
                yield* Deferred.succeed(held, undefined);
                yield* Deferred.await(release);
              });
            },
          });

          yield* Deferred.await(held);
          yield* ownedPromise(
            () => image(join(workspace.collection, "Pack 09", "Held Change", "Held.png"), 40, 40, "png"),
            (cause) => new Error(String(cause)),
          );

          // #when
          yield* session.requestPass({ force: false });
          yield* Deferred.succeed(release, undefined);
          yield* session.awaitCompletion;
        }),
      ),
    );

    // #then
    expect(await searchPaths()).toContain("Pack 09/Held Change");
    expect(
      (await readJson<MapIndex>(join(workspace.output, "Pack 09", "Held Change", "index.json"))).variants.map((variant) => variant.file),
    ).toEqual(["Held.png"]);
  }, 15_000);
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
