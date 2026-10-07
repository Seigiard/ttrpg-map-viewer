import { Effect } from "effect";
import { generateCatalog } from "./catalog/generate.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logging/index.ts";

const config = loadConfig();

// nginx reserves /api/* for Bun; no endpoint exists yet, so every call answers 501.
const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) return Response.json({ error: "Not implemented" }, { status: 501 });

    return new Response("Not found", { status: 404 });
  },
});

log.info("Server", "Listening", { port: server.port });

const startedAt = performance.now();

log.info("Generate", "Generation started", { files: config.filesPath, data: config.dataPath });

// A failed generation exits non-zero so Docker restarts the container instead of serving a stale catalog.
void Effect.runPromise(
  generateCatalog(config).pipe(
    Effect.map((summary) =>
      log.info("Generate", "Generation finished", { ...summary, duration_ms: Math.round(performance.now() - startedAt) }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        log.error("Generate", "Generation failed", error);
        process.exit(1);
      }),
    ),
  ),
);

function shutdown(): void {
  log.info("Server", "Shutting down");
  void server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);

process.on("SIGINT", shutdown);
