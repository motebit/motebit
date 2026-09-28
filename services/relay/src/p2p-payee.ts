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
import type { DatabaseDriver } from "@motebit/persistence";
import { isDerivedSettlementBinding } from "@motebit/wallet-solana";
import type { TaskQueueEntry } from "./tasks.js";
import { verificationKeyFor } from "./identity-keys.js";

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
 * What P2P admission decided about the worker leg, stamped on the queue entry
 * by the admission branch that accepted the proof and frozen onto the
 * settlement row by the writer (#959 round 2).
 *
 *   - `worker_leg` — which relay verifies the worker leg. `"local"`: the
 *     worker is hosted here (single-operator admission, or the executor relay
 *     of a federated task). `"remote"`: this relay ORIGINATED a cross-operator
 *     task (the `federatedP2pIntent` branch); the executor relay verifies the
 *     worker leg and this relay only its own fee leg.
 *   - `worker_address` / `worker_address_rung` — the address the proof's
 *     worker leg was validated against AT ADMISSION, and the settlement-
 *     authority rung it reached then (`"derived"`: the worker's identity key
 *     derives it; `"registered"`: the worker's own write-authorized registry
 *     address). The verifier checks against this, so a worker that changes
 *     its address mid-flight does not turn a correctly paid payer into a
 *     failure.
 *
 * Decided by the ADMISSION BRANCH, never inferred from the proof's shape: the
 * proof is payer-supplied, and inferring `"remote"` from a `b_fee_*` field let
 * a payer switch the worker-leg check off on a local task (cold review).
 */
export interface P2pAdmission {
  worker_leg: "local" | "remote";
  /**
   * `"remote"` only: the executor relay the BUILT federated plan was
   * forwarded to and that accepted it. A `"remote"` admission without it
   * reads as `"local"` (#959 round 3) — the scope is remote only when a plan
   * was built AND forwarded.
   */
  forwarded_to?: string;
  worker_address?: string;
  worker_address_rung?: "derived" | "registered";
}

/**
 * Which relay verifies the worker leg of this entry's settlement. An entry
 * admitted before #959 round 2 carries no admission record and reads as
 * `"local"` — the fail-closed side: the worker leg is checked, and a worker
 * this relay does not host reads `unverifiable`, never verified. `"remote"`
 * requires BOTH a built federated plan (the admission record) and an
 * accepted forward (`forwarded_to`).
 */
export function p2pWorkerLegScope(
  entry: Pick<TaskQueueEntry, "p2p_admission">,
): "local" | "remote" {
  const a = entry.p2p_admission;
  return a?.worker_leg === "remote" && a.forwarded_to != null && a.forwarded_to !== ""
    ? "remote"
    : "local";
}

/**
 * The admission record for a LOCAL worker whose proof's worker leg was just
 * validated against `address` (the worker's own registry address). The rung
 * is `"derived"` when the worker's identity key derives that address, else
 * `"registered"`.
 */
export function localWorkerAdmission(
  db: DatabaseDriver,
  workerId: string,
  address: string,
): P2pAdmission {
  const reg = db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(workerId) as { public_key: string | null } | undefined;
  // Holder, else main's registry read (§5f verification reader).
  const key = verificationKeyFor(db, workerId, reg?.public_key);
  const derived = key != null && isDerivedSettlementBinding(address, key);
  return {
    worker_leg: "local",
    worker_address: address,
    worker_address_rung: derived ? "derived" : "registered",
  };
}
