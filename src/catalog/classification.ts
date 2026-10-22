/* oxlint-disable anti-slop/no-array-filter-map, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Anthropic's response and cache files are untrusted JSON parsed at these I/O boundaries. */

import Anthropic from "@anthropic-ai/sdk";
import { Data, Effect } from "effect";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ownedPromise } from "../utils/owned-promise.ts";

export const CLASSIFICATION_PROMPT_VERSION = 1;

const MAX_TAGS = 15;

const MAX_IMAGE_EDGE = 1568;

export interface ClassifierRequest {
  readonly image: Uint8Array;
  readonly mediaType: "image/webp";
  readonly name: string;
  readonly categoryPath: readonly string[];
  readonly author?: string;
}

export interface ClassifierResponse {
  readonly tags: readonly string[];
  readonly summary: string;
  readonly model: string;
  readonly raw: unknown;
}

export class ClassifierFailure extends Data.TaggedError("ClassifierFailure")<{
  readonly retryable: boolean;
  readonly message: string;
}> {}

export interface ClassificationStatusSnapshot {
  readonly state: "disabled" | "enabled" | "stopped";
  readonly stoppedReason: string | null;
  readonly calls: number;
  readonly skipped: readonly { readonly path: string; readonly reason: "animated-only" }[];
}

export interface ClassificationStatusRegistry {
  readonly snapshot: () => ClassificationStatusSnapshot;
  readonly beginPass: () => void;
  readonly tryStartCall: (maxCalls?: number) => boolean;
  readonly stop: (reason: string) => void;
  readonly skipAnimatedOnly: (path: string) => void;
  readonly retain: (paths: ReadonlySet<string>) => void;
  readonly recordError: (path: string, message: string) => void;
  readonly clearError: (path: string) => void;
  readonly errors: () => readonly { readonly path: string; readonly message: string }[];
}

export interface ClassificationOptions {
  readonly classifier: Classifier;
  readonly concurrency?: number;
  readonly maxCalls?: number;
  readonly status?: ClassificationStatusRegistry;
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))].slice(0, MAX_TAGS);
}

export function normalizeClassifierResponse(response: ClassifierResponse): ClassifierResponse {
  return { ...response, tags: normalizeTags(response.tags) };
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function createClassificationStatus(initialState: "enabled" | "disabled" = "enabled"): ClassificationStatusRegistry {
  let state: ClassificationStatusSnapshot["state"] = initialState;
  let stoppedReason: string | null = null;
  let calls = 0;
  let skipped: { readonly path: string; readonly reason: "animated-only" }[] = [];
  const failures = new Map<string, string>();

  return {
    snapshot: () => ({ state, stoppedReason, calls, skipped: [...skipped] }),
    beginPass: () => {
      if (state !== "disabled") state = "enabled";
      stoppedReason = null;
      skipped = [];
    },
    tryStartCall: (maxCalls) => {
      if (state !== "enabled" || (maxCalls !== undefined && calls >= maxCalls)) return false;

      calls += 1;

      return true;
    },
    stop: (reason) => {
      if (state === "enabled") {
        state = "stopped";
        stoppedReason = reason;
      }
    },
    skipAnimatedOnly: (path) => {
      if (!skipped.some((entry) => entry.path === path)) skipped.push({ path, reason: "animated-only" });
    },
    retain: (paths) => {
      for (const path of failures.keys()) {
        if (!paths.has(path)) failures.delete(path);
      }
    },
    recordError: (path, message) => failures.set(path, message),
    clearError: (path) => failures.delete(path),
    errors: () => [...failures].map(([path, message]) => ({ path, message })),
  };
}

function statusFromCause(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;

  const value = cause as {
    readonly status?: unknown;
    readonly error?: { readonly status?: unknown };
    readonly response?: { readonly status?: unknown };
  };

  const status = value.status ?? value.error?.status ?? value.response?.status;

  return typeof status === "number" ? status : undefined;
}

function errorMessage(cause: unknown, apiKey: string): string {
  const message = cause instanceof Error ? cause.message : "Anthropic request failed";

  return message.replaceAll(apiKey, "[redacted]");
}

class AnthropicRequestError extends Error {
  readonly status: number | undefined;

  constructor(cause: unknown, status: number | undefined, apiKey: string) {
    super(errorMessage(cause, apiKey));
    this.status = status;
  }
}

interface AnthropicContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
}

function parseStructuredResponse(value: unknown, model: string): ClassifierResponse {
  if (typeof value !== "object" || value === null) throw new Error("Anthropic response was not an object");

  const response = value as { readonly content?: unknown; readonly model?: unknown };
  const content = Array.isArray(response.content) ? response.content : [];

  const tool = content.find(
    (block): block is AnthropicContentBlock =>
      typeof block === "object" &&
      block !== null &&
      (block as AnthropicContentBlock).type === "tool_use" &&
      (block as AnthropicContentBlock).name === "classify_map",
  );

  const text = content.find(
    (block): block is AnthropicContentBlock =>
      typeof block === "object" && block !== null && (block as AnthropicContentBlock).type === "text",
  );

  const serialized = text?.text;
  const parsed: unknown = tool?.input ?? (typeof serialized === "string" ? JSON.parse(serialized) : undefined);

  if (typeof parsed !== "object" || parsed === null) throw new Error("Anthropic classification JSON was not an object");

  const result = parsed as { readonly tags?: unknown; readonly summary?: unknown };

  if (!Array.isArray(result.tags) || !result.tags.every((tag) => typeof tag === "string") || typeof result.summary !== "string")
    throw new Error("Anthropic classification JSON did not match the schema");

  return {
    tags: result.tags,
    summary: result.summary,
    model: typeof response.model === "string" ? response.model : model,
    raw: value,
  };
}

export function createAnthropicClassifier(options: {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): Classifier {
  const client = new Anthropic({
    apiKey: options.apiKey,
    fetch: options.fetch,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 120_000,
  });

  return (request) =>
    ownedPromise(
      async (signal) => {
        try {
          const response = await client.messages.create(
            {
              model: options.model,
              max_tokens: 256,
              tool_choice: { type: "tool", name: "classify_map" },
              tools: [
                {
                  name: "classify_map",
                  description: "Return the map's visual tags and one-sentence summary.",
                  input_schema: {
                    type: "object",
                    properties: {
                      tags: { type: "array", items: { type: "string" } },
                      summary: { type: "string" },
                    },
                    required: ["tags", "summary"],
                    additionalProperties: false,
                  },
                },
              ],
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Classify this tabletop RPG map. Use the classify_map tool. Tags must be lowercase English words or short phrases. Map name: ${request.name}. Category path: ${request.categoryPath.join(" / ")}. Author: ${request.author ?? "unknown"}.`,
                    },
                    {
                      type: "image",
                      source: { type: "base64", media_type: request.mediaType, data: Buffer.from(request.image).toString("base64") },
                    },
                  ],
                },
              ],
            },
            { signal },
          );

          return parseStructuredResponse(response, options.model);
        } catch (cause) {
          const status = statusFromCause(cause);

          throw new AnthropicRequestError(cause, status, options.apiKey);
        }
      },
      (cause) => {
        const status = statusFromCause(cause);

        return new ClassifierFailure({ retryable: isRetryableStatus(status ?? 0), message: errorMessage(cause, options.apiKey) });
      },
    );
}

export type Classifier = (request: ClassifierRequest) => Effect.Effect<ClassifierResponse, ClassifierFailure>;

export function classificationCacheKey(name: string, size: number, mtimeMs: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ name, size, mtimeMs, promptVersion: CLASSIFICATION_PROMPT_VERSION }))
    .digest("hex");
}

export interface ClassificationCacheEntry {
  readonly raw: unknown;
  readonly model: string;
  readonly promptVersion: number;
  readonly requestedAt: string;
  readonly tags: readonly string[];
  readonly summary: string;
}

export function readClassificationCache(dataPath: string, key: string): Effect.Effect<ClassificationCacheEntry | null, never> {
  return ownedPromise(
    () => readFile(join(dataPath, ".classification", `${key}.json`), "utf8"),
    (cause) => new Error(String(cause)),
  ).pipe(
    Effect.catch(() => Effect.succeed(null)),
    Effect.flatMap((content) => {
      if (content === null) return Effect.succeed(null);

      try {
        const entry: unknown = JSON.parse(content);

        if (typeof entry !== "object" || entry === null) return Effect.succeed(null);

        const candidate = entry as Partial<ClassificationCacheEntry>;

        return typeof candidate.model === "string" &&
          typeof candidate.promptVersion === "number" &&
          typeof candidate.requestedAt === "string" &&
          Array.isArray(candidate.tags) &&
          candidate.tags.every((tag) => typeof tag === "string") &&
          typeof candidate.summary === "string"
          ? Effect.succeed(candidate as ClassificationCacheEntry)
          : Effect.succeed(null);
      } catch {
        return Effect.succeed(null);
      }
    }),
  );
}

export function writeClassificationCache(dataPath: string, key: string, entry: ClassificationCacheEntry): Effect.Effect<void, never> {
  return ownedPromise(
    async () => {
      const directory = join(dataPath, ".classification");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${key}.json`), JSON.stringify(entry));
    },
    (cause) => new Error(String(cause)),
  ).pipe(Effect.catch(() => Effect.void));
}

export const CLASSIFICATION_IMAGE_MAX_SIZE = MAX_IMAGE_EDGE;

/* oxlint-enable anti-slop/no-array-filter-map, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion */
