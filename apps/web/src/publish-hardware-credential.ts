/**
 * Web bootstrap path that mints a hardware-attestation credential once
 * per cadence and submits it to the relay's
 * `/api/v1/agents/:motebitId/credentials/submit` endpoint. Fire-and-
 * forget; never throws; never blocks the UI.
 *
 * Sibling of:
 *   - `apps/mobile/src/publish-hardware-credential.ts` — same shape,
 *     mobile-specific deps.
 *   - `apps/desktop/src/publish-hardware-credential.ts` — same shape,
 *     desktop-specific deps.
 *   - `mint-hardware-credential.ts` (this directory) — the web cascade:
 *     WebAuthn platform authenticator → software sentinel.
 *
 * The web's mint cascade is shorter than mobile's or desktop's because
 * the browser only exposes one hardware channel: WebAuthn platform
 * authenticators (TouchID, FaceID, Windows Hello, passkey). Everything
 * else falls back to a truthful `software` claim.
 *
 * Idempotency. WebAuthn `navigator.credentials.create` triggers a real
 * UI prompt the user must approve (TouchID / FaceID / Windows Hello).
 * Re-prompting per page load would be hostile; the cadence here is
 * 30 days, the same as mobile + desktop. Stored in `localStorage`.
 *
 * Failure mode: a relay error (offline, 5xx, 401) is logged but does
 * not advance the timestamp — the next launch retries. A WebAuthn user-
 * cancel or no-platform-authenticator falls back to a truthful
 * `software` claim, which is still a valid publish. Both paths are
 * silent; the user never sees a "publish failed" dialog.
 */

import {
  mintHardwareCredential,
  type MintHardwareCredentialOptions,
} from "./mint-hardware-credential.js";

/**
 * Re-mint cadence — 30 days. Matches mobile + desktop.
 */
export const MIN_PUBLISH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** Storage key — distinct per surface to avoid collisions in shared profiles. */
export const LAST_HW_ATTEST_MINT_KEY = "motebit/web/hw_attest_last_mint_at";

/**
 * AsyncStorage-style key/value contract. Web callers pass
 * `globalThis.localStorage` (works in any browser); SSR builds pass an
 * in-memory shim or an injectable storage.
 */
export interface PublishStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

export interface PublishHardwareCredentialOptions extends MintHardwareCredentialOptions {
  /** Relay base URL (e.g. https://relay.motebit.com). */
  readonly syncUrl: string;
  /** Bearer token for the `/credentials/submit` endpoint. */
  readonly authToken: string;
  /** Injectable storage; pass `globalThis.localStorage` in production. */
  readonly storage: PublishStorage;
  /** Injectable HTTP fetch. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable logger. */
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
 * Wired from web's `startSync` after the sync token is minted. The
 * caller fires-and-forgets; every error inside is trapped and converted
 * to a typed `PublishOutcome`.
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
    // Storage read failed — proceed with the mint.
  }

  // 2. Mint via the web cascade. Never throws.
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
      // Body wasn't JSON.
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
    // Next launch will re-mint.
  }

  // The platform field tells the caller what tier the cascade reached
  // (webauthn > software).
  const platform = credential.credentialSubject.hardware_attestation.platform;
  return { kind: "submitted", platform };
}
