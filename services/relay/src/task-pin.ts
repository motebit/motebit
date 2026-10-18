/**
 * A pinned task's executor is its target, or no one.
 *
 * A task submitted for an explicit target is executed by that target or by
 * no one; an offline target means the task waits, expires or fails — it
 * never becomes another worker's task. The degree of freedom this module
 * removes: the relay can no longer substitute the executor of a pinned task.
 *
 * How a pin is expressed on the wire (one reading, `submissionTerms`):
 *
 *   - a P2P submission names its worker in `target_agent` (the runtime posts
 *     to the DELEGATOR's own path; the proof pays that worker) — pinned to
 *     `target_agent`;
 *   - a submission whose path agent is NOT its submitter (`motebit delegate
 *     --target X` posts to `/agent/X/task`; a molecule's sub-task likewise)
 *     — pinned to the path agent, the worker the task is priced for. The
 *     submitter must be an IDENTITY: the verified caller, or an operator-
 *     asserted `submitted_by` this relay knows. A label (the planner's
 *     master-token `"plan_engine"`) names no one, so the operator is speaking
 *     for the path agent, as below;
 *   - a non-P2P submission naming `target_agent` (which `submissionTerms`
 *     allows only when it equals the path agent) — pinned to it.
 *
 * Unpinned: the path agent IS the submitter (the runtime's capability
 * routing posts to its own inbox), or there is no submitter identity at all
 * (an operator's master-token submission naming only the path agent, or a
 * label). There the relay chooses the worker, exactly as before.
 *
 * OPEN (#1112 F1): with no verified caller (the master token) the pin rests
 * on `isKnownIdentity(submitted_by)`, so a master-token client that
 * addresses an offline agent naming an unknown submitter and no
 * `target_agent` is unpinned. The first-party addressed doors therefore NAME
 * their target in `target_agent` (`motebit delegate`, the A2A and AP2
 * bridges), which pins whatever token carries the request. Pinning every
 * submission whose submitter is not provably the path agent would also pin
 * the planner's documented master-token flow (`"plan_engine"` to its own
 * path) and an operator's no-submitter capability routing — held for a
 * decision, not taken here.
 *
 * The pin is stamped on the queue entry at admission (`pinned_executor`) and
 * read through these predicates at EVERY place an executor is chosen or
 * accepted — candidate selection (ranked and fallback), presentation, claim,
 * answer, settlement attribution. An entry without a pin (unpinned, or
 * admitted before the pin existed) is unconstrained, byte-for-byte as before.
 */

/** The submission facts a pin is read from (`submissionTerms` + the body). */
export interface PinInput {
  /** The verified caller, else a non-empty `submitted_by`. */
  submitter: string | undefined;
  /**
   * The submitter is an identity — the verified caller, or an asserted
   * `submitted_by` the relay knows (`isKnownIdentity`) — not a label.
   */
  submitterIsIdentity: boolean;
  /** A P2P proof submission (`payment_proof` + `target_agent` + submitter). */
  p2p: boolean;
  /** The worker the task is priced and routed for (`terms.routedTo`). */
  routedTo: string;
  /** The `:motebitId` the submission was posted to. */
  pathAgentId: string;
  /** A non-empty `target_agent` in the body, when present. */
  explicitTarget: string | null;
}

/**
 * The executor a submission pins, or null when the relay may choose. Pure:
 * every routing phase, and the admission that stamps the entry, read it the
 * same way.
 */
export function taskPinOf(input: PinInput): string | null {
  if (input.p2p) return input.routedTo;
  if (input.explicitTarget != null) return input.routedTo;
  if (
    input.submitter != null &&
    input.submitterIsIdentity &&
    input.submitter !== input.pathAgentId
  ) {
    return input.routedTo;
  }
  return null;
}

/** The pin an entry carries (stamped at admission), or null. */
export function pinOf(entry: { pinned_executor?: string }): string | null {
  const pin = entry.pinned_executor;
  return typeof pin === "string" && pin !== "" ? pin : null;
}

/** May `executorId` execute (or answer, or be paid for) a task pinned to `pin`? */
export function executorAllowed(pin: string | null, executorId: string): boolean {
  return pin == null || executorId === pin;
}

/**
 * Candidate selection under a pin — the ONE filter every routing phase's
 * candidate set passes through: pinned ⇒ only the target (or nothing);
 * unpinned ⇒ the candidates unchanged (the same array).
 */
export function candidatesUnderPin<T>(
  pin: string | null,
  candidates: T[],
  idOf: (c: T) => string,
): T[] {
  if (pin == null) return candidates;
  return candidates.filter((c) => idOf(c) === pin);
}

/**
 * The scored phase under a pin: the target's own profile, selected on its
 * own route (through the peer relay that listed it, else direct), or nothing.
 * A target this relay holds a key for is never offered a peer's listing
 * (tasks.ts, `pinHostedHere`).
 * Never ranked — a pin is a deterministic override, so no composite score
 * (a zero-history pair, a ranker whose "self" is the target) can drop it or
 * put another agent in its place.
 */
export function pinnedSelection(
  pin: string,
  profiles: ReadonlyArray<{ motebit_id: string; reachable_via?: string }>,
): Array<{
  motebit_id: string;
  composite: number;
  sub_scores: Record<string, number>;
  routing_paths: string[][];
  alternatives_considered: number;
}> {
  const target = profiles.find((p) => p.motebit_id === pin);
  if (target == null) return [];
  const via = target.reachable_via;
  return [
    {
      motebit_id: pin,
      composite: 1,
      sub_scores: { pinned: 1 },
      routing_paths: [via != null && via !== "" ? [via, pin] : [pin]],
      alternatives_considered: 0,
    },
  ];
}

/**
 * The answer door's check (`answerTask`): a receipt signed by anyone but a
 * pinned task's target never becomes its answer.
 */
export function pinRefusesAnswer(entry: { pinned_executor?: string }, signer: string): boolean {
  return !executorAllowed(pinOf(entry), signer);
}

/**
 * Settlement attribution (`admitReceipt`, before any settlement step): a
 * pinned task's settlement never names anyone but its target — checked on
 * the entry's own answer, independently of the answer door.
 */
export function pinRefusesSettlement(entry: { pinned_executor?: string }, payee: string): boolean {
  return !executorAllowed(pinOf(entry), payee);
}

/**
 * The claim door (`TaskClaims.claim`) and presentation (reconnect recovery,
 * a released forward's re-presentation): only the target's own bodies are
 * offered — and may claim — a pinned task.
 */
export function pinRefusesClaim(entry: { pinned_executor?: string }, claimant: string): boolean {
  return !executorAllowed(pinOf(entry), claimant);
}
