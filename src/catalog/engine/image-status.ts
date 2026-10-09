interface ImageWorkFailure {
  readonly work: string;
  readonly message: string;
}

export interface ImageFailureRegistry {
  readonly record: (key: string, message: string) => void;
  readonly clear: (key: string) => void;
  readonly retain: (keys: ReadonlySet<string>) => void;
  readonly snapshot: () => readonly ImageWorkFailure[];
}

export function createImageFailureRegistry(): ImageFailureRegistry {
  const failures = new Map<string, string>();

  return {
    record: (key, message) => failures.set(key, message),
    clear: (key) => failures.delete(key),
    retain: (keys) => {
      for (const key of failures.keys()) {
        if (!keys.has(key)) failures.delete(key);
      }
    },
    snapshot: () => [...failures].map(([work, message]) => ({ work, message })),
  };
}
