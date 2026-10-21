import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createAnthropicClassifier } from "../../src/catalog/classification.ts";

const request = {
  image: new Uint8Array([1, 2, 3]),
  mediaType: "image/webp" as const,
  name: "Clockwork Vault",
  categoryPath: ["Ruins"],
};

const successResponse = {
  id: "msg_test_1",
  type: "message",
  model: "claude-haiku-5-5",
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "toolu_test_1",
      name: "classify_map",
      input: { tags: ["clockwork"], summary: "A clockwork vault beneath ancient ruins." },
    },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

async function callWithStatus(status: 200 | 400 | 429): Promise<{
  readonly calls: number;
  readonly signalObserved: boolean;
  readonly result: { readonly summary: string } | { readonly retryable: boolean | null };
}> {
  let calls = 0;
  let signalObserved = false;

  const fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      signalObserved ||= init?.signal instanceof AbortSignal;

      return new Response(
        JSON.stringify(
          status === 200
            ? successResponse
            : { type: "error", error: { type: status === 429 ? "rate_limit_error" : "invalid_request_error", message: `fake ${status}` } },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    },
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch;

  const options: Parameters<typeof createAnthropicClassifier>[0] & { readonly fetch: typeof globalThis.fetch; readonly timeoutMs: number } =
    {
      apiKey: "test-api-key",
      model: "claude-haiku-5-5",
      fetch,
      timeoutMs: 1_000,
    };

  const classifier = createAnthropicClassifier(options);

  const result = await Effect.runPromise(
    classifier(request).pipe(
      Effect.map((response) => ({ summary: response.summary })),
      Effect.catchTag("ClassifierFailure", (failure) => Effect.succeed({ retryable: failure.retryable })),
    ),
  );

  return { calls, signalObserved, result };
}

describe("Anthropic classifier", () => {
  test("makes one abortable request and maps literal 429 and 400 responses", async () => {
    // #given
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Promise.reject(new Error("network disabled in classifier unit test")), {
      preconnect: originalFetch.preconnect,
    });

    try {
      // #when
      const [success, rateLimit, invalidRequest] = await Promise.all([callWithStatus(200), callWithStatus(429), callWithStatus(400)]);

      // #then
      expect({ success, rateLimit, invalidRequest }).toEqual({
        success: { calls: 1, signalObserved: true, result: { summary: "A clockwork vault beneath ancient ruins." } },
        rateLimit: { calls: 1, signalObserved: true, result: { retryable: true } },
        invalidRequest: { calls: 1, signalObserved: true, result: { retryable: false } },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
