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
 *   (c) its `jti` (at most `MCP_CALL_MAX_JTI_LENGTH` characters) has not been
 *       accepted before within the token's lifetime. The replay store keeps a
 *       fixed-size digest per token, bounds each caller's live entries (one
 *       identity can never starve another), and refuses — with its own
 *       reason — when full rather than forgetting a live entry;
 *   (d) the signature verifies under the caller's key and the token has not
 *       expired (`verifySignedToken`); `exp` is at most
 *       `MAX_MCP_CALLER_TOKEN_LIFETIME_MS` (2 min) past the server's now and
 *       `iat` at most `MCP_CALL_CLOCK_SKEW_MS` (1 min) in its future. Clients
 *       mint with `MCP_CALL_TOKEN_TTL_MS` (1 min), so the allowance is a
 *       minute of clock skew either way. The short window bounds how much the
 *       store must remember.
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

import {
  MCP_CALL_AUDIENCE,
  MCP_CALL_CLOCK_SKEW_MS,
  MCP_CALL_MAX_JTI_LENGTH,
  MCP_CALL_TOKEN_TTL_MS,
} from "@motebit/sdk";
import { bytesToHex, sha256 } from "@motebit/encryption";

/**
 * Longest remaining lifetime (`exp - now`) accepted on a caller token: the
 * client mint lifetime plus the clock-skew allowance (2 minutes).
 */
export const MAX_MCP_CALLER_TOKEN_LIFETIME_MS = MCP_CALL_TOKEN_TTL_MS + MCP_CALL_CLOCK_SKEW_MS;

/** The claims this law reads. Everything else in the payload is ignored. */
export interface McpCallerClaims {
  mid?: unknown;
  aud?: unknown;
  sub?: unknown;
  jti?: unknown;
  iat?: unknown;
  exp?: unknown;
}

export type McpCallerClaimsVerdict = { ok: true } | { ok: false; reason: string };

/**
 * (a), (b), the shape of `jti`, and the time window — the checks that need
 * no key and no state. Run on the unverified claims to refuse early with a
 * precise reason, and again on the payload the verifier returns.
 */
export function checkMcpCallerClaims(
  claims: McpCallerClaims,
  serverMotebitId: string,
  nowMs: number,
): McpCallerClaimsVerdict {
  if (claims.aud !== MCP_CALL_AUDIENCE) {
    const got = typeof claims.aud === "string" ? `"${claims.aud.slice(0, 64)}"` : "none";
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
  if (claims.jti.length > MCP_CALL_MAX_JTI_LENGTH) {
    return { ok: false, reason: `token jti exceeds ${MCP_CALL_MAX_JTI_LENGTH} characters` };
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: "token carries no expiry" };
  }
  if (claims.exp - nowMs > MAX_MCP_CALLER_TOKEN_LIFETIME_MS) {
    return {
      ok: false,
      reason:
        `token lifetime exceeds ${MAX_MCP_CALLER_TOKEN_LIFETIME_MS / 1000}s ` +
        `(mint with ${MCP_CALL_TOKEN_TTL_MS / 1000}s; clock skew allowance ${MCP_CALL_CLOCK_SKEW_MS / 1000}s)`,
    };
  }
  if (typeof claims.iat === "number" && claims.iat - nowMs > MCP_CALL_CLOCK_SKEW_MS) {
    return {
      ok: false,
      reason: `token issued in the future beyond the ${MCP_CALL_CLOCK_SKEW_MS / 1000}s clock skew allowance`,
    };
  }
  return { ok: true };
}

/** One accepted token, as the replay store sees it: fixed-size digests only. */
export interface CallerReplayEntry {
  /** SHA-256 hex of `mid ‖ jti` — 64 characters whatever the jti. */
  key: string;
  /** SHA-256 hex of `mid` — the quota bucket. */
  caller: string;
  /** The token's `exp`; the entry is forgotten after it. */
  expiresAt: number;
}

/**
 * - `accepted` — recorded;
 * - `replay` — this key is live (the token was used before);
 * - `caller_quota` — this caller already holds its maximum of live entries;
 * - `full` — the store holds its maximum of live entries.
 */
export type CallerReplayClaim = "accepted" | "replay" | "caller_quota" | "full";

/**
 * Where a server remembers which caller tokens it has accepted. `claim` MUST
 * be atomic and fail closed: anything but `accepted` refuses the token. A
 * store never forgets a live entry to make room.
 *
 * The default is in-process. A server run as several instances behind one
 * endpoint SHOULD inject a shared store, or a token accepted by one instance
 * can be replayed once at each other instance within its lifetime.
 */
export interface CallerTokenReplayStore {
  claim(entry: CallerReplayEntry): CallerReplayClaim | Promise<CallerReplayClaim>;
}

/** Default replay-store capacity: live accepted tokens across all callers. */
export const DEFAULT_CALLER_REPLAY_CAPACITY = 100_000;

/** Default live-entry quota per caller. */
export const DEFAULT_CALLER_REPLAY_QUOTA = 1_000;

/**
 * In-process `CallerTokenReplayStore`. Entries sit in a map (constant size
 * each: two 64-char digests and a number) and in a min-heap ordered by
 * expiry; every claim pops only the entries that have expired, so each entry
 * is swept exactly once (amortized O(log n) per claim, never an O(n) scan).
 */
export class MemoryCallerTokenReplayStore implements CallerTokenReplayStore {
  private readonly live = new Map<string, { exp: number; caller: string }>();
  private readonly perCaller = new Map<string, number>();
  private readonly heap: Array<{ exp: number; key: string }> = [];

  constructor(
    private readonly capacity: number = DEFAULT_CALLER_REPLAY_CAPACITY,
    private readonly quotaPerCaller: number = DEFAULT_CALLER_REPLAY_QUOTA,
    private readonly now: () => number = () => Date.now(),
  ) {}

  claim(entry: CallerReplayEntry): CallerReplayClaim {
    this.evictExpired(this.now());
    if (this.live.has(entry.key)) return "replay";
    if ((this.perCaller.get(entry.caller) ?? 0) >= this.quotaPerCaller) return "caller_quota";
    if (this.live.size >= this.capacity) return "full";
    this.live.set(entry.key, { exp: entry.expiresAt, caller: entry.caller });
    this.perCaller.set(entry.caller, (this.perCaller.get(entry.caller) ?? 0) + 1);
    this.push({ exp: entry.expiresAt, key: entry.key });
    return "accepted";
  }

  /** Live entries (tests and diagnostics). */
  get size(): number {
    return this.live.size;
  }

  /** Live entries held by one caller bucket (tests and diagnostics). */
  liveFor(caller: string): number {
    return this.perCaller.get(caller) ?? 0;
  }

  /** The stored keys (tests: every key is a fixed-size digest). */
  keys(): string[] {
    return [...this.live.keys()];
  }

  private evictExpired(now: number): void {
    while (this.heap.length > 0 && this.heap[0]!.exp <= now) {
      const top = this.pop();
      const row = this.live.get(top.key);
      if (row == null || row.exp !== top.exp) continue;
      this.live.delete(top.key);
      const n = (this.perCaller.get(row.caller) ?? 1) - 1;
      if (n <= 0) this.perCaller.delete(row.caller);
      else this.perCaller.set(row.caller, n);
    }
  }

  private push(item: { exp: number; key: string }): void {
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]!.exp <= h[i]!.exp) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }

  private pop(): { exp: number; key: string } {
    const h = this.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l]!.exp < h[m]!.exp) m = l;
        if (r < h.length && h[r]!.exp < h[m]!.exp) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }
}

const hex256 = async (s: string): Promise<string> =>
  bytesToHex(await sha256(new TextEncoder().encode(s)));

/**
 * The replay-store entry for a caller token: fixed-size digests, so a long
 * `mid` or `jti` costs the store nothing extra. The key is scoped by signer,
 * so jtis never collide across callers.
 */
export async function callerReplayEntry(
  mid: string,
  jti: string,
  expiresAt: number,
): Promise<CallerReplayEntry> {
  return {
    key: await hex256(`${mid}\u0000${jti}`),
    caller: await hex256(mid),
    expiresAt,
  };
}

/** The refusal reason for a store verdict other than `accepted`. */
export function replayRefusalReason(claim: Exclude<CallerReplayClaim, "accepted">): string {
  switch (claim) {
    case "replay":
      return "token already used — mint a fresh token per request";
    case "caller_quota":
      return "too many live tokens for this caller";
    case "full":
      return "replay store at capacity — retry shortly";
  }
}
