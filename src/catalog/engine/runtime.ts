import { Cause, Effect, Fiber, Schedule } from "effect";
import { log } from "../../logging/index.ts";
import { type CatalogSynchronizationOptions, startCatalogSynchronization } from "./composition.ts";
import { createImageFailureRegistry } from "./image-status.ts";
import { workKey } from "./work.ts";

const REPORT_INTERVAL_MS = 5_000;

const firstLine = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n")[0] ?? "";

export interface EngineRuntime {
  /** Resolves when startup establishes usable output; rejects only when no output can be served. */
  readonly ready: Promise<void>;
  /** Asks for a pass; the engine combines requests that arrive while one runs. */
  readonly requestPass: (force?: boolean) => Promise<void>;
  readonly status: () => Promise<EngineStatus>;
  readonly stop: () => Promise<void>;
}

export interface EngineStatus {
  readonly available: boolean;
  readonly availableFrom: string | null;
  readonly verifying: boolean;
  readonly completed: boolean;
  readonly errors: readonly { readonly source: "work" | "pass"; readonly message: string }[];
  readonly state: string;
  readonly pass: string | null;
  readonly followUp: string | null;
  readonly failure: string | null;
  readonly work: {
    readonly state: string;
    readonly pending: number;
    readonly errors: readonly { readonly work: string; readonly message: string }[];
  };
}

/**
 * Promise-facing transport adapter for the Effect-owned session. The engine owns scans, pass coalescing, the
 * periodic timer and shutdown; this adapter translates HTTP input and the process lifetime, and logs failures.
 */
export function startEngineRuntime(options: CatalogSynchronizationOptions): EngineRuntime {
  const controller = new AbortController();
  const imageFailures = createImageFailureRegistry();
  const session = Promise.withResolvers<Effect.Success<ReturnType<typeof startCatalogSynchronization>>>();
  const ready = Promise.withResolvers<void>();
  session.promise.catch(() => undefined);
  ready.promise.catch(() => undefined);

  const snapshot = (live: Effect.Success<ReturnType<typeof startCatalogSynchronization>>) =>
    Effect.gen(function* () {
      const status = yield* live.status;

      const workErrors = [
        ...status.work.errors.map((error) => ({ work: workKey(error.work), message: firstLine(error.cause) })),
        ...imageFailures.snapshot(),
      ];

      const workState = status.work.state === "complete" && workErrors.length > 0 ? "complete-with-errors" : status.work.state;
      const verifying = status.state === "working" || status.pass !== null || status.followUp !== null || workState === "working";

      return {
        available: status.availability !== null,
        availableFrom: status.availability,
        verifying,
        completed:
          !verifying &&
          status.state !== "failed" &&
          status.failure === null &&
          (workState === "complete" || workState === "complete-with-errors"),
        errors: [
          ...workErrors.map((error) => ({ source: "work" as const, message: `${error.work}: ${error.message}` })),
          ...(status.failure ? [{ source: "pass" as const, message: firstLine(status.failure) }] : []),
        ],
        state: status.state,
        pass: status.pass?.kind ?? null,
        followUp: status.followUp?.kind ?? null,
        failure: status.failure ? firstLine(status.failure) : null,
        work: {
          state: workState,
          pending: status.work.pending,
          errors: workErrors,
        },
      } satisfies EngineStatus;
    });

  // Reports each distinct failure once; it observes the session and schedules nothing.
  const report = (live: Effect.Success<ReturnType<typeof startCatalogSynchronization>>) => {
    let reported = "";

    return snapshot(live).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          const key = JSON.stringify([status.failure, status.work.errors]);

          if (key === reported) return;
          reported = key;

          if (status.failure) log.error("Generate", "Generation failed", new Error(status.failure));

          for (const error of status.work.errors) log.warn("Generate", "Work failed", { work: error.work, error: error.message });
        }),
      ),
      Effect.repeat(Schedule.spaced(REPORT_INTERVAL_MS)),
    );
  };

  const running = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* startCatalogSynchronization({ ...options, imageFailures });
        session.resolve(live);
        const reporter = yield* Effect.forkScoped(report(live));

        yield* live.ready;
        ready.resolve();
        yield* Fiber.join(reporter);
      }),
    ),
    { signal: controller.signal },
  ).catch((cause: unknown) => {
    session.reject(cause);

    if (!controller.signal.aborted) ready.reject(cause);

    if (!controller.signal.aborted) log.error("Generate", "Synchronization failed", cause);
  });

  return {
    ready: ready.promise,
    requestPass: async (force = false) => {
      if (controller.signal.aborted) return;
      const live = await session.promise.catch(() => undefined);

      if (live) await Effect.runPromise(live.requestPass({ force }));
    },
    status: async () => {
      const live = await session.promise;

      return Effect.runPromise(snapshot(live));
    },
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}
