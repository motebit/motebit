export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  msg: string;
  correlationId?: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function emit(entry: LogEntry): void {
  if (LOG_LEVELS[entry.level] < LOG_LEVELS[minLevel]) return;
  const { level, msg, ...rest } = entry;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...rest });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function createLogger(context: Record<string, unknown> = {}): {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): ReturnType<typeof createLogger>;
} {
  const log = (level: LogLevel, msg: string, data?: Record<string, unknown>) =>
    emit({ level, msg, ...context, ...data });
  return {
    debug: (msg, data) => log("debug", msg, data),
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}
