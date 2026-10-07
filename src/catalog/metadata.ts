import { Effect } from "effect";
import { join } from "node:path";
import sharp from "sharp";
import { log } from "../logging/index.ts";
import { ownedPromise } from "../utils/owned-promise.ts";
import type { FileListing, FolderListing, MapNode } from "./classify.ts";
import { readTextFile } from "./file-system.ts";
import type { MapMetadata, MapSize, VariantMetadata } from "./model.ts";

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export type VariantDimensions = ReadonlyMap<string, ImageDimensions>;

interface CzepekuVariant {
  readonly name: string;
  readonly grid: string;
}

interface CzepekuEntry {
  readonly name: string;
  readonly type: "map" | "scene" | "None";
  readonly cats: readonly string[];
  readonly maps: readonly CzepekuVariant[];
}

interface DungeondraftExport {
  readonly resolution?: {
    readonly map_size?: { readonly x?: number; readonly y?: number };
    readonly pixels_per_grid?: number;
  };
}

interface FilenameMetadata {
  readonly metadata?: MapMetadata;
  readonly variant?: VariantMetadata;
}

function variantKey(map: MapNode, variant: FileListing): string {
  return `${map.sourcePath}\u0000${variant.name}`;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");

  return dot > 0 ? name.slice(0, dot) : name;
}

function validSize(width: number | undefined, height: number | undefined): MapSize | undefined {
  return width !== undefined && Number.isInteger(width) && width > 0 && height !== undefined && Number.isInteger(height) && height > 0
    ? { width, height }
    : undefined;
}

function parseGrid(grid: string): VariantMetadata {
  const match = /^(\d+)x(\d+)@(.+)$/iu.exec(grid.trim());

  if (!match) return {};
  const width = Number(match[1]);
  const height = Number(match[2]);
  const scale = Number(match[3]);
  const mapSize = validSize(width, height);

  return Number.isFinite(scale) && scale > 0 ? { mapSize, gridScale: scale } : {};
}

function parseCzepeku(content: string, path: string): readonly CzepekuEntry[] {
  try {
    // SAFETY: Czepeku publishes this array with the documented entry fields; malformed JSON is rejected below.
    return JSON.parse(content) as CzepekuEntry[];
  } catch {
    log.warn("Generate", "Invalid Czepeku metadata file", { path });

    return [];
  }
}

function readCzepekuMetadata(listing: FolderListing, filesPath: string): Effect.Effect<readonly CzepekuEntry[], never> {
  const pending = [listing];

  for (let folder = pending.pop(); folder; folder = pending.pop()) {
    const dataFile = folder.files.find((file) => normalized(file.name) === "czepeku_data.json");

    if (dataFile) {
      const path = join(filesPath, folder.path, dataFile.name);

      return readTextFile(path).pipe(
        Effect.map((content) => parseCzepeku(content, path)),
        Effect.catch(() =>
          Effect.sync(() => {
            log.warn("Generate", "Could not read Czepeku metadata file", { path });

            return [];
          }),
        ),
      );
    }

    pending.push(...folder.subfolders);
  }

  return Effect.succeed([]);
}

/** Reads image headers once for both Cover selection and filename-derived grid scale. */
export function readVariantDimensions(maps: readonly MapNode[], filesPath: string): Effect.Effect<VariantDimensions, never> {
  return Effect.forEach(
    maps.flatMap((map) => map.variants.map((variant) => ({ map, variant }))),
    ({ map, variant }) =>
      ownedPromise(
        () => sharp(join(filesPath, map.sourcePath, variant.name)).metadata(),
        () => undefined,
      ).pipe(
        Effect.map((metadata) => ({ key: variantKey(map, variant), dimensions: validSize(metadata.width, metadata.height) })),
        Effect.catch(() => Effect.succeed({ key: variantKey(map, variant), dimensions: undefined })),
      ),
    { concurrency: 16 },
  ).pipe(Effect.map((entries) => new Map(entries.flatMap(({ key, dimensions }) => (dimensions ? [[key, dimensions] as const] : [])))));
}

function parseDnDavid(name: string, dimensions: ImageDimensions | undefined): FilenameMetadata {
  const match = /\[(\d+)x(\d+)\](?:\s*\(([^)]+)\)|\s+(.+))?$/u.exec(stem(name));

  if (!match) return {};
  const mapSize = validSize(Number(match[1]), Number(match[2]));
  const author = match[3] ?? match[4];
  const gridScale = mapSize && dimensions ? dimensions.width / mapSize.width : undefined;

  return {
    metadata: author ? { author: author.trim(), mapSize } : { mapSize },
    variant: gridScale ? { gridScale } : undefined,
  };
}

function uniqueMapSize(variants: readonly FileListing[]): MapSize | undefined {
  const sizes = variants.flatMap((variant) => (variant.metadata?.mapSize ? [variant.metadata.mapSize] : []));
  const [first] = sizes;

  return first && sizes.every((size) => size.width === first.width && size.height === first.height) ? first : undefined;
}

function withVariants(map: MapNode, variants: readonly FileListing[]): MapNode["variants"] {
  const [first, ...rest] = variants;

  return first ? [first, ...rest] : map.variants;
}

function czepekuMetadata(map: MapNode, entries: readonly CzepekuEntry[], dataDirectory: string): MapNode {
  if (!map.sourcePath.startsWith(dataDirectory === "" ? "" : `${dataDirectory}/`)) return map;
  const entry = entries.find((candidate) => normalized(candidate.name) === normalized(map.name));

  if (!entry) return map;

  const variants = withVariants(
    map,
    map.variants.map((variant) => {
      const source = entry.maps.find((candidate) => normalized(candidate.name) === normalized(stem(variant.name)));
      const parsed = source ? parseGrid(source.grid) : {};

      return parsed.mapSize || parsed.gridScale ? { ...variant, metadata: parsed } : variant;
    }),
  );

  const folderCategory = map.sourcePath.split("/").at(-2);

  const tags = [
    ...entry.cats.filter((category) => normalized(category) !== normalized(folderCategory ?? "")),
    ...(entry.type === "None" ? [] : [entry.type]),
  ];

  return {
    ...map,
    variants,
    cover: variants.find((variant) => variant.name === map.cover.name) ?? map.cover,
    metadata: { author: "Czepeku", tags, mapSize: uniqueMapSize(variants) },
  };
}

function filenameMetadata(map: MapNode, dimensions: VariantDimensions): MapNode {
  const variants = withVariants(
    map,
    map.variants.map((variant) => {
      const parsed = parseDnDavid(variant.name, dimensions.get(variantKey(map, variant)));

      return parsed.metadata || parsed.variant ? { ...variant, metadata: parsed.variant } : variant;
    }),
  );

  const first = map.variants.map((variant) => parseDnDavid(variant.name, dimensions.get(variantKey(map, variant))).metadata).find(Boolean);

  return first
    ? {
        ...map,
        variants,
        cover: variants.find((variant) => variant.name === map.cover.name) ?? map.cover,
        metadata: { ...first, mapSize: uniqueMapSize(variants) ?? first.mapSize },
      }
    : map;
}

function dungeondraftStem(name: string): string {
  return normalized(stem(name).replace(/vtt$/iu, ""));
}

function dungeondraftMetadata(map: MapNode, folder: FolderListing | undefined, filesPath: string): Effect.Effect<MapNode, never> {
  if (!folder) return Effect.succeed(map);
  const exports = folder.files.filter((file) => file.name.toLowerCase().endsWith(".dd2vtt"));

  return Effect.forEach(exports, (file) =>
    readTextFile(join(filesPath, folder.path, file.name)).pipe(
      Effect.map((content) => {
        // SAFETY: Dungeondraft exports use the documented resolution fields; malformed exports are ignored by the read boundary.
        return { file, parsed: JSON.parse(content) as DungeondraftExport };
      }),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
  ).pipe(
    Effect.map((records) => {
      let variants = map.variants;

      for (const record of records) {
        if (!record) continue;
        const resolution = record.parsed.resolution;
        const mapSize = validSize(resolution?.map_size?.x, resolution?.map_size?.y);
        const gridScale = resolution?.pixels_per_grid;

        if (!mapSize || gridScale === undefined || !Number.isFinite(gridScale) || gridScale <= 0) continue;
        const prefix = dungeondraftStem(record.file.name);
        const matches = variants.filter((variant) => normalized(stem(variant.name)).startsWith(prefix));
        const targets = matches.length > 0 ? matches : variants;
        variants = withVariants(
          map,
          variants.map((variant) => (targets.includes(variant) ? { ...variant, metadata: { mapSize, gridScale } } : variant)),
        );
      }

      return variants === map.variants
        ? map
        : { ...map, variants, cover: variants.find((variant) => variant.name === map.cover.name) ?? map.cover };
    }),
  );
}

/** Applies independent metadata sources in ascending precedence: filename, Czepeku, then Dungeondraft. */
export function enrichMapMetadata(
  maps: readonly MapNode[],
  listing: FolderListing,
  filesPath: string,
  dimensions: VariantDimensions,
): Effect.Effect<readonly MapNode[], never> {
  return Effect.gen(function* () {
    const czepeku = yield* readCzepekuMetadata(listing, filesPath);

    const dataDirectory = (() => {
      const pending = [listing];

      for (let folder = pending.pop(); folder; folder = pending.pop()) {
        if (folder.files.some((file) => normalized(file.name) === "czepeku_data.json")) return folder.path;
        pending.push(...folder.subfolders);
      }

      return undefined;
    })();

    const folders = new Map<string, FolderListing>();
    const pending = [listing];

    for (let folder = pending.pop(); folder; folder = pending.pop()) {
      folders.set(folder.path, folder);
      pending.push(...folder.subfolders);
    }

    return yield* Effect.forEach(maps, (map) =>
      dungeondraftMetadata(
        czepekuMetadata(filenameMetadata(map, dimensions), czepeku, dataDirectory ?? "\u0000"),
        folders.get(map.sourcePath),
        filesPath,
      ),
    );
  });
}
