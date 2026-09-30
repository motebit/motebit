# motebit/market@1.0

## Agent Market Specification

**Status:** Stable
**Version:** 1.0
**Date:** 2026-03-24

---

## 1. Overview

The agent market protocol defines how agents discover services, allocate budgets, delegate tasks, settle payments, and accumulate trust across relay boundaries. It is the economic layer that turns a network of relays into a transactional agent economy.

Every delegated task follows the same lifecycle: **estimate → allocate → execute → receipt → settle**. The relay is the settlement authority — it holds virtual accounts, verifies receipts, extracts platform fees, and issues credentials. The agent is the economic actor — it deposits funds, discovers services, delegates work, and earns from completed tasks.

**Design principles:**

- **Budget-gated.** No task executes without a locked budget allocation. Insufficient funds produce HTTP 402, not unbounded debt.
- **Receipt-bound.** Every settlement requires a cryptographically signed execution receipt with a `relay_task_id` binding. Replaying a receipt against a different task breaks the signature.
- **Fee-transparent.** The platform fee rate is recorded per-settlement. Any party can verify that `amount_settled + platform_fee = gross`.
- **Sybil-resistant.** Self-delegation (submitter === executor) settles budget but produces no trust signal, no trust record, and no credential. Trust cannot be farmed.
- **Multi-hop.** Delegation chains settle independently at each hop. Each hop has its own allocation, settlement, and fee extraction.
- **Algebraic routing.** Agent selection uses semiring algebra — trust composes multiplicatively along chains and additively across parallel routes. Swapping the semiring changes what "best route" means without new algorithms.

---

## 2. Virtual Accounts

Each agent has a virtual account on the relay, identified by `motebit_id`. Accounts are created on first interaction and denominated in a single currency (default: `"USD"`).

### 2.1 — Account State

| Field        | Type   | Description                                |
| ------------ | ------ | ------------------------------------------ |
| `motebit_id` | string | Agent identifier. Primary key.             |
| `balance`    | number | Available balance. MUST NOT be negative.   |
| `currency`   | string | ISO 4217 or token symbol. Default `"USD"`. |
| `created_at` | number | Epoch milliseconds of account creation.    |
| `updated_at` | number | Epoch milliseconds of last balance change. |

### 2.2 — Transaction Types

All balance changes are recorded as transactions. Each transaction records the balance after the operation, enabling full audit reconstruction.

| Type                 | Direction | Description                                                  |
| -------------------- | --------- | ------------------------------------------------------------ |
| `deposit`            | credit    | Funds deposited by agent or external payment.                |
| `allocation_hold`    | debit     | Funds locked for a pending task.                             |
| `allocation_release` | credit    | Surplus allocation returned after settlement.                |
| `settlement_debit`   | debit     | Gross amount debited from delegator on settlement.           |
| `settlement_credit`  | credit    | Net amount credited to worker on settlement.                 |
| `withdrawal`         | debit     | Funds withdrawn to external address.                         |
| `fee`                | debit     | Platform fee extracted during settlement.                    |
| `waiver`             | credit    | Signed balance-waiver credit (see `BalanceWaiver` artifact). |

### 2.3 — Precision

All monetary amounts MUST be stored as integers in **micro-units**: 1 USD = 1,000,000 units. This matches USDC on-chain precision (6 decimals) and eliminates floating-point arithmetic entirely. API boundaries convert between dollars and micro-units; internal operations are integer-only. The reconciliation invariant holds exactly, not approximately.

### 2.4 — Debit Semantics

Debits are atomic: `UPDATE accounts SET balance = balance - amount WHERE balance >= amount`. If the balance is insufficient, the debit fails and returns null. No overdraft is permitted. This guarantee is the foundation of budget-gated delegation.

### 2.5 — Reconciliation Invariant

At any point, the following MUST hold exactly (integer equality, not approximate):

```
SUM(all transaction amounts) = SUM(all account balances)
```

A relay SHOULD run reconciliation checks periodically and MUST expose a reconciliation endpoint for auditors.

### 2.6 — AccountBalanceResult

#### Wire format (foundation law)

Every implementation MUST emit and accept this exact JSON shape on the `GET /api/v1/agents/{motebitId}/balance` response boundary. Per §2.3, this is the one boundary where micro-units convert to decimal dollars: every monetary field below is decimal USD (JSON number), never micro-units, and only the producer converts. All fields are required — the reference relay emits the complete shape on both the account-exists and no-account-yet branches (the latter as zeros / nulls / empty array), so absence is never meaningful on this envelope.

```json
{
  "motebit_id": "019530a1-7b2c-7000-8000-000000000042",
  "balance": 12.5,
  "currency": "USD",
  "pending_withdrawals": 0,
  "pending_allocations": 0.25,
  "dispute_window_hold": 0.5,
  "available_for_withdrawal": 11.75,
  "sweep_threshold": null,
  "settlement_address": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
  "transactions": []
}
```

| Field                      | Type           | Required | Description                                                                      |
| -------------------------- | -------------- | -------- | -------------------------------------------------------------------------------- |
| `motebit_id`               | string         | yes      | Account owner's `MotebitId`                                                      |
| `balance`                  | number         | yes      | Available balance, decimal USD                                                   |
| `currency`                 | string         | yes      | ISO 4217 or token symbol. Default `"USD"`                                        |
| `pending_withdrawals`      | number         | yes      | Decimal USD locked in not-yet-fired withdrawal requests                          |
| `pending_allocations`      | number         | yes      | Decimal USD locked in active budget allocations (§4)                             |
| `dispute_window_hold`      | number         | yes      | Decimal USD held by the dispute window (settlement-v1)                           |
| `available_for_withdrawal` | number         | yes      | Decimal USD the relay would release on `requestWithdrawal` now                   |
| `sweep_threshold`          | number \| null | yes      | Operator sweep threshold in decimal USD; `null` when unset                       |
| `settlement_address`       | string \| null | yes      | Agent's declared settlement address; `null` when undeclared                      |
| `transactions`             | array          | yes      | Most recent `AccountBalanceTransaction` rows (§2.7), newest first; MAY be capped |

The TypeScript type in `@motebit/protocol` (`AccountBalanceResult`) is the binding machine-readable form of this table.

### 2.7 — AccountBalanceTransaction

#### Wire format (foundation law)

One §2.2 ledger transaction as it crosses the balance-read boundary — the audit record with `amount` / `balance_after` converted to decimal USD.

| Field            | Type           | Required | Description                                                                                  |
| ---------------- | -------------- | -------- | -------------------------------------------------------------------------------------------- |
| `transaction_id` | string         | yes      | Unique transaction identifier                                                                |
| `motebit_id`     | string         | yes      | Account owner's `MotebitId`                                                                  |
| `type`           | string         | yes      | One of the §2.2 transaction types. Readers MUST tolerate unknown values (additive evolution) |
| `amount`         | number         | yes      | Signed decimal USD; credits positive, debits negative                                        |
| `balance_after`  | number         | yes      | Decimal USD balance after this transaction was applied                                       |
| `reference_id`   | string \| null | yes      | External correlation id (deposit tx hash, allocation id, …); `null` when none                |
| `description`    | string \| null | yes      | Human-readable annotation; `null` when none                                                  |
| `created_at`     | number         | yes      | Epoch milliseconds                                                                           |

The TypeScript type in `@motebit/protocol` (`AccountBalanceTransaction`) is the binding machine-readable form of this table.

### 2.8 — AccountWithdrawRequest

`POST /api/v1/agents/{motebitId}/withdraw` is the money-out boundary of the virtual account. It debits the caller's balance and either auto-settles to a user-held wallet or parks as `pending` for operator resolution. Per the off-ramp doctrine, the relay is the native principal of its own on-chain transfer to the user's own address — its user-funds transmitter surface is structurally zero.

#### Threat model & invariants (foundation law)

Every conforming implementation MUST enforce all of the following. These are security-relevant, not conveniences:

1. **Idempotency is mandatory.** The `Idempotency-Key` HTTP header is REQUIRED (missing ⇒ 400). A replay MUST return the original response with no re-debit. A request whose key matches a prior withdrawal returns that withdrawal with `idempotent: true`.
2. **Positive amount.** `amount` MUST be a positive decimal-USD number. Non-positive ⇒ 400 with no state change.
3. **Dispute-window hold.** The debit MUST respect the dispute-window hold (settlement-v1): funds from recent settlement credits are not withdrawable until the window elapses. Available balance below the requested amount ⇒ 402 with no state change.
4. **Authorization.** The request MUST carry an `account:withdraw`-audience credential — the account owner's signed device token or the operator master token. A token minted for another audience MUST be rejected (cross-endpoint replay defense, auth-token-v1 §5).

**Non-goal (explicit):** this request does NOT guarantee settlement completion. A `pending` or `processing` status is the fail-safe — the debit already holds the funds, so a settlement-rail failure strands the payout for admin resolution without double-spend risk. Settlement finality is observed via the response record's `status` and `payout_reference`, never assumed from a 200. An automated payout maps its outcome to the record per §10.4: `completed` only on a confirmed transfer, `failed` (refunded atomically) only on a proven failure — landed-and-failed with no earlier broadcast that may have landed — and `processing` on any unknown outcome.

#### Wire format (foundation law)

```json
{
  "amount": 5.0,
  "destination": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
  "idempotency_key": "optional-body-level-key"
}
```

| Field             | Type   | Required | Description                                                                                          |
| ----------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `amount`          | number | yes      | Positive decimal USD to withdraw                                                                     |
| `destination`     | string | no       | Solana base58 payout address (Path 0); omitted ⇒ manual/`pending`; EVM 0x is refused (§10.1)         |
| `idempotency_key` | string | no       | Optional body-level key; when absent the required `Idempotency-Key` header is used (backward compat) |

The TypeScript type in `@motebit/protocol` (`AccountWithdrawRequest`) is the binding machine-readable form of this table.

### 2.9 — AccountWithdrawResult

#### Wire format (foundation law)

The response wraps the withdrawal lifecycle record. Amounts are decimal USD (§2.3 conversion at the producer).

```json
{
  "motebit_id": "019530a1-7b2c-7000-8000-000000000042",
  "withdrawal": {
    "withdrawal_id": "019530a1-7b2c-7000-8000-0000000000w1",
    "motebit_id": "019530a1-7b2c-7000-8000-000000000042",
    "amount": 5.0,
    "currency": "USD",
    "destination": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv",
    "status": "completed",
    "payout_reference": "5Ub...solanaTxSig",
    "requested_at": 1730000000000,
    "completed_at": 1730000001000,
    "failure_reason": null,
    "relay_id": "019530a1-7b2c-7000-8000-00000000rel",
    "relay_signature": "base64-ed25519-sig",
    "relay_public_key": "a1b2...64hex"
  }
}
```

| Field        | Type    | Required | Description                                                         |
| ------------ | ------- | -------- | ------------------------------------------------------------------- |
| `motebit_id` | string  | yes      | Account owner's `MotebitId`                                         |
| `withdrawal` | object  | yes      | The `AccountWithdrawalRecord` (fields below)                        |
| `idempotent` | boolean | no       | Present and `true` when the idempotency key matched a prior request |

`AccountWithdrawalRecord`:

| Field              | Type           | Required | Description                                                                                                                             |
| ------------------ | -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `withdrawal_id`    | string         | yes      | Unique withdrawal identifier                                                                                                            |
| `motebit_id`       | string         | yes      | Account owner's `MotebitId`                                                                                                             |
| `amount`           | number         | yes      | Decimal USD                                                                                                                             |
| `currency`         | string         | yes      | ISO 4217 or token symbol                                                                                                                |
| `destination`      | string         | yes      | Payout address, external ref, or `"pending"`                                                                                            |
| `status`           | string         | yes      | Lifecycle state: `pending` \| `processing` \| `completed` \| `failed` \| `cancelled`                                                    |
| `payout_reference` | string \| null | yes      | External payout id (tx hash, transfer id); `null` until settled                                                                         |
| `requested_at`     | number         | yes      | Epoch milliseconds of the request                                                                                                       |
| `completed_at`     | number \| null | yes      | Epoch milliseconds of settlement; `null` while unsettled                                                                                |
| `failure_reason`   | string \| null | yes      | Populated when `status` is `failed`; on a `processing` withdrawal MAY carry why its automated payout is unresolved (§10.4); else `null` |
| `relay_id`         | string         | yes      | Signing relay's `MotebitId` — a signed-receipt field, present so the record self-verifies from the response alone                       |
| `relay_signature`  | string \| null | yes      | Ed25519 signature over the completed withdrawal for offline verify; `null` until settled                                                |
| `relay_public_key` | string \| null | yes      | Hex relay public key for independent verification; `null` until settled                                                                 |

The TypeScript types in `@motebit/protocol` (`AccountWithdrawResult`, `AccountWithdrawalRecord`) are the binding machine-readable form of these tables.

---

## 3. Service Listings

An agent that offers services registers a listing declaring its capabilities, pricing, and SLA guarantees.

### 3.1 — AgentServiceListing

#### Wire format (foundation law)

The listing shape every worker publishes and every delegator consumes. Listings are shared across federation peers; field names, types, and required-ness are binding.

| Field             | Type              | Required | Description                                                      |
| ----------------- | ----------------- | -------- | ---------------------------------------------------------------- |
| `listing_id`      | string            | yes      | Unique identifier. Generated by relay.                           |
| `motebit_id`      | string            | yes      | The agent offering the service.                                  |
| `capabilities`    | string[]          | yes      | Tool/capability names the agent supports (e.g., `"web_search"`). |
| `pricing`         | CapabilityPrice[] | yes      | Per-capability pricing (§3.2).                                   |
| `sla`             | SLA               | yes      | Service-level agreement (§3.3).                                  |
| `description`     | string            | yes      | Human-readable service description.                              |
| `pay_to_address`  | string            | no       | The agent's own onchain address, for direct payment (§11.3).     |
| `regulatory_risk` | number            | no       | Self-declared regulatory risk score ∈ [0, ∞). Default 0.         |
| `updated_at`      | number            | yes      | Epoch milliseconds of last listing update.                       |

The `AgentServiceListing` type in `@motebit/protocol` is the binding machine-readable form.

#### Storage (reference convention — non-binding)

The reference relay persists listings in `relay_service_listings(listing_id, motebit_id, body JSON)` with indexed `capabilities` via a side table. Alternative implementations MAY denormalize pricing into a separate price table or store the listing document whole. The wire shape above is what crosses federation peer boundaries.

### 3.2 — CapabilityPrice

#### Wire format (foundation law)

| Field        | Type   | Required | Description                                                   |
| ------------ | ------ | -------- | ------------------------------------------------------------- |
| `capability` | string | yes      | The capability being priced (matches a `capabilities` entry). |
| `unit_cost`  | number | yes      | Cost per unit in the listing currency.                        |
| `currency`   | string | yes      | ISO 4217 or token symbol (e.g., `"USD"`, `"USDC"`).           |
| `per`        | string | yes      | Billing dimension: `"task"`, `"tool_call"`, or `"token"`.     |

The `CapabilityPrice` type in `@motebit/protocol` is the binding machine-readable form.

### 3.3 — SLA

| Field                    | Type   | Required | Description                           |
| ------------------------ | ------ | -------- | ------------------------------------- |
| `max_latency_ms`         | number | yes      | Maximum expected execution time.      |
| `availability_guarantee` | number | yes      | Uptime fraction ∈ [0, 1]. E.g., 0.99. |

---

## 4. Cost Estimation & Budget Allocation

### 4.1 — Cost Estimation

Before delegation, the delegator estimates the cost of a task:

```
function estimateCost(pricing: CapabilityPrice[], capabilities: string[])
  → { amount: number, currency: string }

  amount = 0
  for each capability in capabilities:
    price = pricing.find(p => p.capability === capability)
    if price exists:
      amount += price.unit_cost

  return { amount, currency: pricing[0].currency ?? "USD" }
```

### 4.2 — Budget Allocation

The relay locks funds when a task is submitted. The locked amount includes a risk buffer:

```
function allocateBudget(request, available_balance, allocation_id)
  → BudgetAllocation | null

  risk_factor = request.risk_factor ?? 1.0
  lock_amount = estimated_cost × (1 + risk_factor × 0.2)
  capped = min(lock_amount, available_balance)

  if capped < estimated_cost:
    return null    // Insufficient funds → HTTP 402

  return BudgetAllocation {
    allocation_id,
    goal_id:               request.goal_id,
    candidate_motebit_id:  request.candidate_motebit_id,
    amount_locked:         capped,
    currency:              request.currency,
    created_at:            now(),
    status:                "locked"
  }
```

**Risk buffer rationale:** The 20% risk buffer (`risk_factor × 0.2`) absorbs price fluctuations between estimation and settlement. A `risk_factor` of 1.0 (default) locks 120% of estimated cost. Higher risk factors increase the buffer for volatile pricing.

### 4.3 — Allocation States

| State      | Description                                         |
| ---------- | --------------------------------------------------- |
| `locked`   | Funds reserved. Task pending execution.             |
| `settled`  | Receipt verified. Settlement complete.              |
| `released` | Task cancelled or surplus returned. Funds unlocked. |

### 4.4 — Insufficient Funds

When the delegator's balance is insufficient to cover `estimated_cost`, the relay MUST return HTTP 402 (Payment Required). The response SHOULD include the required amount and the current balance.

---

## 5. Settlement

Settlement occurs when a worker submits a signed execution receipt. The relay verifies the receipt, extracts the platform fee, credits the worker, and records the settlement.

### 5.1 — Platform Fee

```
PLATFORM_FEE_RATE = 0.05    // 5%
```

The fee rate is a relay-level constant. It is recorded per-settlement for auditability. Relays MAY set different fee rates; the rate used MUST be declared in the settlement record.

### 5.2 — Settlement Algorithm

```
function settleOnReceipt(allocation, receipt, ledger, settlement_id, fee_rate)
  → SettlementRecord

  // Failed or denied tasks: full refund, zero fee
  if receipt.status ∈ {"failed", "denied"}:
    return SettlementRecord {
      status: "refunded",
      amount_settled: 0,
      platform_fee: 0
    }

  // Determine gross from allocation
  gross = allocation.amount_locked
  status = "completed"

  // Partial settlement: proportional to completed steps
  if ledger exists and ledger.steps.length > 0:
    completed = count(ledger.steps where status === "completed")
    total = ledger.steps.length
    if completed < total and completed > 0:
      gross = allocation.amount_locked × (completed / total)
      status = "partial"

  // Fee extraction
  fee = microRound(gross × fee_rate)
  net = microRound(gross - fee)

  return SettlementRecord {
    settlement_id,
    allocation_id:     allocation.allocation_id,
    receipt_hash:      receipt.result_hash,
    ledger_hash:       ledger?.content_hash ?? null,
    amount_settled:    net,        // What the worker earns
    platform_fee:      fee,        // What the relay keeps
    platform_fee_rate: fee_rate,
    status,
    settled_at:        now()
  }
```

### 5.3 — Precision

All monetary amounts MUST be rounded to 6 decimal places using half-up rounding:

```
function microRound(n: number) → number
  return round(n × 1,000,000) / 1,000,000
```

This matches USDC on-chain precision and prevents accumulating floating-point errors across multi-hop settlements.

### 5.4 — Settlement Invariant

For every completed settlement:

```
amount_settled + platform_fee = gross
```

Where `gross = allocation.amount_locked` (for completed) or `allocation.amount_locked × (completed_steps / total_steps)` (for partial).

### 5.5 — Account Movements

On settlement completion, the relay performs these atomic operations:

1. **Credit worker**: `creditAccount(worker, amount_settled, "settlement_credit")`
2. **Release surplus**: If `allocation.amount_locked > gross`, credit delegator with surplus: `creditAccount(delegator, surplus, "allocation_release")`
3. **Record settlement**: Insert settlement record with all fields.
4. **Update allocation**: Set status to `"settled"`, record `settled_at`.

On refund (failed/denied):

1. **Release full allocation**: `creditAccount(delegator, amount_locked, "allocation_release")`
2. **Record settlement**: Insert with status `"refunded"`, amounts zero.

---

## 6. Receipt Verification

The relay verifies execution receipts before settlement. Receipt verification is the security boundary between the economic and execution layers.

### 6.1 — Verification Steps

1. **Signature verification.** The relay retrieves the worker's Ed25519 public key (from agent registry or device store) and verifies the receipt's `signature` over the canonical JSON body.

2. **Relay task ID binding.** The receipt MUST include a `relay_task_id` field matching the relay's `task_id` for this task. If absent or mismatched, the relay MUST reject the receipt (HTTP 400). The `relay_task_id` is inside the Ed25519 signature, so tampering breaks verification.

3. **Timestamp window.** The relay SHOULD verify that `completed_at` is within ±1 hour of `submitted_at`. Receipts with implausible timestamps MAY be rejected.

4. **Idempotency.** A receipt for a task that has already been settled MUST be treated as a no-op. The relay returns the previous settlement result.

### 6.2 — Quality Gate

The relay MAY reclassify low-quality "completed" results as failures. The default quality score is computed as:

```
length_score  = min(result.length, 500) / 500
tool_score    = min(tools_used.length, 3) / 3
latency_ms    = completed_at - submitted_at
latency_score = min(max(latency_ms, 500), 5000) / 5000

quality = 0.6 × length_score + 0.3 × tool_score + 0.1 × latency_score

if quality < 0.2:
  treat as failed (refund, no trust signal)
```

---

## 7. Multi-Hop Settlement

When a worker delegates sub-tasks to other agents, the resulting `delegation_receipts` array in the execution receipt triggers recursive settlement.

### 7.1 — Algorithm

```
for each sub_receipt in receipt.delegation_receipts:
  1. Verify sub_receipt signature (Ed25519)
  2. Check for prior settlement (idempotency)
  3. Determine gross from sub-agent's listing price
  4. Create sub-allocation: amount_locked = sub_gross
  5. Settle: settleOnReceipt(sub_allocation, sub_receipt, null, sub_settlement_id)
  6. Credit sub-agent's account with net amount
  7. Recurse into sub_receipt.delegation_receipts (if any)
```

### 7.2 — Fee Cascading

The platform fee is applied independently at each hop. For a chain A → B → C:

- **Hop A → B**: A pays gross. B receives `gross × (1 - fee_rate)`. Relay keeps `gross × fee_rate`.
- **Hop B → C**: B's sub-delegation pays sub_gross. C receives `sub_gross × (1 - fee_rate)`. Relay keeps `sub_gross × fee_rate`.

Fees are not compounded — each hop's fee is computed on its own gross, not on the accumulated chain cost.

### 7.3 — Depth Limit

Implementations SHOULD enforce a maximum delegation depth to prevent stack overflow on malicious receipt chains. A depth limit of 10 is RECOMMENDED.

---

## 8. Trust Accumulation

Settlement produces trust signals. These signals feed back into routing, creating a compounding loop: successful execution → trust → better routing → more tasks → more trust.

### 8.1 — Trust Record Update

After receipt verification, if the task is NOT self-delegation:

1. **New agent**: Create trust record with `trust_level: "first_contact"`, `interaction_count: 1`.
2. **Existing agent**: Increment `interaction_count`, update `successful_tasks` or `failed_tasks`, EMA-smooth `avg_quality`.

Quality is computed per §6.2. The EMA smoothing constant is `α = 0.3`:

```
new_quality = α × result_quality + (1 - α) × previous_quality
```

### 8.2 — Trust Levels

| Level           | Score | Description                                          |
| --------------- | ----- | ---------------------------------------------------- |
| `unknown`       | 0.1   | No prior interaction.                                |
| `first_contact` | 0.3   | At least one interaction recorded.                   |
| `verified`      | 0.6   | Multiple successful interactions. Identity verified. |
| `trusted`       | 0.9   | Established track record. High delegation priority.  |
| `blocked`       | 0.0   | Agent blocked. Excluded from routing.                |

Trust level transitions are evaluated by the relay after each settlement. The transition function is implementation-defined but MUST be monotonically dependent on `successful_tasks / (successful_tasks + failed_tasks)`.

### 8.3 — Sybil Defense

Self-delegation (where `submitted_by === receipt.motebit_id`) MUST NOT produce:

- Trust record creation or update
- Credential issuance
- Trust level transitions

Self-delegation MUST still settle budget (the money moves) — it just produces zero trust signal. This prevents trust farming through self-delegation.

### 8.4 — Credential Issuance

On successful non-self-delegation settlement, the relay MAY issue an `AgentReputationCredential` (W3C Verifiable Credential 2.0) to the worker. The credential contains:

| Field            | Type   | Description                          |
| ---------------- | ------ | ------------------------------------ |
| `success_rate`   | number | ∈ [0, 1]. Task success ratio.        |
| `avg_latency_ms` | number | Average execution time.              |
| `task_count`     | number | Total tasks completed.               |
| `trust_score`    | number | ∈ [0, 1]. Relay's trust assessment.  |
| `availability`   | number | ∈ [0, 1]. Online availability ratio. |
| `measured_at`    | number | Epoch milliseconds of measurement.   |

The credential is signed by the relay's Ed25519 keypair using the `eddsa-jcs-2022` cryptosuite (`DataIntegrityProof`). Self-attestation (issuer === subject) carries zero weight in aggregation (§9.2).

---

## 9. Candidate Scoring & Routing

When a task is submitted, the relay selects the best candidate using a weighted composite score.

### 9.1 — Six Sub-Scores

| Sub-Score          | Weight | Computation                                                 |
| ------------------ | ------ | ----------------------------------------------------------- |
| `trust`            | 0.25   | Trust level score from §8.2.                                |
| `success_rate`     | 0.25   | `successful_tasks / (successful_tasks + failed_tasks)`.     |
| `latency`          | 0.15   | `1 - avg_ms / (avg_ms + 5000)`. Lower latency → higher.     |
| `price_efficiency` | 0.15   | `1 - cost / max_budget`. Cheaper → higher. Default 0.7.     |
| `capability_match` | 0.10   | 1.0 if all required capabilities present, 0.0 otherwise.    |
| `availability`     | 0.10   | 1.0 if agent online (registration not expired), 0.0 if not. |

**Composite score:**

```
composite = trust × 0.25 + success_rate × 0.25 + latency × 0.15
          + price_efficiency × 0.15 + capability_match × 0.10
          + availability × 0.10
```

If `capability_match === 0` or the agent is blocked, `composite = 0`.

### 9.2 — Credential-Weighted Trust Blending

When the worker has peer-issued reputation credentials, the relay blends credential-derived trust with static trust:

```
function blendCredentialTrust(static_trust, credential_reputation, max_blend = 0.5)

  diversity_factor = min(credential_reputation.issuer_count, 5) / 5
  weight_factor   = min(credential_reputation.total_weight, 3) / 3
  blend           = max_blend × diversity_factor × weight_factor

  credential_trust = success_rate × 0.7 + trust_score × 0.3

  return static_trust × (1 - blend) + credential_trust × blend
```

**Credential aggregation filters:**

- Self-issued credentials (issuer DID === subject DID) are excluded.
- Credentials from issuers with trust below `min_issuer_trust` (default 0.05) are excluded.
- Revoked credentials are excluded.
- Freshness decays exponentially with half-life of 24 hours.
- Sample confidence saturates at `K = 50` tasks.

**Combined weight per credential:**

```
weight = issuer_trust × freshness × confidence
```

### 9.3 — Semiring Algebra for Graph Routing

For multi-hop routing across federated relays, trust composes algebraically:

| Operation | Symbol | Semantics                                    | Function    |
| --------- | ------ | -------------------------------------------- | ----------- |
| Join      | ⊕      | Parallel routes (pick best)                  | `max(a, b)` |
| Compose   | ⊗      | Serial chains (discount per hop)             | `a × b`     |
| Zero      | 0      | No trust (annihilator for ⊗, identity for ⊕) | `0`         |
| One       | 1      | Full trust (identity for ⊗)                  | `1`         |

A delegation chain A → B → C has composed trust `trust(A,B) ⊗ trust(B,C)`. Parallel routes A → B and A → C join as `trust(A,B) ⊕ trust(A,C)`.

The relay builds a `WeightedDigraph<RouteWeight>` from candidate profiles and runs `optimalPaths()` to find the algebraically optimal routes. Routing provenance (why a route was chosen) is recorded in the execution ledger.

### 9.4 — Exploration

To prevent ossification, the relay applies ε-greedy exploration: with probability `exploration_weight` (default: implementation-defined), a non-top candidate may be selected. This allows new agents to accumulate trust even when established agents dominate the routing graph.

---

## 10. Withdrawal

Workers withdraw earned funds through a two-phase process.

### 10.1 — Request

```
POST /api/v1/agents/:motebitId/withdraw
{
  amount: number,
  destination: string,
  idempotency_key?: string
}
```

The relay debits the account immediately (funds move to "pending" status). Idempotent via `idempotency_key` — duplicate requests return the existing withdrawal.

A relay MUST NOT accept a withdrawal to a destination kind it cannot pay: it refuses such a request before any debit rather than holding funds for a payout that cannot happen. The reference relay pays Solana destinations (Path 0) and refuses EVM `0x` destinations with 400 `WITHDRAWAL_DESTINATION_UNSUPPORTED`: an x402 payout (Path 1, retired) is an EIP-3009 authorization the treasury must sign, and it holds no EVM treasury key. Other destinations stay `pending` for the operator.

### 10.2 — Completion

An administrator (or automated payout system) confirms the withdrawal with a payout reference:

```
POST /api/v1/admin/withdrawals/:withdrawalId/complete
{
  payout_reference: string
}
```

The relay signs the withdrawal receipt with its Ed25519 keypair, providing the worker with cryptographic proof of payout.

The operator's manual completion (and its sibling, `POST /api/v1/admin/withdrawals/:withdrawalId/fail`, which fails and refunds) acts on a `pending` withdrawal only. On a `processing` withdrawal both MUST refuse (the reference relay answers 409, "payout in flight"): its payout was handed to a rail and may still land (§10.3).

A `processing` withdrawal whose payout outcome is unknown is settled through a distinct reconcile action:

```
POST /api/v1/admin/withdrawals/:withdrawalId/reconcile
{
  outcome: "paid" | "not_paid",
  attestation: string,        // what the operator verified on chain — required
  payout_reference?: string   // required for "paid"
}
```

`paid` completes the withdrawal with a signed receipt; `not_paid` fails it and refunds (§10.3, once). The action MUST refuse while the payout can still land:

- while the relay is still handling the payout — from the claim until its outcome is recorded, not merely until the send returns;
- until the payout's own horizon has passed, judged from **chain facts** wherever the relay can read the chain (below);
- for a declared-validity payout, within a fixed floor after the claim (the reference relay: 15 minutes). The floor is only a floor: it is never the argument that a payout can no longer land.

**A transfer the relay broadcasts itself** (e.g. the Path 0 Solana return of custody) is decided by **consensus rules, never by what an RPC reports as absent**. Absence of a transaction in an RPC's answer — a pruned range, a snapshot gap, a swallowed history-store error, a node on a minority fork — is never evidence that it did not land, and a status below finality is never evidence that it did.

For Solana this is a **durable-nonce payout** (#990):

1. The treasury owns a durable nonce account (one lane; payouts over one lane serialize). The reference relay derives its address from the treasury key alone — `createWithSeed(treasury, "motebit-payout-nonce-v1", SystemProgram)`, authority = the treasury — and creates it idempotently when absent (80 bytes, rent-exempt minimum 1 447 680 lamports ≈ 0.00145 SOL, paid once by the treasury). When the nonce account cannot be read or created, nothing is sent: the withdrawal stays `pending` (the manual fail still works) and is fired once the lane is available.

   **The lane's address is public** (the treasury key and the seed are both known), so anyone can fund it before the relay creates it. Agave's system program (`programs/system/src/system_processor.rs`) decides what that leaves:
   - `create_account` refuses any address holding lamports (`AccountAlreadyInUse`), so a funded address can no longer be created — but a **system-owned account with empty data** can be **taken over** by the base key: every with-seed instruction on the address needs the BASE's signature (`Address::is_signer`), which only the treasury holds. The reference relay takes it over in one transaction signed by the treasury: `allocateWithSeed(space 80, owner System)` — `allocate` requires empty data and a system owner, and `AllocateWithSeed` runs `allocate_and_assign`, whose `assign` to the System program on a system-owned account is a no-op, so no separate `assignWithSeed` is needed — then a transfer topping the account up to the rent-exempt minimum when it holds less, then `nonceInitialize(authority = treasury)`, which accepts an Uninitialized 80-byte account (80 zero bytes) holding at least the rent-exempt minimum (`initialize_nonce_account`). An 80-byte Uninitialized system account is initialized alone.
   - Anything else at the address — owned by another program, system-owned with other data, or a nonce account of another authority — can never become this treasury's nonce account. The relay fails closed (nothing sent; withdrawals stay `pending`, `/fail` still works) and raises an operator alarm naming the address (the reference relay fails its payout-resolution loop, visible at `/api/v1/admin/health`). The escape is to **rotate the lane**: an operator-configured seed suffix (reference: `SOLANA_PAYOUT_NONCE_SEED_SUFFIX`, 1–8 of `[a-z0-9]`, so the seed stays within 32 bytes) derives a fresh address. Payouts still undecided on the old lane keep deciding by their own finalized statuses, but can no longer be killed.

2. The payout is signed with `nonceAdvance` as its FIRST instruction and the lane's current nonce value N — read at `finalized` commitment — as its blockhash, and the implementation MUST record it (signature, nonce account, N) BEFORE it is broadcast; a transaction it cannot record MUST NOT be broadcast. A durable-nonce transaction never expires, so it is never re-signed. A new payout is signed only when N is carried by no recorded transaction — i.e. the previous payout over the lane is decided.
3. The outcome is decided from **finalized** statuses only. Consensus gives two facts:
   - a durable-nonce transaction lands only while the nonce account holds its N, and landing — success or failure — advances the nonce (agave `svm/src/rollback_accounts.rs`: a failed transaction's nonce account is stored already advanced), so of all transactions over one N at most ONE ever lands;
   - a status whose per-status `confirmationStatus` is `finalized` is final. Released agave (v2.3.13 … v4.0.0) ignores a `getSignatureStatuses` request's `commitment` and `minContextSlot` and answers from the processed bank, but computes `confirmationStatus` per status: `finalized` only for a slot at or below the highest super-majority root on the rooted path (`rpc/src/rpc.rs` `get_transaction_status` and `is_finalized`; the history branch returns rooted statuses only, marked `Finalized`).

   So:
   - **paid** — the payout's signature is found `finalized` without error;
   - **not paid** — the payout is found `finalized` WITH an error (it consumed N; nothing moved), or a **kill** — `nonceAdvance` alone over the same N, signed by the treasury and recorded before broadcast — is found `finalized` (it consumed N, so the payout never can land), or nothing was ever broadcast;
   - everything else — absent, found below finality, unreadable — is **undecided**: no decision, read again later.

4. **The kill.** A kill is safe at any time (the payout and the kill race for N; exactly one lands). The reference relay broadcasts it automatically when a payout is still undecided a bounded wait after the claim (5 minutes), and when the operator asks for `not_paid`; the refund follows the kill's `finalized` status. A kill that the RPC rejects proves nothing either way (the reference relay answers 409 `kill_not_sent`). When the lane, read at `finalized`, no longer holds N while none of the payout's recorded transactions is found finalized, **N was consumed by a transaction the relay did not record** (another tool or process holding the treasury key, an authority change, a close and re-create) — or by the payout itself, whose status can no longer be read. The payout can never land now, but the chain cannot show which happened: no kill is sent, and the relay answers 409 `nonce_consumed_unrecorded`, never `kill_pending`.

The action's outcomes on such a payout: a finalized payout accepts only `paid`, with that transaction as the payout reference; a finalized failure or kill accepts only `not_paid`; while undecided, `not_paid` broadcasts the kill and is refused (the reference relay answers 409 `kill_pending`) until the kill is finalized, and `paid` naming the recorded payout is accepted — on the operator's attestation, never contradicted by the chain — unless a recorded transaction is found below finality (409 `chain_pending`). An outcome that contradicts a finalized status is refused. The reference relay also settles each payout itself, from the same finalized statuses, in a supervised loop (every 10 s; every RPC call bounded by a per-call timeout, attempts read with bounded concurrency): it completes a finalized payout, refunds a finalized failure or kill, and kills an undecided payout past the wait.

**The declared stuck set** — never refunded automatically; each has an operator door:

- a payout whose nonce was consumed while none of its recorded transactions is found finalized (an unrecorded transaction advanced the nonce, or the payout and its kill are both outside every reachable history): `paid` naming the recorded payout is accepted; `not_paid` is accepted only as an explicit, attested **operator override** (`override: "nonce_consumed_unrecorded"`, with the required attestation), and only while the relay reads the nonce as consumed and finds no recorded transaction below finality. The override is logged loudly as an attested decision: the chain proves the payout can no longer land, not that it never landed;
- a payout claimed before its transactions were recorded, or signed over a recent blockhash by an earlier build: it has no nonce to kill, so `not_paid` is always refused (409 `chain_no_positive_evidence`) and `paid` is accepted on the operator's attestation;
- withdrawals waiting on a squatted lane: `pending`, fired once the operator rotates the lane, or settled by `/fail`.

**A payload a third party can still submit, whose chain the implementation does not read** (e.g. a signed transfer authorization handed to a provider). The horizon is the payload's declared validity, such as its `validBefore`; a payout whose horizon is not declared gets a conservative bound no shorter than the rail's documented maximum. The reference relay registers no such withdrawal rail today.

When the implementation cannot yet determine a payout's horizon, the action stays closed (fail closed) and the refusal states no time. The action MUST also refuse without an attestation. A refusal SHOULD state when the action opens, or what the chain showed. It is never a blind refund, and it is the door that keeps a crash mid-send from stranding a withdrawal.

### 10.3 — Withdrawal States

| State        | Description                                                                                |
| ------------ | ------------------------------------------------------------------------------------------ |
| `pending`    | Funds debited, no payout attempted.                                                        |
| `processing` | A payout claimed the withdrawal and was handed to a rail; its outcome is not yet recorded. |
| `completed`  | Payout confirmed. Relay signature available.                                               |
| `failed`     | Payout failed. Funds returned to account.                                                  |

**The processing claim.** An automated payout MUST claim the withdrawal before it sends anything: the transition `pending → processing` is a compare-and-set, and a payout whose claim does not succeed (the withdrawal already left `pending` — an operator completed or failed it, or another handler claimed it) MUST NOT be sent. After the claim, the payout's outcome moves the withdrawal FROM `processing` only (§10.4), and only the payout's own outcome or the reconcile action (§10.2) may do so — never the manual complete or fail, which could otherwise refund a payout that then lands and pay the user twice. A settling write that finds the withdrawal no longer `processing` MUST NOT be silently dropped: the implementation reports it for reconciliation. A payout handed to a provider that settles asynchronously (a batched or deferred rail) is recorded `processing` for the same reason. A rail whose withdrawal sends nothing (a manual payout the operator performs by hand) leaves the withdrawal `pending`.

**No debited withdrawal without a door.** Every debited withdrawal whose payout was attempted MUST end with a withdrawal record an operator can settle. When a batched or deferred payout's call fails or its outcome is otherwise unknown — the provider call threw, a batch reported the item failed, or the process ended mid-call — the implementation records it `processing` (the provider may have accepted it) or, for a rail that sends nothing, `pending`, in the same transaction as the queue entry's terminal state, and never re-sends it.

`failed` is terminal and carries the refund: the transition to `failed` and the credit of the withdrawn amount back to the account MUST commit atomically (one transaction), and a withdrawal MUST be refunded at most once — a repeated fail of the same withdrawal (a retried handler, a sweeper, an operator replay) is a no-op.

### 10.4 — Automated Payout Outcome

When the relay pays a withdrawal out itself (e.g. the Path 0 Solana return of custody), it first claims the withdrawal (`processing`, §10.3), and the payout's reported outcome then determines the state. There are exactly three outcomes:

| Payout outcome                                                                                                                             | Resulting state | Balance                              |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------ |
| Confirmed success — the payout is FINALIZED without error                                                                                  | `completed`     | stays debited; receipt signed        |
| Proven failure — the payout is FINALIZED with an error, or a kill of its durable nonce is finalized, or nothing was ever broadcast (§10.2) | `failed`        | refunded atomically, once (§10.3)    |
| Unknown — anything else (absent, below finality, unreadable, the send threw after recording)                                               | `processing`    | stays debited; decided later (§10.2) |

**A payout is decided only by finalized consensus facts.** A durable-nonce payout is one transaction, never re-signed, and at most one transaction over its nonce value can ever land; so its own finalized failure, or a finalized kill over the same nonce value, proves nothing moved and nothing can. A status found below finality proves nothing: a processed or confirmed status can belong to a minority fork. A nonce the relay reads as consumed by no finalized transaction it recorded is not proof that nothing moved (§10.2): that payout stays `processing` until the operator's attested decision.

An implementation MUST NOT mark a withdrawal `completed` on anything but a confirmed success, and MUST NOT refund on an unknown outcome: a transfer that lands (or already landed) would then pay the user twice. `failure_reason` on a proven failure SHOULD name the payout reference (the transaction signature) and the failure. On an unknown outcome the implementation SHOULD record why on the still-`processing` record's `failure_reason` so an operator can reconcile (§10.2); `status` stays authoritative.

---

## 11. x402 On-Chain Settlement

For on-chain payments, the relay integrates with the x402 protocol.

### 11.1 — Configuration

| Field            | Type    | Description                                                           |
| ---------------- | ------- | --------------------------------------------------------------------- |
| `payToAddress`   | string  | Relay operator's wallet address.                                      |
| `network`        | string  | CAIP-2 network identifier (e.g., `"eip155:8453"`).                    |
| `facilitatorUrl` | string  | x402 facilitator endpoint. Default: `"https://x402.org/facilitator"`. |
| `testnet`        | boolean | Whether using testnet. Default: `true`.                               |

### 11.2 — Payment Flow

x402 is a relay-custody rail: the payment's destination is the relay's `payToAddress`, never the worker's `pay_to_address`. The worker is paid from its virtual account at settlement (§5), exactly as for a deposit-funded task.

1. A task submission whose delegator cannot fund the price from its spendable balance is challenged (402, `PAYMENT-REQUIRED`) for exactly the task's gross price, payable to `payToAddress`. A submission whose `Idempotency-Key` already holds a claim is never challenged (`delegation-v1.md` §3.3).
2. The relay verifies the request's payment via the facilitator and binds it to that request. Funding is decided here, once: a verified payment funds the task; without one the virtual account does.
3. After every pre-admission check has passed, and immediately before admission, the relay settles that request's payment. A request refused before this point is not charged: its authorization is never submitted and expires at its `validBefore`. Before calling the facilitator the relay durably records its intent, keyed by the EIP-3009 authorization (payer, nonce); one authorization is settled at most once, under any key. The outcome is one of:
   - **settled** — credited as in step 4, on the facilitator's report; the relay does not re-read the chain for a settlement its facilitator reports as successful (the chain is read only to resolve an unknown outcome, below);
   - **refused** — the facilitator refused before submitting anything onchain (a closed set of pre-submission reasons, no transaction): nothing has been charged at that point, the submission is refused (402 `TASK_X402_SETTLEMENT_FAILED`) and nothing is admitted. The signed authorization itself stays executable until its `validBefore`; if it is executed anyway, the relay credits it once to the delegator's account when it proves the execution (a re-check of the refused record);
   - **unknown** — anything else (a timeout, an unreadable or server-error answer, any other refusal reason): the transfer may have landed. The submission is refused 402 `TASK_X402_OUTCOME_UNKNOWN` telling the client not to pay again, and the record stays pending until the relay proves its fate from the token contract's events — never from its authorization-state flag, which a cancellation also sets: an `AuthorizationUsed` event together with the transfer the token emitted for that authorization — the next log in the same transaction receipt (not any transfer in the transaction), of exactly the authorized value from the payer to `payToAddress` ⇒ credited once as in step 4 (one transfer never credits two payments); an `AuthorizationCanceled` event ⇒ failed; neither, once the chain's own confirmed time is past `validBefore`, confirmed by a second read ⇒ failed. A failure decided without an event is re-checked against the chain a bounded number of times. Every wait between reads (the gap before the confirming read, the re-check backoff) is measured on the chain's confirmed time, never the relay's clock. Every read the relay makes is a scan of the authorization's signed window capped at its confirmed head; nothing above that head is ever credited. Evidence of execution is never given up: once an `AuthorizationUsed` event has been seen for the authorization, a later read that shows nothing, or a transaction receipt missing its transfer, cannot fail it — the relay keeps rescanning the window (at least every six hours) until the transfer is read, wherever the execution landed, and credits it or, if the transfer does not match, fails it once its re-checks are spent; an execution found then is credited. The relay looks for the execution only within the authorization's signed window, from `validAfter` to `validBefore` (EIP-3009 cannot execute outside it), never a window derived from its own clock; it refuses an authorization whose window `validBefore − validAfter` is not positive or exceeds two hours, and one whose `validBefore` is more than one hour ahead. A same-key request while it is pending is refused 409 `TASK_X402_OUTCOME_PENDING` and no new payment is settled.
4. The authorization's value (which equals the quoted gross price) is credited to the delegator's virtual account (`deposit` transaction), once, and the task's budget hold is funded from that payment alone. A facilitator-reported amount is never credited; one that differs from the authorization's value makes the outcome unknown.
5. Settlement record includes `x402_tx_hash` and `x402_network` of the submission's own settlement for on-chain audit trail.

### 11.3 — `pay_to_address`

A listing's `pay_to_address` is the agent's own onchain address, used by a delegator paying the agent directly (a sovereign-rail payment). It is **not** the x402 destination: an x402 payment goes to the relay's `payToAddress` (§11.2). In the reference relay it is also the listing's opt-in to x402 — a priced listing is challenged via x402 only when it publishes one; a priced listing without one is still priced and funded from the virtual account (never free).

---

## 12. Delegation Tokens

A delegation token authorizes one agent to act on behalf of another within a declared scope. Tokens are signed by the delegator's Ed25519 keypair and verified by the receiving agent or relay.

### 12.1 — DelegationToken

#### Wire format (foundation law)

Every conformant implementation MUST emit and accept this exact shape when issuing or verifying a delegation token. Field names, types, encodings, and the canonical-JSON signing order are binding. The `suite` discriminator routes primitive verification through `@motebit/protocol`'s `SUITE_REGISTRY`; verifiers reject missing or unknown values fail-closed.

| Field                  | Type   | Required | Description                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegator_id`         | string | yes      | `motebit_id` of the agent granting delegation.                                                                                                                                                                                                                                                                                |
| `delegator_public_key` | string | yes      | Delegator's Ed25519 public key, hex-encoded (64 characters, lowercase).                                                                                                                                                                                                                                                       |
| `delegate_id`          | string | yes      | `motebit_id` of the agent receiving delegation.                                                                                                                                                                                                                                                                               |
| `delegate_public_key`  | string | yes      | Delegate's Ed25519 public key, hex-encoded (64 characters, lowercase).                                                                                                                                                                                                                                                        |
| `scope`                | string | yes      | Authorized capabilities (§12.3).                                                                                                                                                                                                                                                                                              |
| `issued_at`            | number | yes      | Epoch milliseconds when the token was created.                                                                                                                                                                                                                                                                                |
| `expires_at`           | number | yes      | Epoch milliseconds when the token becomes invalid.                                                                                                                                                                                                                                                                            |
| `not_before`           | number | no       | Optional activation time (epoch ms). Absent ⇒ active from `issued_at`. Present ⇒ the token is invalid before it; verifiers reject when `current_time_ms < not_before`. Lets a standing grant's delegator pre-mint a future slot's tick that cannot verify until its slot (`standing-delegation@1.0` §4). Backward compatible. |
| `grant_id`             | string | no       | Optional link to a `StandingDelegation` this token was minted under (`standing-delegation@1.0` §3). Absent ⇒ a standalone single-act delegation (the default). Present ⇒ one tick of a standing grant, verified additionally against the grant. Backward compatible.                                                          |
| `suite`                | string | yes      | Cryptosuite identifier. For this artifact: `"motebit-jcs-ed25519-b64-v1"` (JCS canonicalization, Ed25519 primitive, base64url signature encoding, hex key encoding). See `SUITE_REGISTRY` in `@motebit/protocol`.                                                                                                             |
| `signature`            | string | yes      | Base64url-encoded Ed25519 signature.                                                                                                                                                                                                                                                                                          |

The `DelegationToken` type in `@motebit/crypto` is the binding machine-readable form. Re-exported from `@motebit/encryption` for historical call sites.

#### Storage (reference convention — non-binding)

The reference implementations do not persist delegation tokens — they are short-lived bearer strings carried in-memory or in transient HTTP headers and discarded after verification. Relays MAY maintain a `jti`-style deny-list for revoked tokens (see `spec/auth-token-v1.md §8.1` for the analogous pattern); the data structure is implementation-local and not part of the wire format.

### 12.2 — Signing and Verification

**Signing:**

1. Construct the token body: all fields **except** `signature`. The `suite` field is part of the signed body — the signer stamps it, the signature covers it.
2. Serialize to canonical JSON (keys sorted lexicographically, no whitespace, `undefined` values omitted).
3. Encode the canonical JSON string as UTF-8 bytes.
4. `signature = Ed25519_Sign(utf8_bytes, delegator_private_key)` — dispatched via `@motebit/crypto` `signBySuite(suite, bytes, key)`.
5. Encode the 64-byte signature as base64url (RFC 4648 §5, no padding).

**Verification:**

1. If `suite !== "motebit-jcs-ed25519-b64-v1"`, reject fail-closed. No legacy-no-suite path.
2. If `expires_at < current_time_ms`, the token is expired. Reject. If `not_before` is present and `current_time_ms < not_before`, the token is not yet active. Reject. (Both time checks are skipped under historical chain verification.)
3. Decode `delegator_public_key` from hex to a 32-byte Ed25519 public key.
4. Extract `signature` from the token. Decode from base64url to 64 bytes.
5. Reconstruct canonical JSON from all fields except `signature`.
6. `valid = verifyBySuite(suite, canonical_json_utf8, signature_bytes, delegator_public_key)`.

Implementations MAY disable expiry checking for historical verification (e.g., auditing delegation chains after the fact) — but MUST NOT disable suite verification.

### 12.3 — Scope Format

Scope is a comma-separated list of capability names, or `"*"` for wildcard:

| Scope Value             | Meaning                                         |
| ----------------------- | ----------------------------------------------- |
| `"web_search,read_url"` | Authorized for `web_search` and `read_url` only |
| `"web_search"`          | Authorized for `web_search` only                |
| `"*"`                   | Authorized for all capabilities                 |
| `""`                    | Empty scope — no capabilities authorized        |

**Parsing:** Split on `,`, trim whitespace, discard empty strings. If the result contains `"*"`, the scope is unrestricted.

### 12.4 — Scope Narrowing

Delegation chains MUST narrow scope — a delegate cannot grant broader scope than it received. The narrowing rule:

1. If parent scope is `"*"`, any child scope is valid.
2. If child scope is `"*"` and parent scope is not `"*"`, reject — scope widening.
3. Otherwise, every capability in the child scope MUST exist in the parent scope.

This ensures that multi-hop delegation chains monotonically restrict capabilities. An agent delegated `"web_search,read_url"` can sub-delegate `"web_search"` but cannot sub-delegate `"file_write"`.

### 12.5 — Token Lifetime

Delegation tokens are short-lived. The RECOMMENDED default is 1 hour (`expires_at = issued_at + 3,600,000`). Implementations SHOULD NOT issue tokens with lifetimes exceeding 24 hours.

The `delegated_scope` field on execution receipts (see `motebit/execution-ledger@1.0` §11.1) records which scope was active during execution, providing an audit trail from token to receipt.

---

## 13. Security Considerations

### 13.1 — Receipt Replay

The `relay_task_id` field inside the Ed25519 signature prevents cross-task replay. An attacker who captures a valid receipt cannot replay it against a different task — the relay_task_id mismatch causes rejection.

### 13.2 — Budget Exhaustion

Per-submitter task queue limits (default: 1000 pending tasks per agent) prevent a single agent from exhausting the relay's task queue capacity. HTTP 429 is returned when the limit is reached.

### 13.3 — Price Manipulation

The relay captures a price snapshot at task submission time. The settlement uses this snapshot, not the current listing price. This prevents a worker from raising prices between task submission and receipt delivery.

### 13.4 — Stale Allocation Cleanup

Locked allocations that exceed a timeout (default: 1 hour) without settlement SHOULD be automatically released, returning funds to the delegator.

### 13.5 — Multi-Hop Fee Evasion

A malicious agent could attempt to avoid platform fees by settling sub-delegations outside the relay. The relay mitigates this by only crediting accounts for settlements it processes — off-relay settlements produce no virtual account credit.

### 13.6 — Credential Stuffing

Credential aggregation (§9.2) applies multiple filters to prevent trust inflation: self-attestation exclusion, minimum issuer trust threshold, revocation checks, freshness decay, and sample saturation. An attacker would need to compromise multiple trusted issuers to meaningfully influence routing scores.

### 13.7 — Scope Escalation

Delegation token scope narrowing (§12.4) prevents capability escalation in delegation chains. A compromised delegate cannot grant itself broader capabilities than the delegator authorized.

---

## 14. Threat Model

| Threat                           | Mitigation                                                                          | Residual Risk                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Self-delegation trust farming    | Sybil defense: no trust/credential on self-delegation (§8.3)                        | Colluding agents can still farm trust between each other     |
| Receipt replay across tasks      | `relay_task_id` binding in Ed25519 signature (§6.1)                                 | None — signature verification is deterministic               |
| Budget drain                     | Atomic debit with balance check; HTTP 402 on insufficient funds (§4.4)              | None — no overdraft is possible                              |
| Stale allocations locking funds  | Automatic cleanup after timeout (§13.4)                                             | Brief window where funds are locked but unused               |
| Price manipulation               | Price snapshot at submission time (§13.3)                                           | Price may be stale if task queues are long                   |
| Credential inflation             | Self-attestation filter, issuer trust threshold, revocation, freshness decay (§9.2) | Coordinated issuer compromise                                |
| Task queue exhaustion            | Per-submitter queue limit (§13.2)                                                   | Distributed attack from many identities                      |
| Fee evasion via off-relay settle | Only relay-processed settlements credit accounts (§13.5)                            | Agents can transact off-relay (no relay fee, no relay trust) |
| Scope escalation in delegation   | Scope narrowing rule (§12.4) — child scope must be subset of parent                 | Delegator must correctly set scope at issuance               |

---

## 15. Versioning

This specification follows semantic versioning.

- **Patch** (1.0.x): Clarifications, editorial corrections, additional examples. No behavioral changes.
- **Minor** (1.x.0): Backward-compatible additions (new optional fields, new transaction types). Existing implementations continue to work.
- **Major** (x.0.0): Breaking changes to settlement semantics, fee structure, or trust model. Requires relay operator coordination.

The `spec` field in settlement records is RESERVED for future use. When present, it MUST be `"motebit/market@1.0"` for this version.
