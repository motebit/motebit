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
}

/**
 * Register the device with the relay, then start sync. A failure is handed
 * to `onFailure` with a retry — main.ts shows it as an action message.
 */
export async function startDesktopSync(
  app: DesktopSyncApp,
  invoke: InvokeFn,
  syncUrl: string,
  masterToken: string,
  onFailure: (message: string, retry: () => void) => void,
): Promise<void> {
  try {
    const token = await app.registerWithRelay(invoke, syncUrl, masterToken);
    // Start background sync polling after successful registration.
    // Safe to call before AI init — startSync no-ops when runtime is absent.
    // `token` is the device `sync` token registration returned; the master
    // token is passed separately and only when configured, so serving calls
    // never mistake the sync token for it (#827).
    await app.startSync(invoke, syncUrl, token ?? masterToken, masterToken || undefined);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onFailure(`Sync relay connection failed: ${msg}`, () => {
      void startDesktopSync(app, invoke, syncUrl, masterToken, onFailure);
    });
  }
}
