import { acquireOutputTree } from "@seigiard/sync-engine";
import { Effect } from "effect";
import { catalogStatePath } from "./catalog/engine/policy.ts";
import { type EngineStatus, startEngineRuntime } from "./catalog/engine/runtime.ts";
import { generateCatalog } from "./catalog/generate.ts";
import { RegenerationController } from "./catalog/regeneration.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logging/index.ts";
import { mapZipResponse } from "./map-zip.ts";
import { printImageResponse } from "./print-image.ts";

const config = loadConfig();

/** What the HTTP server and the process lifetime need from whichever composition owns the output tree. */
interface Composition {
  readonly trigger: () => void;
  readonly status?: () => Promise<EngineStatus>;
  readonly stop: () => Promise<void>;
}

async function regenerate(): Promise<void> {
  const startedAt = performance.now();
  log.info("Generate", "Generation started", { files: config.filesPath, data: config.dataPath });
  const summary = await Effect.runPromise(generateCatalog(config));
  log.info("Generate", "Generation finished", { ...summary, duration_ms: Math.round(performance.now() - startedAt) });
}

/**
 * The earlier composition. It holds the engine's output lease, so it and the engine composition cannot write one
 * output tree at the same time.
 */
async function startLegacyComposition(): Promise<Composition> {
  const release = await Effect.runPromise(acquireOutputTree(config.dataPath, catalogStatePath(config.dataPath)));

  const regeneration = new RegenerationController({
    debounceMs: config.regenerationDebounceMs,
    reconcileIntervalMs: config.reconcileIntervalMs,
    regenerate,
    onError: (error) => log.error("Generate", "Generation failed", error),
  });

  // Only a failed initial generation exits non-zero; later regeneration failures are logged by the controller.
  void regeneration.start().catch((error: Error) => {
    log.error("Generate", "Generation failed", error);
    process.exit(1);
  });

  return {
    trigger: () => regeneration.trigger(),
    stop: async () => {
      regeneration.stop();
      await release();
    },
  };
}

function startEngineComposition(): Composition {
  const runtime = startEngineRuntime({
    filesPath: config.filesPath,
    dataPath: config.dataPath,
    overridesPath: config.overridesPath,
    thumbnailConcurrency: config.thumbnailConcurrency,
    reconcileIntervalMs: config.reconcileIntervalMs,
  });

  // A failed first pass leaves nothing the process can serve; exit so the container restarts.
  runtime.ready.catch(() => process.exit(1));

  return {
    trigger: () => void runtime.requestPass().catch((error: Error) => log.error("Generate", "Pass request failed", error)),
    status: runtime.status,
    stop: runtime.stop,
  };
}

const composition = await (config.syncEngine ? Promise.resolve(startEngineComposition()) : startLegacyComposition()).catch(
  (error: Error) => {
    log.error("Server", "Could not start the synchronization composition", error);
    process.exit(1);
  },
);

log.info("Server", "Synchronization composition selected", { composition: config.syncEngine ? "engine" : "legacy" });

// These endpoints are reached only by the local watcher and operators, not through nginx.
const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/internal/regenerate" && req.method === "POST") {
      composition.trigger();

      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/internal/status" && req.method === "GET" && composition.status) return Response.json(await composition.status());

    if (url.pathname === "/api/map-zip") return mapZipResponse(req, config);

    if (url.pathname === "/api/print-image") return printImageResponse(req, config);

    if (url.pathname.startsWith("/api/")) return Response.json({ error: "Not implemented" }, { status: 501 });

    return new Response("Not found", { status: 404 });
  },
});

log.info("Server", "Listening", { port: server.port });

async function shutdown(): Promise<void> {
  log.info("Server", "Shutting down");
  void server.stop();
  await composition.stop();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());

process.on("SIGINT", () => void shutdown());
