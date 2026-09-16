/**
 * Replay guard for signed remote commands.
 *
 * `signed-request-envelope@1.0` binds a command to an identity, an
 * audience and a payload digest, and bounds it by freshness — a window
 * measured in minutes. While the remote vocabulary was read-only that
 * was the whole defence it needed: replaying `state` shows state again.
 *
 * It stopped being sufficient the moment a mutating verb joined the
 * vocabulary. The relay sees every envelope in plaintext and is
 * explicitly not the trust root, so a captured `resume` replayed inside
 * the window would lift a halt the sovereign had just applied — the
 * exact act a halt exists to make stick.
 *
 * Ed25519 signing here is deterministic over the canonical payload, so
 * a byte-identical envelope has a byte-identical signature: a repeated
 * signature IS a replay, and no nonce is needed to see one. Two
 * genuinely separate commands carry different timestamps and so
 * different signatures.
 *
 * A companion to the freshness window, not a substitute for it: outside
 * that window the verifier has already refused the envelope, so nothing
 * needs to be remembered longer than the window itself.
 *
 * Supply a `store` wherever more than one process on a machine can
 * receive these commands — `motebit run` and `motebit serve` both
 * announce `unattended_runtime`, and the relay may pick either, so a
 * replay landing on the sibling of the process that saw the original
 * would sail through a purely in-memory guard.
 */
export interface CommandReplayStore {
  /** Record and report in one atomic step. */
  isReplay(signature: string, now: number, windowMs: number): boolean;
}

/** Why a command was refused — "already sent" and "could not check" are not the same answer. */
export type ReplayVerdict =
  { accepted: true } | { accepted: false; reason: "replay" | "store_unavailable"; message: string };

export class CommandReplayGuard {
  private seen = new Map<string, number>();

  /**
   * @param windowMs How long a signature is remembered. Defaults to
   * twice the verifier's freshness window, so an envelope can never age
   * out of here while it would still be accepted there.
   * @param store Shared, durable memory. Without one the guard is
   * per-process, which is only sufficient when this process is the only
   * one that can receive these commands. When a store IS wired and it
   * throws, the command is refused rather than checked against the
   * narrower per-process set — see `isReplay`.
   */
  constructor(
    private readonly windowMs = 600_000,
    private readonly store?: CommandReplayStore,
  ) {}

  /**
   * Record this envelope and report whether it has been accepted
   * before. Call it AFTER signature verification — an unverified
   * signature is attacker-chosen input, and remembering it would let a
   * stranger fill the set.
   */
  isReplay(signature: string, now = Date.now()): boolean {
    return !this.check(signature, now).accepted;
  }

  /**
   * The same decision, with the REASON attached.
   *
   * A refusal has two causes that mean opposite things to whoever sent
   * the command — "you already sent this" and "I could not check" — and
   * reporting the first for the second is a confident wrong diagnosis
   * about the one vocabulary where being told nothing happened matters
   * most. Callers that surface a message use this; `isReplay` is the
   * boolean shorthand for callers that only gate.
   */
  check(signature: string, now = Date.now()): ReplayVerdict {
    if (this.store) {
      try {
        return this.store.isReplay(signature, now, this.windowMs)
          ? {
              accepted: false,
              reason: "replay",
              message: "this envelope has already been accepted (replay)",
            }
          : { accepted: true };
      } catch (err) {
        // Refuse, do not degrade. The shared store exists precisely to
        // catch a replay landing on the SIBLING process, which a
        // per-process set cannot see: with `motebit run` and
        // `motebit serve` on one machine, a busy database would let a
        // captured `resume` accepted by one be replayed to the other
        // inside the freshness window, lifting a halt the sovereign had
        // just applied. Falling back is not "narrower" there, it is
        // exactly the hole the store was added for. Refusing costs a
        // retry of a legitimate command; degrading costs the guarantee.
        return {
          accepted: false,
          reason: "store_unavailable",
          message: `the replay record could not be read, so this command was refused rather than run unchecked (${err instanceof Error ? err.message : String(err)})`,
        };
      }
    }
    this.prune(now);
    if (this.seen.has(signature)) {
      return {
        accepted: false,
        reason: "replay",
        message: "this envelope has already been accepted (replay)",
      };
    }
    this.seen.set(signature, now);
    return { accepted: true };
  }

  /**
   * Signatures remembered IN THIS PROCESS. Zero whenever a shared store
   * is wired, because the memory lives there — a diagnostic reading
   * this to confirm the guard is working would otherwise be measuring
   * nothing in exactly the production configuration.
   */
  get inMemorySize(): number {
    return this.store ? 0 : this.seen.size;
  }

  /** True when this guard delegates to shared, durable memory. */
  get isShared(): boolean {
    return this.store !== undefined;
  }

  private prune(now: number): void {
    for (const [sig, at] of this.seen) {
      if (now - at > this.windowMs) this.seen.delete(sig);
    }
  }
}
