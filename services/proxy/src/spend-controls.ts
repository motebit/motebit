/**
 * Spend controls for the motebit-cloud path — the bound on how much of the
 * operator's provider key one identity can spend, enforced BEFORE the
 * provider call.
 *
 * The proxy token carries a balance SNAPSHOT (`bal`) taken when the relay
 * minted it, and the relay debit happens after the stream. Without anything
 * in between, a $0.10 free-credit identity could run unbounded concurrent
 * Opus requests for the token's whole hour. Three controls close that:
 *
 *   1. **Live-ish balance.** Every completed request records its cost against
 *      the token's `jti` (`proxy:spent:<jti>`). A request is admitted only
 *      while `bal − spent > 0`. Keyed by jti, not mid, so a fresh token minted
 *      after a real deposit starts from its own (already-debited) snapshot
 *      and is never double-charged for spend the relay has since recorded.
 *   2. **Per-identity rate.** `proxy:rpm:<mid>:<minute>` ≤ RPM_LIMIT.
 *   3. **Per-identity concurrency.** `proxy:active:<mid>` ≤ CONCURRENCY_LIMIT;
 *      the slot is released in the stream pump's `finally`.
 *
 * Fail-closed on a KV error for the money path (contrast the embed route,
 * which is best-effort and fails open by design). Local dev with no KV
 * configured skips the controls, matching every sibling route; the origin
 * allowlist still gates callers there.
 *
 * The store is injectable so the route's behaviour is unit-testable without
 * Vercel KV; `@vercel/kv` is loaded lazily only when configured.
 */

export interface SpendStore {
  incr(key: string): Promise<number>;
  incrby(key: string, n: number): Promise<number>;
  decr(key: string): Promise<number>;
  get(key: string): Promise<number | null>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** Requests per identity per minute on the motebit-cloud path. */
export const DEPOSIT_RPM_LIMIT = 20;
/** Concurrent in-flight streams per identity on the motebit-cloud path. */
export const DEPOSIT_CONCURRENCY_LIMIT = 3;
/** Token lifetime is 1h at the relay; the per-jti spend record outlives it slightly. */
const SPENT_TTL_SECONDS = 2 * 60 * 60;
/** A leaked slot (crash mid-stream) self-heals within this window. */
const ACTIVE_TTL_SECONDS = 5 * 60;

let testStore: SpendStore | null | undefined;

/** Test seam. `null` forces "no store configured"; `undefined` restores default resolution. */
export function setSpendStoreForTests(store: SpendStore | null | undefined): void {
  testStore = store;
}

async function resolveStore(): Promise<SpendStore | null> {
  if (testStore !== undefined) return testStore;
  if (!process.env.KV_REST_API_URL) return null;
  const { kv } = await import("@vercel/kv");
  return {
    incr: (k) => kv.incr(k),
    incrby: (k, n) => kv.incrby(k, n),
    decr: (k) => kv.decr(k),
    get: async (k) => {
      const v = await kv.get<number | string | null>(k);
      if (v == null) return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    },
    expire: (k, s) => kv.expire(k, s),
  };
}

export type SpendAdmission =
  | { ok: true; release: () => Promise<void>; record: (costMicro: number) => Promise<void> }
  | {
      ok: false;
      reason: "balance_exhausted" | "rate_limited" | "concurrency_limited" | "store_unavailable";
      retryAfterSeconds?: number;
      remainingMicro?: number;
    };

const NOOP_ADMISSION: SpendAdmission = {
  ok: true,
  release: async () => {},
  record: async () => {},
};

/**
 * Admit or refuse a motebit-cloud request. Call after the token is verified
 * and before anything spends (including the auto-routing classifier). On
 * `ok`, the caller MUST invoke `release()` exactly once when the request
 * ends and `record(cost)` with the metered cost.
 */
export async function admitSpend(token: {
  mid: string;
  jti: string;
  bal: number;
}): Promise<SpendAdmission> {
  let store: SpendStore | null;
  try {
    store = await resolveStore();
  } catch {
    return { ok: false, reason: "store_unavailable" };
  }
  if (store == null) return NOOP_ADMISSION;

  const spentKey = `proxy:spent:${token.jti}`;
  const minute = Math.floor(Date.now() / 60_000);
  const rpmKey = `proxy:rpm:${token.mid}:${minute}`;
  const activeKey = `proxy:active:${token.mid}`;

  try {
    // 1. Live-ish balance: the snapshot minus what THIS token has already spent.
    const spent = (await store.get(spentKey)) ?? 0;
    const remaining = token.bal - spent;
    if (remaining <= 0) {
      return { ok: false, reason: "balance_exhausted", remainingMicro: Math.max(0, remaining) };
    }

    // 2. Per-identity rate.
    const rpm = await store.incr(rpmKey);
    if (rpm === 1) await store.expire(rpmKey, 120);
    if (rpm > DEPOSIT_RPM_LIMIT) {
      return { ok: false, reason: "rate_limited", retryAfterSeconds: 60 };
    }

    // 3. Per-identity concurrency — take the slot, give it back on refusal.
    const active = await store.incr(activeKey);
    await store.expire(activeKey, ACTIVE_TTL_SECONDS);
    if (active > DEPOSIT_CONCURRENCY_LIMIT) {
      await store.decr(activeKey);
      return { ok: false, reason: "concurrency_limited", retryAfterSeconds: 5 };
    }

    let released = false;
    return {
      ok: true,
      release: async () => {
        if (released) return;
        released = true;
        try {
          const n = await store.decr(activeKey);
          // A slot that expired mid-stream and was re-created decrements past
          // zero; clamp so a stale counter never blocks a healthy identity.
          if (n < 0) await store.incrby(activeKey, -n);
        } catch {
          /* release is best-effort; the TTL heals a missed release */
        }
      },
      record: async (costMicro: number) => {
        if (costMicro <= 0) return;
        try {
          await store.incrby(spentKey, Math.round(costMicro));
          await store.expire(spentKey, SPENT_TTL_SECONDS);
        } catch {
          /* recording is best-effort; the relay debit is the ledger of record */
        }
      },
    };
  } catch {
    // KV configured but failing: money path fails CLOSED.
    return { ok: false, reason: "store_unavailable" };
  }
}

/** In-memory store for tests and single-process dev. */
export function memorySpendStore(): SpendStore & { map: Map<string, number> } {
  const map = new Map<string, number>();
  const bump = (k: string, n: number): number => {
    const v = (map.get(k) ?? 0) + n;
    map.set(k, v);
    return v;
  };
  return {
    map,
    incr: (k) => Promise.resolve(bump(k, 1)),
    incrby: (k, n) => Promise.resolve(bump(k, n)),
    decr: (k) => Promise.resolve(bump(k, -1)),
    get: (k) => Promise.resolve(map.get(k) ?? null),
    expire: () => Promise.resolve(1),
  };
}
