import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const STYLE_SOURCES = ["reset.css", "index.css"];

const uiDir = join(import.meta.dir, "..");

const staticDir = join(uiDir, "..", "static");

async function buildCss(): Promise<void> {
  const parts = await Promise.all(STYLE_SOURCES.map((file) => Bun.file(join(uiDir, "styles", file)).text()));
  await Bun.write(join(staticDir, "style.css"), parts.join("\n"));
}

async function buildJs(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [join(uiDir, "app", "main.ts")],
    target: "browser",
    minify: true,
    naming: "main.js",
  });

  if (!build.success) {
    for (const message of build.logs) console.error(message);
    throw new Error("build:ui main.js failed");
  }

  await Bun.write(join(staticDir, "main.js"), await build.outputs[0]!.text());
}

await rm(staticDir, { recursive: true, force: true });

await mkdir(staticDir, { recursive: true });

await Promise.all([buildCss(), buildJs(), Bun.write(join(staticDir, "index.html"), Bun.file(join(uiDir, "app", "index.html")))]);

console.log(`build:ui → ${staticDir}`);
