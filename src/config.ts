import { log } from "./logging/index.ts";

export interface Config {
  /** Read-only root of the collection. */
  readonly filesPath: string;
  /** Root of the generated output mirror tree. */
  readonly dataPath: string;
  /** JSON file of manually selected Covers, outside the Collection. */
  readonly overridesPath: string;
  readonly port: number;
  readonly thumbnailConcurrency: number;
}

function parseIntInRange(name: string, value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    log.error("Config", `Invalid ${name}: ${value} (must be ${min}-${max})`);
    process.exit(1);
  }

  return parsed;
}

export function loadConfig(): Config {
  return {
    filesPath: process.env.FILES || "./files",
    dataPath: process.env.DATA || "./out",
    overridesPath: process.env.OVERRIDES || "/config/overrides.json",
    port: parseIntInRange("PORT", process.env.PORT || "3000", 1, 65535),
    // A 16000×22000 original needs hundreds of MB while it decodes; keep parallel decodes low.
    thumbnailConcurrency: parseIntInRange("THUMBNAIL_CONCURRENCY", process.env.THUMBNAIL_CONCURRENCY || "2", 1, 16),
  };
}
