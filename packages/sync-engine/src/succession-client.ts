/**
 * Presenting a key succession to a relay, and READING where the relay stands
 * before doing so — the client half of `docs/proposals/key-rotation-client-v1.md`.
 *
 * One implementation, because four surfaces each grew their own and three
 * of them were wrong (#702, #709): the CLI signed its bearer with the NEW
 * key (unverifiable by construction — the relay verifies the key it holds),
 * desktop posted to `/device/register` with an operator token, web and
 * mobile posted to a route that does not exist. Every failure was swallowed.
 *
 * Two primitives:
 *
 *  - `readSuccessionState` classifies the relay from the public succession
 *    route (no token). This is what makes a resume a READ instead of a
 *    re-sign or a replay: after a lost response the client does not know
 *    whether the relay applied its record, and the only key it can sign with
 *    may be the one the relay just retired. So it asks.
 *  - `submitSuccessionToRelay` presents the record, signed by the key being
 *    RETIRED — the only one the relay can verify at that moment (a rotation
 *    is precisely the claim that its record of the key is about to be out of
 *    date). Authentic, not safe: a thief holding the same key can sign one
 *    too, and whoever arrives first wins. Rotation does not adjudicate that
 *    race; guardian recovery is the remedy for losing it.
 *
 * Failures are RETURNED, never thrown and never swallowed, and they say which
 * kind they are. A rotation whose submission was refused must not be
 * committed locally; one whose outcome is unknown must be held, not lost.
 */
import { mintAudienceToken } from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/protocol";

// ── reading the relay ─────────────────────────────────────────────────────

export interface ReadSuccessionStateRequest {
  /** Relay base URL, with or without a trailing slash. */
  syncUrl: string;
  motebitId: string;
  /** The key this machine holds and would rotate FROM (hex). */
  localPublicKey: string;
  /** The key a held write-ahead would rotate TO (hex), if one is held. */
  heldNewPublicKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The relay's key for this identity, relative to the machine asking. Names
 * follow the design note's state table; the local half of each pair is
 * always "A" (this machine holds the key it would rotate from).
 */
export type RelaySuccessionState =
  /** S0 — the relay holds the local key. A rotation may begin. */
  | { state: "current"; relayKey: string; chain: KeySuccessionRecord[] }
  /** S1 — the relay already holds the key a held write-ahead rotates to. */
  | { state: "applied"; relayKey: string; chain: KeySuccessionRecord[] }
  /** S4 — the relay holds no key and no chain for this identity. */
  | { state: "unregistered"; relayKey: null; chain: [] }
  /** S5 — the relay holds some other key, or holds this identity's history without this key. Someone else rotated first. */
  | { state: "diverged"; relayKey: string; chain: KeySuccessionRecord[] }
  /** S6 — the relay could not be read. Nothing is known. */
  | { state: "unreachable"; reason: string };

export async function readSuccessionState(
  req: ReadSuccessionStateRequest,
): Promise<RelaySuccessionState> {
  const base = req.syncUrl.replace(/\/+$/, "");
  const doFetch = req.fetchImpl ?? fetch;
  let res: Response;
  try {
    // `?from=` asks the relay the exact question its rotate-key rule
    // answers: may a rotation depart from the key this machine holds? The
    // relay computes it with the same function it enforces with. A client
    // that re-derived it from the chain and registry key alone could not see
    // device rows (a daemon that shut down leaves its key ONLY there) and
    // inverted the relay's precedence whenever the two disagreed.
    res = await doFetch(
      `${base}/api/v1/agents/${req.motebitId}/succession?from=${req.localPublicKey}`,
      { method: "GET", signal: AbortSignal.timeout(req.timeoutMs ?? 10_000) },
    );
  } catch (err) {
    return { state: "unreachable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) {
    return { state: "unreachable", reason: `relay answered ${res.status} to the succession read` };
  }
  const parsed = (await res.json().catch(() => null)) as {
    chain?: unknown;
    held_public_key?: unknown;
    departable?: unknown;
  } | null;
  if (parsed == null || !Array.isArray(parsed.chain)) {
    // A captive portal, a proxy error page: not a relay's answer. Reading
    // that as "unregistered" would rotate locally into the split state.
    return { state: "unreachable", reason: "the response did not come from a motebit relay" };
  }
  if (typeof parsed.departable !== "boolean") {
    // A relay that does not answer the departure question cannot be
    // classified honestly — guessing is what this read replaces. Fail
    // closed: nothing is minted, nothing local moves.
    return {
      state: "unreachable",
      reason:
        "this relay does not answer whether a rotation may depart from the local key (upgrade the relay)",
    };
  }
  const chain = parsed.chain as KeySuccessionRecord[];
  const held = typeof parsed.held_public_key === "string" ? parsed.held_public_key : null;
  if (parsed.departable) {
    // S0, whichever rung admitted it. `relayKey` is the key the relay holds
    // most authoritatively, or the local key when only a device row holds it.
    return { state: "current", relayKey: held ?? req.localPublicKey, chain };
  }
  if (req.heldNewPublicKey !== undefined && held === req.heldNewPublicKey) {
    return { state: "applied", relayKey: held, chain };
  }
  if (held === null && chain.length === 0) {
    return { state: "unregistered", relayKey: null, chain: [] };
  }
  return { state: "diverged", relayKey: held ?? chain[chain.length - 1]!.new_public_key, chain };
}

// ── presenting a record ───────────────────────────────────────────────────

export interface SubmitSuccessionRequest {
  /** Relay base URL, with or without a trailing slash. */
  syncUrl: string;
  motebitId: string;
  /**
   * The `did` claim of the bearer. The device this identity is known by at
   * the relay when it has one; otherwise the identity's own `did:key`, which
   * the relay resolves through its registry-by-identity fallback (the same
   * path service-mode motebits authenticate on). Never empty — an empty
   * `did` is refused before any key is looked up.
   */
  deviceId: string;
  /** The private key being RETIRED — the only one the relay can verify now. */
  signingKey: Uint8Array;
  record: KeySuccessionRecord;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type SubmitSuccessionResult =
  | {
      ok: true;
      /** False when the relay already held this record at its chain head — a retry, not a failure. */
      applied: boolean;
    }
  /** The relay answered and said no. The record will not land; nothing should be committed. */
  | { ok: false; kind: "refused"; status: number; reason: string }
  /** No answer, or an answer that was not a relay's. The relay MAY have applied it. */
  | { ok: false; kind: "unknown"; reason: string };

export async function submitSuccessionToRelay(
  req: SubmitSuccessionRequest,
): Promise<SubmitSuccessionResult> {
  if (req.deviceId === "") {
    return {
      ok: false,
      kind: "refused",
      status: 0,
      reason:
        "the bearer needs a device id or the identity's did:key; an empty one is refused before any key is looked up",
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
    return {
      ok: false,
      kind: "refused",
      status: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
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
    return { ok: false, kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A 5xx is the relay failing to answer, not the relay refusing: it may
    // have committed before the error. Only a 4xx is a decision.
    if (res.status >= 500) {
      return {
        ok: false,
        kind: "unknown",
        reason: `relay answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      };
    }
    return {
      ok: false,
      kind: "refused",
      status: res.status,
      reason: `relay answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  }
  const parsed = (await res.json().catch(() => null)) as {
    ok?: unknown;
    applied?: unknown;
  } | null;
  // The relay answers `{ok, motebit_id, applied}`. Anything else with a 200
  // — a captive portal, a proxy error page — did not reach it, and reading
  // that as success is what lets the caller commit a rotation the relay
  // never recorded. There is no older relay to be lenient for: this route
  // has never accepted a client request.
  if (parsed?.ok !== true) {
    return { ok: false, kind: "unknown", reason: "the response did not come from a motebit relay" };
  }
  return { ok: true, applied: parsed.applied !== false };
}
