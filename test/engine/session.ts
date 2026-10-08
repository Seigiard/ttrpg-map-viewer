import { Effect } from "effect";
import { openCatalogSynchronization } from "../../src/catalog/engine/composition.ts";
import type { Workspace } from "./collection-fixture.ts";

export type Session = Effect.Success<ReturnType<typeof openCatalogSynchronization>>;

export function sessionOptions(workspace: Workspace) {
  return {
    filesPath: workspace.collection,
    dataPath: workspace.output,
    overridesPath: workspace.overrides,
    thumbnailConcurrency: 2,
    reconcileIntervalMs: 0,
  };
}

/** Opens the composition, runs the callback while the session holds the output tree, and closes it. */
export function withSession<A>(workspace: Workspace, run: (session: Session) => Promise<A>): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openCatalogSynchronization(sessionOptions(workspace));

        return yield* Effect.promise(() => run(session)).pipe(Effect.uninterruptible);
      }),
    ),
  );
}

/** Requests a pass and waits until the engine reports it, and everything it required, complete. */
export async function passOf(session: Session, force = false): Promise<void> {
  await Effect.runPromise(session.requestPass({ force }));
  await Effect.runPromise(session.awaitCompletion);
}
