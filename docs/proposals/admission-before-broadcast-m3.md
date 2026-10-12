# M3 — admission before broadcast (design options, founder decision)

**Target invariant:** No payment is broadcast unless the task it pays for has already secured admission; a payment can never precede the authority to submit.

**Degree of freedom to remove:** the order of pay vs. admit. Today it is a choice the code path makes (pay, then ask), so every failure between the two leaves a worker paid for a task that never ran.

## Why the client cannot just reorder

`resolveAndSubmitP2pDelegation` (`packages/runtime/src/relay-delegation.ts`) prices the payment and broadcasts it (`buildP2pPayment`). Only then does it mint `task:submit` and POST the task with the proof. The order is forced by the relay. Admission of a P2P submission reads the payment's payer **from the chain** at `confirmed` commitment, and a transaction not yet visible is refused with 503 `TASK_P2P_PROOF_UNVERIFIED` before anything is admitted (`services/relay/src/tasks.ts`, normative in `spec/delegation-v1.md` §3.3 since 1.4). So admission today structurally requires a landed payment. No client-side order can secure admission first. Closing the gap is a wire and spec change.

Evidence: `packages/runtime/src/__tests__/admission-before-broadcast.test.ts`. The `it.fails("GAP: …")` cells assert `broadcasts == 0` whenever admission was not secured. Each one failed on main on that assertion (see the M3a status under D for which still do):

- (a) credentials lost mid-flight (the federated probe: the resolver needs no credential at all)
- (b) a 4xx admission refusal after the broadcast
- (c) a network throw on submit
- abort after the last pricing read

The legitimate flow (one broadcast, the submit carries that payment) is a plain passing cell.

## Options

**A. Two-phase admission (reserve → pay → finalize).**

1. A new submission form carries a `payment_intent` (the exact legs, the payer address, an expiry) and no tx.
2. The relay runs every gate (pricing, eligibility, grant fence, federation plan) and records a PENDING admission bound to those legs and that payer. It returns `admission_id`. Nothing is dispatched.
3. The client broadcasts only while holding that admission. The tx memo carries `admission_id`.
4. The client finalizes with the proof. The relay checks payer, legs and memo against the reservation, then dispatches.

A refusal at finalize can only be the client's own mismatch or an expired reservation.

- Wire: a new endpoint or field, new error codes, and `spec/delegation-v1.md` §3.3 1.5 (additive).
- Federation: the origin must also reserve at the executor, which touches the federation envelope.
- Relay state: a pending-admission table plus a sweep.

**B. The relay broadcasts.** The client signs and does not send. The relay runs the gates, then sends the delegator's signed tx itself. This closes every window in one round trip. The cost is doctrine: it makes the relay the transmitter of user funds, which contradicts "transmitter surface structurally zero".

**C. Admit against a signed, unsent durable-nonce tx; kill on refusal.**

1. The client signs a durable-nonce payment (the relay's Path 0 already uses this primitive).
2. It submits the signature and the signed bytes. The relay checks the fee payer is the submitter's derived address from the bytes, without sending them.
3. The relay runs every gate and admits the task as PENDING-PAYMENT. The signature is the binding key, as `Idempotency-Key` already is.
4. The client broadcasts only after admission. On a refusal it advances its nonce and the tx can never land.
5. The relay dispatches only once the payer read sees the tx landed.

- Spec: §3.3 moves the chain read from admission time to dispatch time.
- Wallet: `wallet-solana` gains a delegator nonce lane.
- Runtime: `buildP2pPayment` takes a `SecuredAdmission` runtime capability (the M2 pattern) that only the admission step can mint, so broadcasting without one throws.

**D. Interim, client-only (no wire change, does not meet the invariant).** Immediately before broadcast:

- re-check the abort signal;
- pre-mint the `task:submit` credential and hold it across the broadcast;
- re-run the eligibility pre-flight (the federated path has none today).

This closes (a) and the abort cell and narrows (b). It does not close (c), or (b) for gates the pre-flight does not mirror.

**Status: D shipped on this branch as M3a** (`packages/runtime/src/relay-delegation.ts`, client only; no wire, spec or relay change):

- `resolveP2pPaymentRequest` mints the `task:submit` credential once the request is priced and returns it (`submitToken`). No credential ⇒ no priced request (`auth_expired`). `resolveAndSubmitP2pDelegation` holds it across the broadcast and presents it on the first submission attempt.
- `recheckP2pPreflight` runs immediately before the broadcast. For a local worker it re-reads `/p2p-eligibility` (still allowed, same registered address, same expected amounts). For a federated worker, which had no pre-flight, it re-reads the origin's discovery and requires the same worker through the same peer, at the same address, at a price equal to this payment's budget. That is the part of the relay's federated "discover and validate before admission" gate a client can read from existing endpoints. A refusal is `p2p_ineligible`.
- The abort signal is re-checked last, after the re-check, before anything is signed. Discovery and every `fetchSignedRelayFeeRate` read already received the delegation's signal.

Cells now plain passing tests: the resolver's credential-loss cell, (a), (a′) (credentials lost during the broadcast; the held credential submits), abort-after-pricing, and three narrowed (b) cells (federated worker delisted, federated worker repriced, local pair turned ineligible, each between pricing and broadcast).

**Cells still open (`it.fails`, the founder-decision backlog):**

- `GAP (b)`: a 4xx admission refusal that no pre-flight mirrors (the re-check saw an admissible worker).
- `GAP (c)`: a network failure on submit after the broadcast.

Both close only with the founder-chosen protocol option (A, B or C).

**Recommendation:** C, with D shipped first as M3a. C reuses the existing primitives (durable nonce, the signature as idempotency key, the M2 capability pattern). It keeps the relay a non-transmitter. Its only normative move is when the payer is read.
