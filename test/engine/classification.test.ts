import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  ClassifierFailure,
  createClassificationStatus,
  isRetryableStatus,
  type Classifier,
  type ClassifierResponse,
} from "../../src/catalog/classification.ts";
import { startEngineRuntime } from "../../src/catalog/engine/runtime.ts";
import type { MapIndex } from "../../src/catalog/model.ts";
import { ownedPromise } from "../../src/utils/owned-promise.ts";
import { image, LAKESIDE, PIT, type Workspace, createWorkspace, video } from "./collection-fixture.ts";
import { sessionOptions, withSession } from "./session.ts";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  await rm(workspace.root, { recursive: true, force: true });
});

async function readJson<T>(path: string): Promise<T> {
  // SAFETY: the test reads files published through the catalog's public output contract.
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`${label} did not happen`);
}

const response: ClassifierResponse = {
  tags: ["sunken temple", "moss"],
  summary: "A moss-covered temple descends into dark water.",
  model: "fake-vision-v1",
  raw: { content: [{ type: "text", text: "unaltered fake response" }], id: "resp_fixture_17" },
};

function successfulClassifier(calls: { value: number }): Classifier {
  return () =>
    Effect.sync(() => {
      calls.value += 1;

      return response;
    });
}

describe("classification handler", () => {
  test("publishes a Map before the delayed classifier attaches its literal classification", async () => {
    // #given
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ClassifierResponse>();

    const classifier: Classifier = () =>
      Effect.sync(() => entered.resolve()).pipe(
        Effect.andThen(
          ownedPromise(
            () => release.promise,
            (cause) => new ClassifierFailure({ retryable: false, message: String(cause) }),
          ).pipe(Effect.uninterruptible),
        ),
      );

    const runtime = startEngineRuntime({
      ...sessionOptions(workspace),
      classification: { classifier, concurrency: 1 },
    });

    try {
      await runtime.ready;
      await entered.promise;

      // #when
      const pending = await readJson<MapIndex>(join(workspace.output, PIT, "index.json"));
      release.resolve(response);
      await waitFor("classification publication", async () => {
        const index = await readJson<MapIndex>(join(workspace.output, PIT, "index.json"));

        return index.classification?.summary === response.summary;
      });

      // #then
      const classified = await readJson<MapIndex>(join(workspace.output, PIT, "index.json"));
      expect({ pendingKind: pending.kind, pendingClassification: pending.classification, classified: classified.classification }).toEqual({
        pendingKind: "map",
        pendingClassification: undefined,
        classified: {
          tags: ["sunken temple", "moss"],
          summary: "A moss-covered temple descends into dark water.",
          model: "fake-vision-v1",
          promptVersion: expect.any(Number),
        },
      });
    } finally {
      await runtime.stop();
    }
  }, 15_000);

  test("reuses the cover cache after a second session, restart, and Map-folder rename", async () => {
    // #given
    const calls = { value: 0 };
    const classification = { classifier: successfulClassifier(calls), concurrency: 1 };

    // #when
    await withSession(workspace, async () => undefined, { classification });
    const afterFirstPass = calls.value;
    await withSession(workspace, async () => undefined, { classification });
    const afterRestart = calls.value;
    await rename(join(workspace.collection, LAKESIDE), join(workspace.collection, "czepuku", "CZEPEKU Fantasy Maps", "Renamed Lakeside"));
    await withSession(workspace, async () => undefined, { classification });

    // #then
    expect({ afterFirstPass, afterRestart, afterRename: calls.value }).toEqual({ afterFirstPass: 5, afterRestart: 5, afterRename: 5 });
  });

  test("stores each fake response unchanged in one classification cache file per classified Map", async () => {
    // #given
    const calls = { value: 0 };

    // #when
    await withSession(workspace, async () => undefined, { classification: { classifier: successfulClassifier(calls), concurrency: 1 } });
    const files = (await readdir(join(workspace.output, ".classification"))).sort();

    const cacheEntries = await Promise.all(
      files.map((file) => readJson<{ readonly raw: unknown }>(join(workspace.output, ".classification", file))),
    );

    // #then
    expect({ calls: calls.value, files: files.length, raws: cacheEntries.map((entry) => entry.raw) }).toEqual({
      calls: 5,
      files: 5,
      raws: Array.from({ length: 5 }, () => response.raw),
    });
  });

  test("lowercases, deduplicates, and caps classifier tags before publishing them", async () => {
    // #given
    const unnormalizedResponse: ClassifierResponse = {
      ...response,
      tags: ["Temple", "TEMPLE", ...Array.from({ length: 15 }, (_, index) => `Tag ${index + 1}`)],
    };

    const classifier: Classifier = () => Effect.succeed(unnormalizedResponse);

    // #when
    await withSession(workspace, async () => undefined, { classification: { classifier, concurrency: 1 } });
    const index = await readJson<MapIndex>(join(workspace.output, PIT, "index.json"));

    // #then
    expect(index.classification?.tags).toEqual([
      "temple",
      "tag 1",
      "tag 2",
      "tag 3",
      "tag 4",
      "tag 5",
      "tag 6",
      "tag 7",
      "tag 8",
      "tag 9",
      "tag 10",
      "tag 11",
      "tag 12",
      "tag 13",
      "tag 14",
    ]);
  });

  test("stops after a non-retryable failure, reports it, and retries the remaining Maps on the next pass", async () => {
    // #given
    await rm(workspace.collection, { recursive: true, force: true });
    await image(join(workspace.collection, "A First", "First.png"), 40, 40, "png");
    await image(join(workspace.collection, "B Second", "Second.png"), 40, 40, "png");
    const status = createClassificationStatus();
    const calls = { value: 0 };
    let spendLimit = true;

    const classifier: Classifier = () => {
      calls.value += 1;

      return spendLimit
        ? Effect.fail(new ClassifierFailure({ retryable: false, message: "fake spend limit reached" }))
        : Effect.succeed(response);
    };

    const runtime = startEngineRuntime({
      ...sessionOptions(workspace),
      classification: { classifier, concurrency: 1, status },
    });

    try {
      await runtime.ready;
      await waitFor("spend-limit status", async () =>
        (await runtime.status()).errors.some((error) => error.message.includes("fake spend limit reached")),
      );
      const stopped = await runtime.status();
      const stoppedSnapshot = status.snapshot();

      // #when
      spendLimit = false;
      await runtime.requestPass();
      await waitFor("both classifications after recovery", async () => {
        const paths = ["A First", "B Second"];
        const indexes = await Promise.all(paths.map((path) => readJson<MapIndex>(join(workspace.output, path, "index.json"))));

        return indexes.every((index) => index.classification?.summary === response.summary);
      });

      // #then
      expect({ calls: calls.value, stopped: stoppedSnapshot, errors: stopped.errors }).toEqual({
        calls: 3,
        stopped: {
          state: "stopped",
          stoppedReason: "fake spend limit reached",
          calls: 1,
          skipped: [],
        },
        errors: [{ source: "work", message: expect.stringContaining("fake spend limit reached") }],
      });
    } finally {
      await runtime.stop();
    }
  }, 15_000);

  test("honors a one-call process cap with more than one classifiable Map", async () => {
    // #given
    const calls = { value: 0 };

    // #when
    await withSession(workspace, async () => undefined, {
      classification: { classifier: successfulClassifier(calls), concurrency: 1, maxCalls: 1 },
    });

    // #then
    expect(calls.value).toBe(1);
  });

  test("skips an animated-only Map without calling the classifier or recording an error", async () => {
    // #given
    await rm(workspace.collection, { recursive: true, force: true });
    await image(join(workspace.collection, "Still Control", "Still.png"), 40, 40, "png");
    await video(join(workspace.collection, "Animated Only", "Loop.webm"));
    const status = createClassificationStatus();
    const calls = { value: 0 };
    let workErrors: readonly unknown[] = [];

    // #when
    await withSession(
      workspace,
      async (session) => {
        workErrors = (await Effect.runPromise(session.status)).work.errors;
      },
      {
        classification: { classifier: successfulClassifier(calls), concurrency: 1, status },
      },
    );

    // #then
    expect({ calls: calls.value, workErrors, status: status.snapshot() }).toEqual({
      calls: 1,
      workErrors: [],
      status: {
        state: "enabled",
        stoppedReason: null,
        calls: 1,
        skipped: [{ path: "Animated Only", reason: "animated-only" }],
      },
    });
  });

  test("retries one transient classifier failure before publishing the Map", async () => {
    // #given
    await rm(workspace.collection, { recursive: true, force: true });
    await image(join(workspace.collection, "Solo", "Cover.png"), 40, 40, "png");
    const status = createClassificationStatus();
    const calls = { value: 0 };

    const classifier: Classifier = () =>
      Effect.suspend(() => {
        calls.value += 1;

        if (calls.value === 1) return Effect.fail(new ClassifierFailure({ retryable: true, message: "transient classifier failure" }));

        return Effect.succeed(response);
      });

    const runtime = startEngineRuntime({ ...sessionOptions(workspace), classification: { classifier, concurrency: 1, status } });

    try {
      await runtime.ready;

      // #when
      await waitFor("classification after transient failure", () =>
        readJson<MapIndex>(join(workspace.output, "Solo", "index.json")).then(
          (index) => index.classification?.summary === response.summary,
          () => false,
        ),
      );
      const published = await readJson<MapIndex>(join(workspace.output, "Solo", "index.json"));
      const runtimeStatus = await runtime.status();

      // #then
      expect({
        calls: calls.value,
        classification: published.classification,
        status: status.snapshot(),
        errors: runtimeStatus.errors,
      }).toEqual({
        calls: 2,
        classification: {
          tags: ["sunken temple", "moss"],
          summary: "A moss-covered temple descends into dark water.",
          model: "fake-vision-v1",
          promptVersion: expect.any(Number),
        },
        status: { state: "enabled", stoppedReason: null, calls: 2, skipped: [] },
        errors: [],
      });
    } finally {
      await runtime.stop();
    }
  }, 15_000);

  test("records but does not stop after three retryable classifier failures", async () => {
    // #given
    await rm(workspace.collection, { recursive: true, force: true });
    await image(join(workspace.collection, "Solo", "Cover.png"), 40, 40, "png");
    const status = createClassificationStatus();
    const calls = { value: 0 };

    const classifier: Classifier = () =>
      Effect.suspend(() => {
        calls.value += 1;

        return Effect.fail(new ClassifierFailure({ retryable: true, message: "persistent classifier failure" }));
      });

    const runtime = startEngineRuntime({ ...sessionOptions(workspace), classification: { classifier, concurrency: 1, status } });

    try {
      await runtime.ready;

      // #when
      await waitFor("persistent classifier failure", async () =>
        (await runtime.status()).errors.some((error) => error.message.includes("persistent classifier failure")),
      );
      const published = await readJson<MapIndex>(join(workspace.output, "Solo", "index.json"));
      const runtimeStatus = await runtime.status();

      // #then
      expect({
        calls: calls.value,
        classification: published.classification,
        status: status.snapshot(),
        errors: runtimeStatus.errors,
      }).toEqual({
        calls: 3,
        classification: undefined,
        status: { state: "enabled", stoppedReason: null, calls: 3, skipped: [] },
        errors: [{ source: "work", message: expect.stringContaining("persistent classifier failure") }],
      });
    } finally {
      await runtime.stop();
    }
  }, 15_000);

  test("classifies the new cover preview after a delayed replacement render", async () => {
    // #given
    await rm(workspace.collection, { recursive: true, force: true });
    await image(join(workspace.collection, "Solo", "Cover.png"), 40, 40, "png");
    const previewStarted = Promise.withResolvers<void>();
    const releasePreview = Promise.withResolvers<void>();
    const classifierImages: Uint8Array[] = [];
    let delayCoverPreview = false;

    const classifier: Classifier = (request) =>
      Effect.sync(() => {
        classifierImages.push(request.image);

        return response;
      });

    await withSession(
      workspace,
      async (session) => {
        await image(join(workspace.collection, "Solo", "Cover.png"), 120, 60, "png");
        delayCoverPreview = true;

        // #when
        await Effect.runPromise(session.requestPass());
        await previewStarted.promise;
        await new Promise((resolve) => setTimeout(resolve, 100));
        releasePreview.resolve();
        await Effect.runPromise(session.awaitCompletion);
      },
      {
        classification: { classifier, concurrency: 1 },
        beforeImageWork: (map, variant, kind) => {
          if (!delayCoverPreview || map.path !== "Solo" || variant.name !== "Cover.png" || kind !== "preview") return Effect.void;

          return Effect.sync(() => previewStarted.resolve()).pipe(
            Effect.andThen(
              ownedPromise(
                () => releasePreview.promise,
                (cause) => new Error(String(cause)),
              ).pipe(Effect.orDie, Effect.uninterruptible),
            ),
          );
        },
      },
    );
    const dimensions = await sharp(classifierImages.at(-1) ?? new Uint8Array()).metadata();

    // #then
    expect({ calls: classifierImages.length, width: dimensions.width, height: dimensions.height }).toEqual({
      calls: 2,
      width: 120,
      height: 60,
    });
  }, 15_000);
});

describe("classifier HTTP failure policy", () => {
  test("retries only the retryable HTTP statuses from the contract", () => {
    // #given
    const statuses = [400, 401, 429, 500, 503];

    // #when
    const retryable = statuses.map(isRetryableStatus);

    // #then
    expect(retryable).toEqual([false, false, true, true, true]);
  });
});
