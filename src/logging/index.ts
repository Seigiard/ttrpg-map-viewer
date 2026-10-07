type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Readonly<Record<string, string | number | boolean | null | undefined>>;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function currentLevelIndex(): number {
  const index = LOG_LEVELS.findIndex((level) => level === process.env.LOG_LEVEL);

  return index === -1 ? 1 : index;
}

function emit(level: LogLevel, tag: string, msg: string, ctx?: LogContext): void {
  if (LOG_LEVELS.indexOf(level) < currentLevelIndex()) return;

  const output = JSON.stringify({ ts: new Date().toISOString(), level, tag, msg, ...ctx });

  if (level === "error" || level === "warn") {
    console.error(output);
  } else {
    console.log(output);
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const log = {
  debug: (tag: string, msg: string, ctx?: LogContext) => emit("debug", tag, msg, ctx),
  info: (tag: string, msg: string, ctx?: LogContext) => emit("info", tag, msg, ctx),
  warn: (tag: string, msg: string, ctx?: LogContext) => emit("warn", tag, msg, ctx),
  error: (tag: string, msg: string, cause?: unknown, ctx?: LogContext) =>
    emit("error", tag, msg, cause === undefined ? ctx : { ...ctx, error: describeCause(cause) }),
};
