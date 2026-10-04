/**
 * Desktop's sync start at app startup (main.ts `trySyncRegistration`),
 * extracted so the sequence main.ts runs is the sequence under test
 * (`every-configured-surface-pushes-962.test.ts`, #962): main.ts is the DOM
 * entry point and cannot be imported by a test.
 */
import type { InvokeFn } from "./tauri-storage.js";

/** The part of `DesktopApp` the startup sequence drives. */
export interface DesktopSyncApp {
  registerWithRelay(invoke: InvokeFn, syncUrl: string, masterToken: string): Promise<string | null>;
  startSync(
    invoke: InvokeFn,
    syncUrl: string,
    authToken?: string,
    masterToken?: string,
  ): Promise<void>;
  /** Run `stop` when sync stops; returns an unsubscribe. */
  onSyncStop(stop: () => void): () => void;
}

/** Background re-registration backoff: 1 s, doubling, capped at 60 s. */
export const REGISTRATION_RETRY_BASE_MS = 1_000;
export const REGISTRATION_RETRY_MAX_MS = 60_000;

/**
 * Register the device with the relay (attempted before the first push),
 * then start sync — whether or not the relay accepted the registration.
 *
 * #962: a failed registration used to stop here, so a relay unreachable at
 * launch meant sync never started without the user pressing Retry, and the
 * relay-floored compaction held the log growing. Now sync starts anyway (the
 * socket reconnects on its own backoff) and registration is retried in the
 * background until the relay accepts it — backoff 1 s doubling to 60 s,
 * timers unref'd, ended when sync stops. The first failure is handed to
 * `onFailure` (main.ts shows it as an action message); its `retry` registers
 * again now.
 */
export async function startDesktopSync(
  app: DesktopSyncApp,
  invoke: InvokeFn,
  syncUrl: string,
  masterToken: string,
  onFailure: (message: string, retry: () => void) => void,
): Promise<void> {
  let token: string | null = null;
  let failure: string | null = null;
  try {
    token = await app.registerWithRelay(invoke, syncUrl, masterToken);
  } catch (err: unknown) {
    failure = err instanceof Error ? err.message : String(err);
  }

  // Start background sync. Safe to call before AI init — startSync no-ops
  // when runtime is absent. `token` is the device `sync` token registration
  // returned; the master token is passed separately and only when
  // configured, so serving calls never mistake the sync token for it (#827).
  try {
    await app.startSync(invoke, syncUrl, token ?? masterToken, masterToken || undefined);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onFailure(`Sync relay connection failed: ${msg}`, () => {
      void startDesktopSync(app, invoke, syncUrl, masterToken, onFailure);
    });
    return;
  }

  if (failure === null) return;
  const retry = keepRegistering(app, invoke, syncUrl, masterToken);
  onFailure(`Sync relay connection failed: ${failure}`, retry);
}

/**
 * Re-register until the relay accepts, on backoff, until sync stops.
 * Returns "register now" (the Retry action).
 */
function keepRegistering(
  app: DesktopSyncApp,
  invoke: InvokeFn,
  syncUrl: string,
  masterToken: string,
): () => void {
  let delay = REGISTRATION_RETRY_BASE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let inFlight = false;

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const unsubscribe = app.onSyncStop(() => {
    done = true;
    clear();
  });

  const attempt = async (): Promise<void> => {
    if (done || inFlight) return;
    inFlight = true;
    clear();
    try {
      await app.registerWithRelay(invoke, syncUrl, masterToken);
      done = true;
      unsubscribe();
    } catch {
      if (!done) schedule();
    } finally {
      inFlight = false;
    }
  };
  const schedule = (): void => {
    clear();
    timer = setTimeout(() => void attempt(), delay);
    (timer as { unref?: () => void }).unref?.();
    delay = Math.min(delay * 2, REGISTRATION_RETRY_MAX_MS);
  };

  schedule();
  return () => {
    delay = REGISTRATION_RETRY_BASE_MS;
    void attempt();
  };
}
