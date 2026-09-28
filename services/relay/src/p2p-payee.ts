/**
 * Who a P2P settlement record names as its payee, and which relay verifies
 * that payee's leg (#959).
 *
 * A P2P audit row records a payment the delegator already made onchain. Its
 * payee is the worker that payment PAID — never the agent in the submission
 * path. The runtime's P2P submit posts to the DELEGATOR's own endpoint
 * (`POST /agent/<delegator>/task` with `target_agent: <worker>`), so the path
 * agent (`task.motebit_id`) is the payer there; recording it as the payee made
 * every signed P2P record name the delegator, had the verifier check the
 * worker leg against the delegator's wallet, let a correct sub-hop row fall to
 * the `p2p_tx_hash` unique index, and stripped a paying delegator's receiving
 * `settlement_modes`.
 *
 * The authoritative source is the ADMITTED worker, persisted on the queue
 * entry in the same transaction as the #918 proof claim:
 *
 *   - `target_agent` — on a P2P submission it is the worker the proof's
 *     worker leg was validated against (address and amount) at admission,
 *     the worker the dispatch token binds (`mid`), and the worker the task is
 *     routed and priced for (`terms.routedTo`).
 *   - `task.motebit_id` when there is no `target_agent` — only on the EXECUTOR
 *     relay of a federated P2P task, whose forwarded task is filed under the
 *     pinned worker (`motebit_id = verified.targetAgent`).
 *
 * Not the receipt signer. The signer is who ran; the payee is who was paid.
 * They must agree, and every writer refuses to record a P2P settlement when
 * they do not (`receiptDischargesP2p`): a receipt from any other identity is
 * not the work the payment bought.
 */
import type { TaskQueueEntry } from "./tasks.js";

/** The worker a P2P task's onchain payment paid: the admitted, pinned worker. */
export function p2pPayeeOf(entry: Pick<TaskQueueEntry, "target_agent" | "task">): string {
  return entry.target_agent != null && entry.target_agent !== ""
    ? entry.target_agent
    : entry.task.motebit_id;
}

/** Whether a receipt signed by `signerId` discharges the P2P payment on `entry`. */
export function receiptDischargesP2p(
  entry: Pick<TaskQueueEntry, "target_agent" | "task">,
  signerId: string,
): boolean {
  return signerId === p2pPayeeOf(entry);
}

/**
 * Which relay verifies the worker leg of this P2P settlement, frozen on the
 * row at write time (`relay_settlements.p2p_worker_leg`):
 *
 *   - `"local"` — the worker is hosted here: a single-operator P2P task, or
 *     the EXECUTOR relay of a federated one (`origin_relay` set). This relay
 *     checks the worker leg against the worker's bound addresses.
 *   - `"remote"` — this relay ORIGINATED a cross-operator federated task (a
 *     3-leg proof, `b_fee_*` present, no `origin_relay`). The worker is hosted
 *     by the executor relay, which verifies the worker leg; this relay
 *     verifies only its own fee leg.
 *
 * Declared, never inferred from the worker's absence in `agent_registry`:
 * inferring "not applicable" from a missing row is how the worker leg passed
 * unverified when the recorded payee was an unregistered delegator.
 */
export function p2pWorkerLegScope(
  entry: Pick<TaskQueueEntry, "origin_relay" | "p2p_payment_proof">,
): "local" | "remote" {
  if (entry.origin_relay != null) return "local";
  return entry.p2p_payment_proof?.b_fee_to_address != null ? "remote" : "local";
}
