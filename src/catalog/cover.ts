import { Effect } from "effect";
import { join } from "node:path";
import sharp from "sharp";
import { log } from "../logging/index.ts";
import { ownedPromise } from "../utils/owned-promise.ts";
import { isAnimatedVariant, type FileListing, type MapNode } from "./classify.ts";
import { readTextFile } from "./file-system.ts";

interface CoverOverrides {
  readonly covers: Readonly<Record<string, string>>;
}

interface CoverCandidate {
  readonly variant: FileListing;
  readonly score: number;
  readonly area: number;
}

const PREFERRED_TOKENS = new Map<string, number>([
  ["original", 100],
  ["base", 50],
  ["day", 20],
  ["gl", 10],
  ["gridless", 10],
  ["hd", 5],
]);

function variantTokens(name: string): readonly string[] {
  const extension = name.lastIndexOf(".");
  const stem = extension > 0 ? name.slice(0, extension) : name;

  return stem
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[ _.-]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function preferenceScore(name: string): number {
  const tokens = variantTokens(name);
  const preferred = tokens.reduce((score, token) => score + (PREFERRED_TOKENS.get(token) ?? 0), 0);

  return tokens.includes("night") ? preferred - 1_000 : preferred;
}

function pixelArea(path: string): Effect.Effect<number, never> {
  return ownedPromise(
    () => sharp(path).metadata(),
    () => undefined,
  ).pipe(
    Effect.map((metadata) => (metadata.width ?? 0) * (metadata.height ?? 0)),
    Effect.catch(() => Effect.succeed(0)),
  );
}

function parseOverrides(content: string, path: string): CoverOverrides {
  try {
    const { covers = {} } = JSON.parse(content);

    return { covers: covers instanceof Object && !Array.isArray(covers) ? covers : {} };
  } catch {
    // Treat invalid optional configuration as absent so it cannot block catalog generation.
  }

  log.warn("Generate", "Invalid cover overrides file; using cover heuristic", { path });

  return { covers: {} };
}

function loadOverrides(path: string): Effect.Effect<CoverOverrides, never> {
  return readTextFile(path).pipe(
    Effect.map((content) => parseOverrides(content, path)),
    Effect.catchTag("FileSystemNotFound", () => Effect.succeed({ covers: {} })),
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn("Generate", "Could not read cover overrides file; using cover heuristic", { path, error: error.message });

        return { covers: {} };
      }),
    ),
  );
}

function selectCover(map: MapNode, filesPath: string): Effect.Effect<FileListing, never> {
  const stillVariants = map.variants.filter((variant) => !isAnimatedVariant(variant.name));
  const candidates = stillVariants.length > 0 ? stillVariants : map.variants;

  return Effect.forEach(candidates, (variant) =>
    pixelArea(join(filesPath, map.path, variant.name)).pipe(
      Effect.map((area): CoverCandidate => ({ variant, score: preferenceScore(variant.name), area })),
    ),
  ).pipe(
    Effect.map(
      (scored) =>
        [...scored].sort(
          (a, b) => b.score - a.score || b.area - a.area || a.variant.name.localeCompare(b.variant.name, "en", { sensitivity: "base" }),
        )[0]!.variant,
    ),
  );
}

/** Selects Covers after the Collection scan, including image metadata without decoding Originals. */
export function selectMapCovers(
  maps: readonly MapNode[],
  filesPath: string,
  overridesPath: string,
): Effect.Effect<readonly MapNode[], never> {
  return Effect.gen(function* () {
    const overrides = yield* loadOverrides(overridesPath);
    const mapPaths = new Set(maps.map((map) => map.path));

    for (const [mapPath, variantName] of Object.entries(overrides.covers)) {
      if (!mapPaths.has(mapPath)) log.warn("Generate", "Cover override references an unknown map", { path: mapPath, variant: variantName });
    }

    return yield* Effect.forEach(maps, (map) => {
      const overriddenVariant = overrides.covers[map.path];

      if (overriddenVariant) {
        const cover = map.variants.find((variant) => variant.name === overriddenVariant);

        if (cover) return Effect.succeed({ ...map, cover });

        log.warn("Generate", "Cover override references a missing variant", { path: map.path, variant: overriddenVariant });
      }

      return selectCover(map, filesPath).pipe(Effect.map((cover) => ({ ...map, cover })));
    });
  });
}
