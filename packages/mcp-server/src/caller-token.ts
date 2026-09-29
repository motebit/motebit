/**
 * The law for a caller-signed bearer on an HTTP request to a motebit MCP
 * server (#957).
 *
 * `Authorization: Bearer motebit:<token>` names a caller by `mid` and proves
 * it by an Ed25519 signature. The signature says WHO signed. It does not say
 * the caller meant THIS server, or THIS request: before #957 the server took
 * a token of any audience, bound to nothing, as many times as it was shown.
 * A motebit signs tokens for many parties (a `task:submit` token for the
 * relay, a bearer for every MCP server it connects to), so any one of them
 * could replay it here and be taken for that motebit until it expired.
 *
 * A caller token is accepted only if ALL of these hold:
 *
 *   (a) `aud` is `mcp:call` (`MCP_CALL_AUDIENCE`) — nothing minted for any
 *       other purpose authenticates an MCP call;
 *   (b) `sub` is THIS server's `motebit_id` — a token minted for server A is
 *       refused at server B;
 *   (c) its `jti` has not been accepted before within the token's lifetime
 *       (replay store; bounded, expiry-evicted, fail-closed when full);
 *   (d) the signature verifies under the caller's key and the token has not
 *       expired (`verifySignedToken`), and its remaining lifetime is at most
 *       `MAX_MCP_CALLER_TOKEN_LIFETIME_MS`, so the replay store's memory is
 *       bounded by the lifetime it must remember.
 *
 * A client therefore mints a fresh token per HTTP request
 * (`@motebit/mcp-client` does, via a per-request fetch). There is no legacy
 * acceptance path: an older client that mints `task:submit` is refused with
 * a reason that names the fix.
 *
 * The relay's own bearer (a relay-signed `task:dispatch` token, verified
 * against the pinned relay key by the adapter's dispatch-bearer path) is a
 * separate door and is not decided here.
 */

import { MCP_CALL_AUDIENCE } from "@motebit/sdk";

/**
 * Longest remaining lifetime (`exp - now`) accepted on a caller token. The
 * canonical mint default is 5 minutes; this allows that plus clock skew. A
 * longer-lived token is refused: the replay store must remember every
 * accepted `jti` until it expires, so an unbounded `exp` would be an
 * unbounded memory.
 */
export const MAX_MCP_CALLER_TOKEN_LIFETIME_MS = 15 * 60 * 1000;

/** The claims this law reads. Everything else in the payload is ignored. */
export interface McpCallerClaims {
  mid?: unknown;
  aud?: unknown;
  sub?: unknown;
  jti?: unknown;
  exp?: unknown;
}

export type McpCallerClaimsVerdict = { ok: true } | { ok: false; reason: string };

/**
 * (a), (b), the presence of `jti`, and the lifetime bound — the checks that
 * need no key and no state. Run on the unverified claims to refuse early
 * with a precise reason, and again on the VERIFIED payload, which is the
 * one that decides.
 */
export function checkMcpCallerClaims(
  claims: McpCallerClaims,
  serverMotebitId: string,
  nowMs: number,
): McpCallerClaimsVerdict {
  if (claims.aud !== MCP_CALL_AUDIENCE) {
    const got = typeof claims.aud === "string" ? `"${claims.aud}"` : "none";
    return {
      ok: false,
      reason:
        `token audience ${got} is not accepted for MCP calls — this server requires ` +
        `aud "${MCP_CALL_AUDIENCE}" with sub = its motebit_id (${serverMotebitId}), ` +
        `a fresh token per request. A client that mints task:submit for MCP must upgrade (#957).`,
    };
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return {
      ok: false,
      reason: `token is not bound to a server — sub must be this server's motebit_id (${serverMotebitId})`,
    };
  }
  if (claims.sub !== serverMotebitId) {
    return { ok: false, reason: "token was minted for a different MCP server" };
  }
  if (typeof claims.jti !== "string" || claims.jti.length === 0) {
    return { ok: false, reason: "token carries no jti" };
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: "token carries no expiry" };
  }
  if (claims.exp - nowMs > MAX_MCP_CALLER_TOKEN_LIFETIME_MS) {
    return {
      ok: false,
      reason: `token lifetime exceeds ${MAX_MCP_CALLER_TOKEN_LIFETIME_MS / 60_000} minutes`,
    };
  }
  return { ok: true };
}

/**
 * Where a server remembers which caller-token `jti`s it has accepted. `claim`
 * MUST be atomic: record the key and return true, or return false when the
 * key is already recorded and not yet expired (a replay). A store that
 * cannot record (full, unavailable) returns false — fail closed.
 *
 * The default is in-process. A server run as several instances behind one
 * endpoint SHOULD inject a shared store, or a token accepted by one instance
 * can be replayed once at each other instance within its lifetime.
 */
export interface CallerTokenReplayStore {
  claim(key: string, expiresAt: number): boolean | Promise<boolean>;
}

/** Default replay-store capacity: ~100k accepted tokens live at once. */
export const DEFAULT_CALLER_REPLAY_CAPACITY = 100_000;

/** Full sweeps of expired keys run at most once per this many inserts. */
const SWEEP_EVERY = 1024;

/**
 * In-process `CallerTokenReplayStore`. Bounded: expired keys are swept
 * periodically and whenever the store is full; if it is still full after a
 * sweep, the claim is REFUSED rather than evicting a live key (evicting a
 * live key would reopen its replay window).
 */
export class MemoryCallerTokenReplayStore implements CallerTokenReplayStore {
  private readonly seen = new Map<string, number>();
  private insertsSinceSweep = 0;

  constructor(
    private readonly capacity: number = DEFAULT_CALLER_REPLAY_CAPACITY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  claim(key: string, expiresAt: number): boolean {
    const now = this.now();
    const prior = this.seen.get(key);
    if (prior != null) {
      if (prior > now) return false;
      this.seen.delete(key);
    }
    if (this.insertsSinceSweep >= SWEEP_EVERY || this.seen.size >= this.capacity) this.sweep(now);
    if (this.seen.size >= this.capacity) return false;
    this.seen.set(key, expiresAt);
    this.insertsSinceSweep++;
    return true;
  }

  /** Live entries (tests and diagnostics). */
  get size(): number {
    return this.seen.size;
  }

  private sweep(now: number): void {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    this.insertsSinceSweep = 0;
  }
}

/** The replay-store key for a caller token: scoped by signer, so jtis never collide across callers. */
export function callerReplayKey(mid: string, jti: string): string {
  return `${mid}\u0000${jti}`;
}
