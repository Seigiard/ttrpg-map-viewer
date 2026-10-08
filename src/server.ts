import { Effect } from "effect";
import { generateCatalog } from "./catalog/generate.ts";
import { RegenerationController } from "./catalog/regeneration.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logging/index.ts";
import { mapZipResponse } from "./map-zip.ts";
import { printImageResponse } from "./print-image.ts";

const config = loadConfig();

async function regenerate(): Promise<void> {
  const startedAt = performance.now();
  log.info("Generate", "Generation started", { files: config.filesPath, data: config.dataPath });
  const summary = await Effect.runPromise(generateCatalog(config));
  log.info("Generate", "Generation finished", { ...summary, duration_ms: Math.round(performance.now() - startedAt) });
}

const regeneration = new RegenerationController({
  debounceMs: config.regenerationDebounceMs,
  reconcileIntervalMs: config.reconcileIntervalMs,
  regenerate,
  onError: (error) => log.error("Generate", "Generation failed", error),
});

// This endpoint is reached only by the local watcher, not through nginx.
const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/internal/regenerate" && req.method === "POST") {
      regeneration.trigger();

      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/api/map-zip") return mapZipResponse(req, config);

    if (url.pathname === "/api/print-image") return printImageResponse(req, config);

    if (url.pathname.startsWith("/api/")) return Response.json({ error: "Not implemented" }, { status: 501 });

    return new Response("Not found", { status: 404 });
  },
});

log.info("Server", "Listening", { port: server.port });

// Only a failed initial generation exits non-zero; later regeneration failures are logged by the controller.
void regeneration.start().catch((error: Error) => {
  log.error("Generate", "Generation failed", error);
  process.exit(1);
});

function shutdown(): void {
  log.info("Server", "Shutting down");
  regeneration.stop();
  void server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);

process.on("SIGINT", shutdown);
