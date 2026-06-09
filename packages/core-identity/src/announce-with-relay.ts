/**
 * Self-attesting motebit-to-relay announcement helper — the client side of
 * the sovereign funnel's metabolic intake.
 *
 * A freshly-minted motebit announces itself to a relay's durable intake
 * ledger so motebit Inc has a real, monotonic acquisition count. Distinct
 * from `registerDeviceWithRelay`: registration makes a device *serve* under
 * an identity (and its registry row is reaped after 90 days of silence); an
 * announcement is the identity's one-time "I exist, count me," recorded in an
 * append-only ledger that is never reaped. The signature IS the auth — no
 * master token, no operator action, no email confirmation.
 *
 * `audience` binds the signed announcement to the *specific* relay's
 * sovereign id (`relay_id`), so announcing to relay.motebit.com is not
 * construed as consent to be counted by some other relay. The helper learns
 * that id from the relay's `/.well-known/motebit.json` descriptor before
 * signing. Browser-safe (fetch + signing primitives only; no node:* imports).
 *
 * Best-effort by contract: every failure is a typed result, never a throw —
 * a first-launch motebit works fully locally whether or not the relay is
 * reachable, and the caller silently retries on the next launch.
 */

import { signMotebitAnnouncement, type AnnouncementSurface } from "@motebit/encryption";

/**
 * Closed-union result codes. A user-facing layer SHOULD map each to its own
 * copy without parsing the human-readable `message`. Mirrors the discipline
 * of `RegisterWithRelayResult`.
 */
export type AnnounceMotebitResult =
  | {
      ok: true;
      /** True if the relay recorded a *new* intake row in this request (first announce). */
      first_seen: boolean;
      /** Relay's wall-clock at the time intake was recorded. */
      announced_at: number;
    }
  | { ok: false; code: AnnounceMotebitErrorCode; message: string; status?: number };

export type AnnounceMotebitErrorCode =
  /** `fetch` rejected — DNS, TLS, offline. Relay unreachable. */
  | "network_unreachable"
  /** The relay descriptor was missing/malformed so we could not learn its `relay_id`. */
  | "relay_identity_unavailable"
  /** Relay returned 400 with a verification reason (stale, malformed, wrong_audience, bad_signature). */
  | "rejected"
  /** Relay returned 429. */
  | "rate_limited"
  /** Anything else the relay returned. */
  | "unknown";

export interface AnnounceMotebitParams {
  /** Self-asserted identifier the motebit is announcing. */
  motebitId: string;
  /** 64-char lowercase hex Ed25519 public key (32 bytes). */
  publicKey: string;
  /** Ed25519 private key bytes. Used only to sign the announcement. */
  privateKey: Uint8Array;
  /** Which client surface is announcing. */
  surface: AnnouncementSurface;
  /** Relay base URL. Descriptor + announce paths are appended internally. */
  relayUrl: string;
  /** Abort the in-flight requests. Pairs with `AbortController` on the caller side. */
  signal?: AbortSignal;
}

const DESCRIPTOR_PATH = "/.well-known/motebit.json";
const ANNOUNCE_PATH = "/api/v1/motebits/announce";

/**
 * Learn the relay's `relay_id`, sign an announcement bound to it, POST it,
 * and return a structured result.
 *
 * Idempotent on `motebit_id` — the relay records the first announce and
 * returns `first_seen: false` (no duplicate row) on any later one, so this is
 * safe to call on every launch until it first succeeds.
 */
export async function announceMotebit(
  params: AnnounceMotebitParams,
): Promise<AnnounceMotebitResult> {
  // Step 1 — discover the target relay's sovereign id to bind `audience` to.
  let relayId: string;
  try {
    const descResp = await fetch(`${params.relayUrl}${DESCRIPTOR_PATH}`, {
      method: "GET",
      signal: params.signal,
    });
    if (!descResp.ok) {
      return {
        ok: false,
        code: "relay_identity_unavailable",
        message: `Relay descriptor returned ${descResp.status}`,
        status: descResp.status,
      };
    }
    const desc = (await descResp.json()) as { relay_id?: unknown };
    if (typeof desc.relay_id !== "string" || desc.relay_id.length === 0) {
      return {
        ok: false,
        code: "relay_identity_unavailable",
        message: "Relay descriptor is missing relay_id",
      };
    }
    relayId = desc.relay_id;
  } catch (err: unknown) {
    return {
      ok: false,
      code: "network_unreachable",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 2 — sign the announcement, bound to this relay's id.
  const body = await signMotebitAnnouncement(
    {
      motebit_id: params.motebitId,
      public_key: params.publicKey,
      surface: params.surface,
      audience: relayId,
      timestamp: Date.now(),
    },
    params.privateKey,
  );

  // Step 3 — POST it.
  let resp: Response;
  try {
    resp = await fetch(`${params.relayUrl}${ANNOUNCE_PATH}`, {
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
    let parsed: { announced_at: number; first_seen: boolean };
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
    return { ok: true, first_seen: parsed.first_seen, announced_at: parsed.announced_at };
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

  if (resp.status === 429) {
    return { ok: false, code: "rate_limited", message, status: 429 };
  }
  if (resp.status === 400) {
    return { ok: false, code: "rejected", message, status: 400 };
  }
  return { ok: false, code: "unknown", message, status: resp.status };
}
