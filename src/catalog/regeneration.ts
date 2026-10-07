export interface RegenerationControllerOptions {
  readonly debounceMs: number;
  readonly reconcileIntervalMs: number;
  readonly regenerate: () => Promise<void>;
  readonly onError: (error: Error) => void;
}

/** Serializes full regeneration passes and folds bursts of collection changes into one follow-up pass. */
export class RegenerationController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private rerun = false;

  constructor(private readonly options: RegenerationControllerOptions) {}

  start(): Promise<void> {
    this.reconcileTimer = setInterval(() => void this.run().catch(this.options.onError), this.options.reconcileIntervalMs);

    return this.run();
  }

  trigger(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run().catch(this.options.onError);
    }, this.options.debounceMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);

    if (this.reconcileTimer !== undefined) clearInterval(this.reconcileTimer);
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerun = true;

      return;
    }

    this.running = true;

    try {
      do {
        this.rerun = false;
        await this.options.regenerate();
      } while (this.rerun);
    } finally {
      this.running = false;
    }
  }
}
