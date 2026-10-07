import { Effect } from "effect";

/**
 * Runs a Promise that observes `signal`. On interruption it aborts the signal and waits for the
 * Promise to settle, so no handler or native work outlives its fiber. A rejection becomes `onError`.
 */
export function ownedPromise<A, E>(run: (signal: AbortSignal) => Promise<A>, onError: (cause: unknown) => E): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume, signal) => {
    const settled = run(signal).then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => resume(Effect.fail(onError(cause))),
    );

    // oxlint-disable-next-line catalog/no-direct-effect-promise -- the cancel effect of Effect.callback runs uninterruptibly
    return Effect.promise(() => settled);
  });
}
