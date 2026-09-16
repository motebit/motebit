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
 * In-memory and per-process by design. It is a companion to the
 * freshness window, not a substitute for it: outside that window the
 * verifier has already refused the envelope, so nothing needs to be
 * remembered longer than the window itself.
 */
export class CommandReplayGuard {
  private seen = new Map<string, number>();

  /**
   * @param windowMs How long a signature is remembered. Defaults to
   * twice the verifier's freshness window, so an envelope can never age
   * out of here while it would still be accepted there.
   */
  constructor(private readonly windowMs = 600_000) {}

  /**
   * Record this envelope and report whether it has been accepted
   * before. Call it AFTER signature verification — an unverified
   * signature is attacker-chosen input, and remembering it would let a
   * stranger fill the set.
   */
  isReplay(signature: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(signature)) return true;
    this.seen.set(signature, now);
    return false;
  }

  /** Signatures currently remembered. For tests and diagnostics. */
  get size(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [sig, at] of this.seen) {
      if (now - at > this.windowMs) this.seen.delete(sig);
    }
  }
}
