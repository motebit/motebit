/**
 * Mobile bootstrap path that mints a hardware-attestation credential
 * once per cadence and publishes it to the relay's
 * `/api/v1/agents/:motebitId/credentials/submit` endpoint. Fire-and-
 * forget; never throws; never blocks the UI.
 *
 * Sibling of:
 *   - `mint-hardware-credential.ts` — produces the signed VC (cascade:
 *     iOS App Attest → Secure Enclave → software; Android Play Integrity
 *     → software).
 *   - `apps/cli/src/subcommands/attest.ts` — operator-invoked CLI mint.
 *
 * Why a separate file from `mint-hardware-credential.ts`. The mint
 * function is a pure cascade — same shape as desktop and web. This file
 * is the mobile-specific wiring that decides _when_ to mint (rate-
 * limited via AsyncStorage) and _where_ to send the result (the relay's
 * credential-submit endpoint, with the proxy bearer token). Surfaces
 * with different rate-limit policies or different submitters keep their
 * own publish file; the mint stays shared.
 *
 * Idempotency. Apple App Attest and Google Play Integrity rate-limit
 * attestation requests device-side. Re-minting per launch would burn
 * that quota for no protocol gain. The relay accepts refreshed
 * credentials, but doesn't ask for them — `valid_until` on the
 * credential is the authoritative freshness signal, not the publish
 * cadence. This function checks an AsyncStorage timestamp and returns
 * early when the last successful publish was less than
 * `MIN_PUBLISH_INTERVAL_MS` ago.
 *
 * Failure mode: a relay error (offline, 5xx, 401) is logged but does
 * not advance the timestamp — the next launch retries. A mint cascade
 * failure (no SE, no App Attest, no Play Integrity) lands a `software`
 * claim, which is still a truthful publish (the relay's
 * HardwareAttestationSemiring scores it lower but accepts it). Both
 * paths are silent; the user never sees an "attestation failed" toast.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  mintHardwareCredential,
  type MintHardwareCredentialOptions,
} from "./mint-hardware-credential.js";
import { ASYNC_STORAGE_KEYS } from "./storage-keys.js";

/**
 * Re-mint cadence — 30 days. The credential carries a `valid_until` set
 * at mint time, so a 30-day re-mint also refreshes the relay's idea of
 * the credential's validity window. Operators can override per-tenant
 * via runtime config in a future v1.1; the constant here is the
 * reference-implementation default, not foundation law.
 */
export const MIN_PUBLISH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PublishHardwareCredentialOptions extends MintHardwareCredentialOptions {
  /** Relay base URL (e.g. https://relay.motebit.com). */
  readonly syncUrl: string;
  /** Bearer token for the `/credentials/submit` endpoint. */
  readonly authToken: string;
  /**
   * Injectable storage. Defaults to `@react-native-async-storage`.
   * Tests pass a fake to exercise the cadence logic without spinning up
   * a React Native runtime.
   */
  readonly storage?: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
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
 * Wired from `mobile-app.ts` immediately after the runtime is
 * constructed. The caller fires-and-forgets:
 *
 *     void publishHardwareCredentialIfDue({ ... }).catch(() => {});
 *
 * The internal `.catch` ensures the helper itself never propagates,
 * but the outer `void` + `.catch` is belt-and-braces — every error
 * inside this function is already trapped and converted to a typed
 * `PublishOutcome`. The catch exists to satisfy lint rules about
 * floating promises.
 */
export async function publishHardwareCredentialIfDue(
  opts: PublishHardwareCredentialOptions,
): Promise<PublishOutcome> {
  const storage = opts.storage ?? AsyncStorage;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const logger = opts.logger;
  const now = (opts.now ?? Date.now)();

  // 1. Cadence check. Skip if the last successful publish was recent.
  try {
    const raw = await storage.getItem(ASYNC_STORAGE_KEYS.lastHardwareAttestationMintAt);
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
    // than to miss a publish window because a corrupted cache.
  }

  // 2. Mint. The cascade itself is silent on failure (returns a truthful
  // `software` claim). We always get back a valid credential.
  const credential = await mintHardwareCredential(opts);

  // 3. Submit to the relay. The endpoint is `POST /api/v1/agents/:id/credentials/submit`
  // — same path the relay's `interactive-delegation.ts` submitter hits when
  // forwarding peer-collected credentials. The wire shape is `{ credentials: [vc] }`
  // (an array) so future batch submits are additive.
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

  // 4. Success — record the mint timestamp so the next launch skips the cascade.
  try {
    await storage.setItem(ASYNC_STORAGE_KEYS.lastHardwareAttestationMintAt, String(now));
  } catch {
    // Storage write failed — the next launch will re-mint. Not fatal.
  }

  // The platform field on the credential's hardware_attestation claim
  // tells the caller what tier the cascade reached (device_check >
  // play_integrity > secure_enclave > webauthn > software).
  const platform = credential.credentialSubject.hardware_attestation.platform;
  return { kind: "submitted", platform };
}
