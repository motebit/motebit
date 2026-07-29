/**
 * Atom self-watchdog (#459 — the ops leg of the settlement-amplification
 * incident): `motebit-read-url` wedged post-deploy with its port
 * unresponsive for ~25 minutes. Fly restarts a machine when the PROCESS
 * exits — it does not restart on failing HTTP health checks — so a
 * process that is alive-but-unservable sits wedged until a human
 * intervenes, while downstream workers hammer it and the network degrades
 * around the hole.
 *
 * The watchdog closes the loop from inside: it periodically fetches the
 * server's OWN /health over loopback; after `maxConsecutiveFailures` the
 * process exits non-zero, and the platform's restart policy revives it.
 * A self-check over the real listening socket exercises the same accept
 * path external traffic uses — if we cannot reach ourselves, neither can
 * anyone else.
 *
 * Injectable seams (`fetchFn`, `exitFn`, timers via `intervalMs`) keep it
 * fully testable without a real server or a real exit.
 */

export interface SelfWatchdogOptions {
  /** The server's own health URL over loopback, e.g. http://127.0.0.1:3200/health */
  healthUrl: string;
  /** Check cadence. Default 60s. */
  intervalMs?: number;
  /** Per-check timeout. Default 5s. */
  timeoutMs?: number;
  /** Consecutive failures before exiting. Default 3. */
  maxConsecutiveFailures?: number;
  /** Injectable fetch (tests). */
  fetchFn?: typeof fetch;
  /** Injectable exit (tests). */
  exitFn?: (code: number) => void;
  /** Structured-ish logger. Default console.error. */
  log?: (message: string) => void;
}

export interface SelfWatchdogHandle {
  stop(): void;
  /** Run one check now (exported for tests; the interval calls this). */
  checkOnce(): Promise<void>;
  readonly consecutiveFailures: number;
}

export function startSelfWatchdog(options: SelfWatchdogOptions): SelfWatchdogHandle {
  const intervalMs = options.intervalMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxFailures = options.maxConsecutiveFailures ?? 3;
  const fetchFn = options.fetchFn ?? fetch;
  const exitFn = options.exitFn ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((m: string) => console.error(m));

  let failures = 0;
  let stopped = false;

  const checkOnce = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await fetchFn(options.healthUrl, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        failures = 0;
        return;
      }
      failures++;
    } catch {
      failures++;
    }
    if (failures >= maxFailures) {
      log(
        `[motebit/mcp-server] self-watchdog: ${failures} consecutive failed self-checks on ${options.healthUrl} — exiting so the platform restart policy can revive a healthy process (#459)`,
      );
      stopped = true;
      clearInterval(timer);
      exitFn(1);
    }
  };

  const timer = setInterval(() => {
    void checkOnce();
  }, intervalMs);
  // Never keep the process alive solely for the watchdog.
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    checkOnce,
    get consecutiveFailures() {
      return failures;
    },
  };
}
