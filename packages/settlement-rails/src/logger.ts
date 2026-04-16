/**
 * Minimal structured logger contract the rails depend on. Any logger with
 * `info(event, data)` / `warn` / `error` methods satisfies it — callers
 * pass their platform logger (e.g., the relay's `createLogger("stripe-rail")`
 * adapter). Omit to get silent defaults.
 *
 * The shape is deliberately narrower than most structured loggers: the
 * rails emit events (dotted strings) with structured context, never
 * message templates. Consumers who want timestamps, correlation ids, or
 * request context inject a logger that joins those in.
 */
export interface RailLogger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: RailLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
