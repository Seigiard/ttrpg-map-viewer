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
  readonly anthropicApiKey?: string;
  readonly classifyModel: string;
  readonly classifyConcurrency: number;
  readonly classifyMaxCalls?: number;
  readonly reconcileIntervalMs: number;
}

function parseIntInRange(name: string, value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    log.error("Config", `Invalid ${name}: ${value} (must be ${min}-${max})`);
    process.exit(1);
  }

  return parsed;
}

function parseOptionalPositiveInt(name: string, value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseIntInRange(name, value, 1, Number.MAX_SAFE_INTEGER);
}

export function loadConfig(): Config {
  return {
    filesPath: process.env.FILES || "./files",
    dataPath: process.env.DATA || "./out",
    overridesPath: process.env.OVERRIDES || "/config/overrides.json",
    port: parseIntInRange("PORT", process.env.PORT || "3000", 1, 65535),
    // A 16000×22000 original needs hundreds of MB while it decodes; keep parallel decodes low.
    thumbnailConcurrency: parseIntInRange("THUMBNAIL_CONCURRENCY", process.env.THUMBNAIL_CONCURRENCY || "2", 1, 16),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    classifyModel: process.env.CLASSIFY_MODEL || "claude-haiku-5-5",
    classifyConcurrency: parseIntInRange("CLASSIFY_CONCURRENCY", process.env.CLASSIFY_CONCURRENCY || "2", 1, 8),
    classifyMaxCalls: parseOptionalPositiveInt("CLASSIFY_MAX_CALLS", process.env.CLASSIFY_MAX_CALLS),
    reconcileIntervalMs: parseIntInRange("RECONCILE_INTERVAL", process.env.RECONCILE_INTERVAL || "1800", 1, 86_400) * 1000,
  };
}
