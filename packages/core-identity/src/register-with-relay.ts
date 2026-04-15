/**
 * Self-attesting device-to-relay registration helper.
 *
 * Composes the §4.1 signing recipe from `spec/device-self-registration-v1.md`
 * with the §5 endpoint POST and surfaces the §5.1 outcome as a typed result.
 * Idempotent — safe to call on every page load / app boot. Browser-safe
 * (uses fetch + signing primitives only; no node:* imports).
 *
 * This is the bootstrap path for fresh client-generated identities (web,
 * mobile, third-party SDKs) that have no out-of-band trust anchor with the
 * relay. The signature in the registration request IS the auth — no master
 * token, no operator action, no email confirmation.
 */

import { signDeviceRegistration } from "@motebit/encryption";

/**
 * Closed-union result codes. A user-facing layer (chat, system message)
 * SHOULD map each to its own copy without parsing the human-readable
 * `message`. Mirrors the discipline of `DelegationErrorCode` in
 * `@motebit/runtime`.
 */
export type RegisterWithRelayResult =
  | {
      ok: true;
      /** True if the relay created the identity row in this request. */
      created: boolean;
      /** Relay's wall-clock at registration; useful for audit logs. */
      registered_at: number;
    }
  | { ok: false; code: RegisterWithRelayErrorCode; message: string; status?: number };

export type RegisterWithRelayErrorCode =
  /** `fetch` rejected — DNS, TLS, offline. Relay unreachable. */
  | "network_unreachable"
  /** Relay returned 400 with a verification reason (stale, malformed, bad_signature). */
  | "rejected"
  /** Relay returned 409 — the motebit_id is already bound to a different public key. */
  | "key_conflict"
  /** Relay returned 429. */
  | "rate_limited"
  /** Anything else the relay returned. */
  | "unknown";

export interface RegisterWithRelayParams {
  /** Self-asserted identifier the device is claiming. */
  motebitId: string;
  /** Self-asserted device identifier. */
  deviceId: string;
  /** 64-char lowercase hex Ed25519 public key (32 bytes). */
  publicKey: string;
  /** Ed25519 private key bytes. Used only to sign the registration request. */
  privateKey: Uint8Array;
  /** Relay base URL. Endpoint path is appended internally. */
  syncUrl: string;
  /** Optional human-readable label for operator panels. */
  deviceName?: string;
  /**
   * Optional owner reference. Defaults to `"self:<motebitId>"` per spec §5.1
   * — a sovereign device that owns itself.
   */
  ownerId?: string;
  /** Abort the in-flight POST. Pairs with `AbortController` on the caller side. */
  signal?: AbortSignal;
}

const ENDPOINT_PATH = "/api/v1/devices/register-self";

/**
 * Sign a registration request, POST it, and return a structured result.
 *
 * Idempotent on the (motebit_id, public_key) pair — the relay returns 200
 * (created=false) when both already match its registry, 201 (created=true)
 * when it persisted a new identity row. Either is `ok: true` here.
 *
 * On a 409 ("key_conflict"), the relay's existing binding for this
 * `motebit_id` carries a different public_key. Callers MUST NOT silently
 * retry — key rotation is a separate, signed protocol step (`spec/auth-token-v1.md`
 * §9). Surface the conflict to the user.
 */
export async function registerDeviceWithRelay(
  params: RegisterWithRelayParams,
): Promise<RegisterWithRelayResult> {
  const body = await signDeviceRegistration(
    {
      motebit_id: params.motebitId,
      device_id: params.deviceId,
      public_key: params.publicKey,
      ...(params.deviceName ? { device_name: params.deviceName } : {}),
      owner_id: params.ownerId ?? `self:${params.motebitId}`,
      timestamp: Date.now(),
    },
    params.privateKey,
  );

  let resp: Response;
  try {
    resp = await fetch(`${params.syncUrl}${ENDPOINT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (err: unknown) {
    return {
      ok: false,
      code: "network_unreachable",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (resp.status === 200 || resp.status === 201) {
    let parsed: { motebit_id: string; device_id: string; registered_at: number; created: boolean };
    try {
      parsed = (await resp.json()) as typeof parsed;
    } catch {
      return {
        ok: false,
        code: "unknown",
        message: "Relay returned success status with non-JSON body",
        status: resp.status,
      };
    }
    return { ok: true, created: parsed.created, registered_at: parsed.registered_at };
  }

  // Failure — read the body once, classify by status.
  const text = await resp.text().catch(() => "");
  let parsedErr: { code?: string; reason?: string; error?: string } | null = null;
  try {
    parsedErr = JSON.parse(text) as { code?: string; reason?: string; error?: string };
  } catch {
    /* non-JSON body */
  }
  const message = parsedErr?.error ?? parsedErr?.reason ?? text.slice(0, 256);

  if (resp.status === 409) {
    return { ok: false, code: "key_conflict", message, status: 409 };
  }
  if (resp.status === 429) {
    return { ok: false, code: "rate_limited", message, status: 429 };
  }
  if (resp.status === 400) {
    return { ok: false, code: "rejected", message, status: 400 };
  }
  return { ok: false, code: "unknown", message, status: resp.status };
}
