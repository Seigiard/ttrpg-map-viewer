import { startEngineRuntime } from "./catalog/engine/runtime.ts";
import { loadConfig } from "./config.ts";
import { log } from "./logging/index.ts";
import { mapZipResponse } from "./map-zip.ts";
import { printImageResponse } from "./print-image.ts";

const config = loadConfig();

const synchronization = startEngineRuntime({
  filesPath: config.filesPath,
  dataPath: config.dataPath,
  overridesPath: config.overridesPath,
  thumbnailConcurrency: config.thumbnailConcurrency,
  reconcileIntervalMs: config.reconcileIntervalMs,
});

// A failed first pass without usable output leaves nothing the process can serve; exit so the container restarts.
synchronization.ready.catch(() => process.exit(1));

log.info("Server", "Synchronization started", { composition: "engine" });

// These endpoints are reached only by the local watcher and operators, not through nginx.
const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/internal/regenerate" && req.method === "POST") {
      void synchronization
        .requestPass(url.searchParams.get("force") === "1")
        .catch((error: Error) => log.error("Generate", "Pass request failed", error));

      return new Response(null, { status: 202 });
    }

    if (url.pathname === "/internal/status" && req.method === "GET") return Response.json(await synchronization.status());

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
  await synchronization.stop();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());

process.on("SIGINT", () => void shutdown());
