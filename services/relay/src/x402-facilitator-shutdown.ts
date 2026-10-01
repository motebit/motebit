/**
 * Shutdown bound for the x402 facilitator handshake — kept apart from
 * `x402-facilitator.ts` (the construction adapter, rule 16) so a test that
 * replaces the constructor module keeps this wrapper.
 */
/**
 * The facilitator client with its `getSupported()` — the handshake
 * `x402HTTPResourceServer.initialize()` runs at boot, unawaited — bounded by
 * the relay's shutdown: once `signal` aborts, a pending call rejects at once
 * instead of holding `close()` for the client's own 30 s request timeout.
 * `HTTPFacilitatorClient` takes no external `AbortSignal`, so the underlying
 * request is abandoned, not cancelled; its late outcome is swallowed.
 * `verify` / `settle` are untouched — a payment in flight is never cut short
 * by this wrapper.
 */
export function abortGetSupportedOnShutdown<T extends object>(
  client: T,
  signal: AbortSignal | undefined,
): T {
  if (signal === undefined) return client;
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== "getSupported") return fn.bind(target);
      return (...args: unknown[]) => {
        // Already shut down: no request is started at all.
        if (signal.aborted) {
          return Promise.reject(new Error("facilitator getSupported aborted: relay shutting down"));
        }
        const call = Promise.resolve(fn.apply(target, args));
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            call.catch(() => {});
            reject(new Error("facilitator getSupported aborted: relay shutting down"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          call.then(
            (v) => {
              signal.removeEventListener("abort", onAbort);
              resolve(v);
            },
            (err: unknown) => {
              signal.removeEventListener("abort", onAbort);
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
        });
      };
    },
  });
}
