import { Effect } from "effect";
import { log } from "../logging/index.ts";
import { isAnimatedVariant, type FileListing, type MapNode } from "./classify.ts";
import { readTextFile } from "./file-system.ts";
import { type VariantDimensions, variantKey } from "./metadata.ts";

export interface CoverOverrides {
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

function pixelArea(map: MapNode, variant: FileListing, dimensions: VariantDimensions): number {
  const image = dimensions.get(variantKey(map, variant));

  return (image?.width ?? 0) * (image?.height ?? 0);
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

export function loadCoverOverrides(path: string): Effect.Effect<CoverOverrides, never> {
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

function selectCover(map: MapNode, dimensions: VariantDimensions): FileListing {
  const stillVariants = map.variants.filter((variant) => !isAnimatedVariant(variant.name));
  const candidates = stillVariants.length > 0 ? stillVariants : map.variants;

  return candidates
    .map(
      (variant) => ({ variant, score: preferenceScore(variant.name), area: pixelArea(map, variant, dimensions) }) satisfies CoverCandidate,
    )
    .sort((a, b) => b.score - a.score || b.area - a.area || a.variant.name.localeCompare(b.variant.name, "en", { sensitivity: "base" }))[0]!
    .variant;
}

export function warnUnknownCoverOverrides(maps: readonly MapNode[], overrides: CoverOverrides): void {
  const mapPaths = new Set(maps.map((map) => map.path));

  for (const [mapPath, variantName] of Object.entries(overrides.covers)) {
    if (!mapPaths.has(mapPath)) log.warn("Generate", "Cover override references an unknown map", { path: mapPath, variant: variantName });
  }
}

/** The override wins when it names one of the map's variants; otherwise the cover heuristic decides. */
export function selectMapCover(map: MapNode, overrides: CoverOverrides, dimensions: VariantDimensions): MapNode {
  const overriddenVariant = overrides.covers[map.path];

  if (overriddenVariant) {
    const cover = map.variants.find((variant) => variant.name === overriddenVariant);

    if (cover) return { ...map, cover };

    log.warn("Generate", "Cover override references a missing variant", { path: map.path, variant: overriddenVariant });
  }

  return { ...map, cover: selectCover(map, dimensions) };
}

/** Selects Covers after the Collection scan, including image metadata without decoding Originals. */
export function selectMapCovers(
  maps: readonly MapNode[],
  overridesPath: string,
  dimensions: VariantDimensions,
): Effect.Effect<readonly MapNode[], never> {
  return Effect.gen(function* () {
    const overrides = yield* loadCoverOverrides(overridesPath);
    warnUnknownCoverOverrides(maps, overrides);

    return maps.map((map) => selectMapCover(map, overrides, dimensions));
  });
}
