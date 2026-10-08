/**
 * The money capability — what makes an R4_MONEY tool's handler UNREACHABLE
 * except through a gate-decided runtime path.
 *
 * A static scan of `execute` references can always be routed around (a
 * structural interface in another file, `bind`/`call`/`apply`, a callback, a
 * merged registry). So authority is a RUNTIME object, not a property of the
 * call site: the runtime's `SimpleToolRegistry` refuses a money tool unless
 * the call carries a capability that
 *
 *   - was minted by THIS authority (membership in a closure-private WeakMap —
 *     an object literal shaped like one is not a member),
 *   - is bound to the tool name and the exact arguments it was minted for
 *     (canonical JSON, compared at consumption), and
 *   - has not been used (consumption deletes it — single use).
 *
 * The runtime holds `mint` in an ECMAScript-private field and mints only
 * after a decision for THAT call: `executeToolGated` (presenter-bound
 * `verifyGrantForTurn` + `policy.validate` + the blast-radius meter), the AI
 * loop (a gate-allowed call under a grant `verifyGrantForTurn` produced, then
 * metered), and the approval resume (the exact call the gate paused, after a
 * human approved it). Doctrine: docs/doctrine/memory-never-confers-authority.md.
 */

/** Opaque: carries nothing readable; only its identity is checked. */
export interface MoneyCapability {
  readonly __moneyCapability: true;
}

/** The registry-side half: classify and consume, never mint. */
export interface MoneyCapabilityGuard {
  /** True when `def` is a money tool (fails closed: a throw counts as money). */
  isMoney(def: import("@motebit/sdk").ToolDefinition): boolean;
  /** Consume `cap` for this exact call. False ⇒ refuse; never throws. */
  consume(cap: unknown, name: string, args: Record<string, unknown>): boolean;
}

/**
 * Canonical key for a tool call's arguments: sorted-key JSON. Throws on a
 * value JSON cannot represent faithfully (cycles, BigInt) — the caller
 * refuses rather than binding a capability to a lossy key.
 */
export function canonicalCallKey(name: string, args: Record<string, unknown>): string {
  const seen = new Set<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "bigint") throw new Error("bigint argument cannot be bound");
      return v;
    }
    if (seen.has(v)) throw new Error("cyclic argument cannot be bound");
    seen.add(v);
    const out = Array.isArray(v)
      ? v.map(norm)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
        );
    seen.delete(v);
    return out;
  };
  return JSON.stringify([name, norm(args)]);
}

export function createMoneyCapabilityAuthority(isMoney: MoneyCapabilityGuard["isMoney"]): {
  mint(name: string, args: Record<string, unknown>): MoneyCapability;
  guard: MoneyCapabilityGuard;
} {
  const live = new WeakMap<object, string>();
  return {
    mint(name, args) {
      const cap = Object.freeze({}) as MoneyCapability;
      live.set(cap, canonicalCallKey(name, args));
      return cap;
    },
    guard: {
      isMoney(def) {
        try {
          return isMoney(def);
        } catch {
          return true;
        }
      },
      consume(cap, name, args) {
        if (cap === null || typeof cap !== "object") return false;
        const bound = live.get(cap);
        if (bound === undefined) return false;
        live.delete(cap);
        try {
          return bound === canonicalCallKey(name, args);
        } catch {
          return false;
        }
      },
    },
  };
}

/**
 * The loop-side ledger of gate decisions, keyed by exact call. A money call
 * the gate ALLOWED under a produced grant is recorded `decided`; the meter's
 * allow marks it `metered` (a `late`-binding tool is metered at the rail seam
 * and enters already metered); the registry wrapper may mint for it once.
 * A money call the gate PAUSED is recorded `paused` until the approval
 * resolves. Bounded: the oldest entries fall off.
 */
export class MoneyDecisionLedger {
  static readonly MAX = 256;
  readonly #decided: Array<{ key: string; metered: boolean }> = [];
  readonly #paused: string[] = [];

  recordDecided(name: string, args: Record<string, unknown>, metered: boolean): void {
    const key = safeKey(name, args);
    if (key == null) return;
    this.#decided.push({ key, metered });
    if (this.#decided.length > MoneyDecisionLedger.MAX) this.#decided.shift();
  }

  recordMetered(name: string, args: Record<string, unknown>): void {
    const key = safeKey(name, args);
    const entry = this.#decided.find((e) => e.key === key && !e.metered);
    if (entry != null) entry.metered = true;
  }

  takeDecided(name: string, args: Record<string, unknown>): boolean {
    const key = safeKey(name, args);
    const i = this.#decided.findIndex((e) => e.key === key && e.metered);
    if (i < 0) return false;
    this.#decided.splice(i, 1);
    return true;
  }

  recordPaused(name: string, args: Record<string, unknown>): void {
    const key = safeKey(name, args);
    if (key == null) return;
    this.#paused.push(key);
    if (this.#paused.length > MoneyDecisionLedger.MAX) this.#paused.shift();
  }

  /** One approval resolves the pause: every paused entry is dropped either way. */
  takePaused(name: string, args: Record<string, unknown>): boolean {
    const key = safeKey(name, args);
    const found = key != null && this.#paused.includes(key);
    this.#paused.length = 0;
    return found;
  }

  discardPaused(): void {
    this.#paused.length = 0;
  }
}

function safeKey(name: string, args: Record<string, unknown>): string | null {
  try {
    return canonicalCallKey(name, args);
  } catch {
    return null;
  }
}
