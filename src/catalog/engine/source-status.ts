interface SourceObservationFailure {
  readonly path: string;
  readonly message: string;
}

export interface SourceFailureRegistry {
  readonly record: (path: string, message: string) => void;
  readonly retain: (paths: ReadonlySet<string>) => void;
  readonly snapshot: () => readonly SourceObservationFailure[];
}

export function createSourceFailureRegistry(): SourceFailureRegistry {
  const failures = new Map<string, string>();

  return {
    record: (path, message) => failures.set(path, message),
    retain: (paths) => {
      for (const path of failures.keys()) {
        if (!paths.has(path)) failures.delete(path);
      }
    },
    snapshot: () => [...failures].map(([path, message]) => ({ path, message })),
  };
}
