/**
 * Desktop bootstrap path that mints a hardware-attestation credential
 * once per cadence and submits it to the relay's
 * `/api/v1/agents/:motebitId/credentials/submit` endpoint. Fire-and-
 * forget; never throws; never blocks the UI.
 *
 * Sibling of:
 *   - `apps/mobile/src/publish-hardware-credential.ts` — same shape,
 *     mobile-specific deps (AsyncStorage, mobile cascade).
 *   - `mint-hardware-credential.ts` (this directory) — the desktop
 *     cascade: Secure Enclave (macOS) → TPM (Windows / Linux) →
 *     software sentinel.
 *   - `apps/cli/src/subcommands/attest.ts` — operator-invoked CLI mint.
 *
 * Why a separate file from `mint-hardware-credential.ts`. The mint
 * function is a pure cascade — same shape across surfaces, only the
 * platforms differ. This file is the desktop-specific wiring that
 * decides _when_ to mint (rate-limited via injectable storage) and
 * _where_ to send the result (the relay's credential-submit endpoint
 * with the desktop's bearer token).
 *
 * Idempotency. Apple Secure Enclave and TPM round-trips are
 * lightweight, but a re-mint per app launch produces churn for no
 * protocol gain — the relay accepts refreshed credentials but doesn't
 * ask for them; `valid_until` on the credential is the authoritative
 * freshness signal, not the publish cadence. Storage-backed timestamp
 * skips re-publish when the last successful submit was less than
 * `MIN_PUBLISH_INTERVAL_MS` ago. Storage is injected because desktop
 * runs on Tauri (Rust + webview) and the right kv depends on the
 * caller — `localStorage` works inside the webview, file-backed kv
 * works for headless modes.
 *
 * Failure mode: a relay error (offline, 5xx, 401) is logged but does
 * not advance the timestamp — the next launch retries. A mint cascade
 * failure (no SE, no TPM) lands a `software` claim, which is still a
 * truthful publish (the relay's HardwareAttestationSemiring scores it
 * lower but accepts it). Both paths are silent; the user never sees
 * an "attestation failed" toast.
 */

import {
  mintHardwareCredential,
  type MintHardwareCredentialOptions,
} from "./mint-hardware-credential.js";

/**
 * Re-mint cadence — 30 days. Matches mobile's
 * `publish-hardware-credential.ts` constant. The credential carries a
 * `valid_until` set at mint time, so a 30-day re-mint refreshes the
 * relay's view of the credential's validity window. Operators can
 * override per-tenant via runtime config in a future v1.1; the constant
 * here is the reference-implementation default.
 */
export const MIN_PUBLISH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * AsyncStorage-style key/value contract. Desktop callers pass
 * `globalThis.localStorage` (works inside the webview) or a file-backed
 * adapter (works headless). The shape matches mobile's `AsyncStorage`
 * so the publish helpers stay structurally identical across surfaces.
 */
export interface PublishStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

/** Storage key — distinct from mobile's to avoid collision in shared profiles. */
export const LAST_HW_ATTEST_MINT_KEY = "motebit/desktop/hw_attest_last_mint_at";

export interface PublishHardwareCredentialOptions extends MintHardwareCredentialOptions {
  /** Relay base URL (e.g. https://relay.motebit.com). */
  readonly syncUrl: string;
  /** Bearer token for the `/credentials/submit` endpoint. */
  readonly authToken: string;
  /** Injectable storage; pass `globalThis.localStorage` for webview, or a custom adapter. */
  readonly storage: PublishStorage;
  /** Injectable HTTP fetch. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable logger; defaults to a no-op. */
  readonly logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

export type PublishOutcome =
  | { kind: "skipped_recent"; lastMintAt: number; nextEligibleAt: number }
  | { kind: "submitted"; platform: string }
  | { kind: "submit_failed"; status: number; reason?: string }
  | { kind: "transport_failed"; error: string };

/**
 * Mint a hardware-attestation credential (if the cadence allows) and
 * submit it to the relay. Resolves with the outcome — never throws.
 *
 * Wired from the desktop bootstrap immediately after the runtime is
 * constructed. Caller fires-and-forgets:
 *
 *     void publishHardwareCredentialIfDue({ ... }).catch(() => {});
 *
 * Every error inside is trapped and converted to a typed
 * `PublishOutcome`; the outer `.catch` is belt-and-braces for lint.
 */
export async function publishHardwareCredentialIfDue(
  opts: PublishHardwareCredentialOptions,
): Promise<PublishOutcome> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const logger = opts.logger;
  const now = (opts.now ?? Date.now)();

  // 1. Cadence check.
  try {
    const raw = await opts.storage.getItem(LAST_HW_ATTEST_MINT_KEY);
    if (raw != null && raw !== "") {
      const lastMintAt = Number(raw);
      if (Number.isFinite(lastMintAt) && now - lastMintAt < MIN_PUBLISH_INTERVAL_MS) {
        return {
          kind: "skipped_recent",
          lastMintAt,
          nextEligibleAt: lastMintAt + MIN_PUBLISH_INTERVAL_MS,
        };
      }
    }
  } catch {
    // Storage read failed — proceed with the mint. Better to over-mint
    // than to miss a publish window because of a corrupted cache.
  }

  // 2. Mint via the desktop cascade. Never throws.
  const credential = await mintHardwareCredential(opts);

  // 3. Submit to the relay.
  const url = `${opts.syncUrl.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(
    opts.motebitId,
  )}/credentials/submit`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.authToken}`,
      },
      body: JSON.stringify({ credentials: [credential] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn("publish_hardware_credential.transport_failed", { error: message });
    return { kind: "transport_failed", error: message };
  }

  if (!response.ok) {
    let reason: string | undefined;
    try {
      const body = (await response.json()) as { error?: string; reason?: string };
      reason = body.error ?? body.reason;
    } catch {
      // Body wasn't JSON — leave reason undefined.
    }
    logger?.warn("publish_hardware_credential.submit_failed", {
      status: response.status,
      reason,
    });
    return { kind: "submit_failed", status: response.status, reason };
  }

  // 4. Success — record the timestamp.
  try {
    await opts.storage.setItem(LAST_HW_ATTEST_MINT_KEY, String(now));
  } catch {
    // Storage write failed — the next launch will re-mint. Not fatal.
  }

  // The platform field tells the caller which tier the cascade reached
  // (secure_enclave > tpm > software).
  const platform = credential.credentialSubject.hardware_attestation.platform;
  return { kind: "submitted", platform };
}
