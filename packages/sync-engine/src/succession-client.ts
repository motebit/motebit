/**
 * Presenting a key succession to a relay — one implementation, because
 * four surfaces each grew their own and three of them are wrong.
 *
 * At the time of writing: the CLI signed its bearer with the NEW key (the
 * relay can only verify the key it already holds, so that can never
 * authenticate); desktop posted to `/device/register` with an operator
 * token an ordinary user does not have; web and mobile posted to
 * `/api/v1/agents/:id/key-rotation`, a route the relay does not register
 * at all. Every one of those failures was swallowed by a `catch`, which is
 * why the production succession table was empty across the relay's whole
 * life (#702).
 *
 * Two things this gets right that an inlined `fetch` kept getting wrong:
 *
 *  - **Which key signs.** The key being RETIRED. It is the only one the
 *    relay can verify at this moment, because a rotation is precisely the
 *    claim that its record of the key is about to be out of date. That
 *    makes the request authentic, not safe: a thief holding the same key
 *    can sign one too, and whoever arrives first wins. Rotation does not
 *    adjudicate that race — guardian recovery is the remedy for losing it.
 *  - **Which audience.** `rotate-key`, which `spec/auth-token-v1.md` §9
 *    names for this route.
 *
 * The caller decides what a failure means. It is returned, never thrown
 * and never swallowed, because a rotation whose submission failed must not
 * be committed locally: local state on the new key while the relay serves
 * the old one cannot be repaired by re-presenting the record, and the
 * identity endpoint third parties read goes on naming the retired key, so
 * every receipt signed afterwards fails to verify.
 */
import { mintAudienceToken } from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/protocol";

export interface SubmitSuccessionRequest {
  /** Relay base URL, with or without a trailing slash. */
  syncUrl: string;
  motebitId: string;
  /** The device this identity is known by at the relay; the token names it. */
  deviceId: string;
  /** The private key being retired — the only one the relay can verify now. */
  signingKey: Uint8Array;
  record: KeySuccessionRecord;
  /** Injected for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type SubmitSuccessionResult =
  | {
      ok: true;
      /** False when the relay already held this record — a retry, not a failure. */
      applied: boolean;
    }
  | { ok: false; reason: string };

export async function submitSuccessionToRelay(
  req: SubmitSuccessionRequest,
): Promise<SubmitSuccessionResult> {
  if (req.deviceId === "") {
    // The relay resolves the verifying key from the device the token
    // names. Without one it cannot verify anything, and the request would
    // 401 with a reason no user could act on.
    return {
      ok: false,
      reason: "this machine has no device id at the relay — run the daemon against it once first",
    };
  }
  const base = req.syncUrl.replace(/\/+$/, "");
  const doFetch = req.fetchImpl ?? fetch;
  let token: string;
  try {
    // The canonical mint seam, not a hand-rolled token: `iat`/`exp`/`jti`
    // and the TTL live in one place (`check-token-mint-canonical`).
    ({ token } = await mintAudienceToken(
      { mid: req.motebitId, did: req.deviceId, aud: "rotate-key" },
      req.signingKey,
    ));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  let res: Response;
  try {
    res = await doFetch(`${base}/api/v1/agents/${req.motebitId}/rotate-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(req.record),
      signal: AbortSignal.timeout(req.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      reason: `relay answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  }
  const parsed = (await res.json().catch(() => null)) as { applied?: unknown } | null;
  // A relay that already held this record answers `applied: false`. An
  // older relay answers neither, and "it did not refuse" is all we can
  // honestly read from that.
  return { ok: true, applied: parsed?.applied !== false };
}
