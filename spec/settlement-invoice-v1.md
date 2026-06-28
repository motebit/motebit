# motebit/settlement-invoice@1.0

**Status:** converged (agency.computer forcing-consumer review, 2026-06-28 — shape accepted wholesale; three catches + two notes folded). Pending the gated-surface build (the two mandated digest helpers + protocol types + `@motebit/crypto` sign/verify + `@motebit/verifier` re-export + wire-schemas).

## 1. Purpose

The execution-receipt family proves _what an agent did_. This spec extends that chain **to the money**: a verifiable bill a customer re-derives offline. It is the format half of a deliberate split — motebit owns the **format** (an offline-verifiable settlement artifact), the issuer runs the **rails** (Stripe, etc.). motebit never holds, charges, or moves funds; there is no balance, ledger, or settlement primitive here, by construction (`docs/doctrine/clearing-house-not-thin-waist.md`, `docs/doctrine/off-ramp-as-user-action.md` — the out-flow transmitter surface is structurally zero).

Two artifacts, sequenced:

- **`CostAttestation`** — an issuer-signed declaration of _the cost of one execution_, in integer nano-USD against a named rate table, referencing an `ExecutionReceipt` by id and digest. The thing that is summed.
- **`Invoice`** — an issuer-signed _demand for payment_: a flat fee per signed outcome plus passthrough compute, the latter bounded by the summed `CostAttestation` costs, re-derivable and refusable offline.

## 2. Design Principles

1. **Format, not rails.** No money moves through motebit. The artifact is a verifiable statement; the rail is the issuer's.
2. **The chain extends to the money.** Each line binds to an `ExecutionReceipt` by digest; the bill is a derivation over already-signed figures, not a fresh assertion.
3. **Cost is a declaration, not a proof.** A `CostAttestation` claims "this is what we computed, by these declared rates" — a _different kind_ of claim than the receipt's "this work happened." It is therefore a **separate** artifact, never a field welded onto the immutable execution proof. This keeps the rate table on its own version clock and gives an honest correction path (§3.3 supersession) without re-signing the execution receipt.
4. **The bill rounds against the issuer, both directions** (§5). The meter rounds nano→cents _up_; the bill-cap rounds nano→minor _down_. Both toward the customer. Foundation law, not an implementation detail.
5. **Digests are reproducible by construction.** Every binding digest is computed by a **mandated exported helper**, used by producer and verifier alike — never a per-consumer prose recipe (§6). A digest covers the **full signed artifact, `signature` included** (the digest commits to the signature too).
6. **Statefulness stays with the issuer.** Idempotency (a receipt billed at most once) is enforced in the issuer's stateful ledger. The artifact carries the references that make double-billing _detectable_; it never carries or enforces uniqueness state.
7. **Offline-verifiable under `@motebit/verifier`**, no new trust root: issuer-signed under the existing suite, verified against the issuer's registered key. Verifiers return a **structured verdict** (per-axis), never a naked boolean — so "valid against the cited cost" and "stale vs the latest cost" (§4.2.7) are distinguishable.

## 3. CostAttestation

### 3.1 — CostAttestationV1

#### Wire format (foundation law)

The signed cost declaration. Field names, types, and the canonical-JSON signing order are binding.

```
schema:               "motebit.cost-attestation.v1"
attestation_id:       string   // UUIDv7. Unique per attestation (a supersession is a NEW id, §3.3).
receipt_id:           string   // the ExecutionReceipt's task_id this prices (human/index handle).
receipt_digest:       DigestRef // { algorithm, value } = `executionReceiptDigest(receipt)` over the full
                                //   signed ExecutionReceipt. Binds the cost to the EXACT receipt.
cost_nanos:           integer  // the cost, in integer nano-USD (1 USD = 1_000_000_000 nano). > 0.
rate_table_id:        string   // the versioned rate table the cost was computed under (e.g. "agency-rates-v1").
covers:               string   // issuer-owned label for what the cost accounts for (rate-table basis).
                                //   Opaque to motebit; motebit owns the field, the issuer owns the value.
issuer_id:            string   // the issuer's motebit_id / did.
issuer_public_key?:   string   // Ed25519 public key, hex (64 lowercase). OPTIONAL (TOFU convenience);
                                //   the trust move is verifying against the issuer's REGISTERED key.
attested_at:          number   // ms epoch. MUST be >= the receipt's completed_at (§3.1 axis 5) — a cost
                                //   cannot be attested before the work it prices finished.
suite:                "motebit-jcs-ed25519-b64-v1"
signature:            string   // base64url Ed25519 over the JCS canonicalization of all fields above.
```

#### Verification (foundation law)

A verifier MUST reject a `CostAttestation` unless ALL hold (`@motebit/crypto` `verifyCostAttestation` → structured verdict):

1. `suite` is the registered suite; `signature` verifies over the JCS body under that suite.
2. The signing key is the issuer's **registered** key. If `issuer_public_key` is present it MUST equal the registered key — a carried key is never trusted standalone.
3. `cost_nanos` is a positive safe integer.
4. **Binding (when the receipt is supplied):** `receipt_digest` equals `executionReceiptDigest(receipt)` of the presented `ExecutionReceipt`, and that receipt's issuer matches `issuer_id`. The receipt has no `schema` tag, so type-substitution is held by digest collision-resistance + structural resolution (the verifier resolves it _as_ an `ExecutionReceipt`); the schema-tag belt is carried by the §4.2.4 CostAttestation bind, which _is_ schema-tagged. Without the receipt, this axis is `unchecked`, never `valid`.
5. **Temporal commitment (when the receipt is supplied and `completed_at` is non-null):** `attested_at >= receipt.completed_at`. This is what makes the anti-retro-inflation property _law_ and not prose — a cost stamped before the work finished is rejected. Holds for supersessions (a correction is still after execution).

### 3.3 — Supersession (foundation law)

A rate found wrong is corrected by issuing a **new** `CostAttestation` (new `attestation_id`, later `attested_at`) against the same `receipt_id` + `receipt_digest`. The immutable `ExecutionReceipt` is never re-signed. A consumer reconciling costs for a receipt MUST take the latest-`attested_at` non-superseded attestation from a given issuer.

Two directions, two protections:

- **Issuer-discipline (the cited bind, §4.2.4):** an invoice is pinned by digest to the attestation it _cites_, so the issuer cannot silently follow an _uncited raise_.
- **Customer-protection (the latest check, §4.2.7):** if the cited attestation is later superseded _downward_ (the customer was overcharged), the bill still verifies against the cite — so the latest non-superseded cost is a separate, **detectable** verdict axis. Whether a downward correction forces re-issue is consumer policy; _silence_ is not an option.

## 4. Invoice

### 4.1 — InvoiceV1

#### Wire format (foundation law)

The signed demand for payment. Amounts are in **minor units** (cents) of `currency` — the rail-native unit, the issuer's deliberate choice (the artifact is 1:1 with the charge). Cost references carry nano-USD to preserve the precise passthrough law.

```
schema:                 "motebit.invoice.v1"
invoice_id:             string   // UUIDv7. The bill's idempotency anchor.
issuer_id:              string
issuer_public_key?:     string   // hex, optional; verify against the registered key.
customer_ref:           string   // opaque issuer-owned addressing token. NOT PII.
currency:               "USD"
period_start:           number   // ms epoch, inclusive.
period_end:             number   // ms epoch, exclusive.
line_items:             LineItem[]
flat_fee_minor:         integer  // the per-outcome flat fee, in minor units. >= 0.
passthrough_cost_minor: integer  // passthrough compute, in minor units. >= 0. Bounded by §4.2 laws 3,4,7.
total_minor:            integer  // flat_fee_minor + passthrough_cost_minor. The verifier recomputes.
rate_table_id:          string   // the rate table the passthrough was costed under.
issued_at:              number   // ms epoch.
suite:                  "motebit-jcs-ed25519-b64-v1"
signature:              string   // base64url Ed25519 over the JCS body.

LineItem:
  receipt_id:               string    // the billed ExecutionReceipt's task_id.
  receipt_digest:           DigestRef // = executionReceiptDigest(receipt). Binds the line to the exact receipt.
  cost_nanos:               integer   // the passthrough cost for this line, nano-USD. >= 0.
  cost_attestation_digest:  DigestRef // = costAttestationDigest(att). Binds the line to the CostAttestation (§3).
```

#### Verification (foundation law)

`@motebit/crypto` `verifyInvoice` → structured verdict (per-axis). Always-checkable axes MUST hold; supplied-evidence axes are `unchecked` (never `valid`) when their inputs are absent:

1. **Signature** — verifies over the JCS body under `suite`, against the issuer's **registered** key (carried `issuer_public_key`, if present, MUST match it).
2. **Arithmetic** (always) — `total_minor == flat_fee_minor + passthrough_cost_minor`; all amounts are non-negative safe integers.
3. **Passthrough cap** (always) — `passthrough_cost_minor <= floor( Σ line_items.cost_nanos / 1e7 )`. Overstatement ⇒ `valid: false`; understatement is a legitimate discount, allowed (`≤`, not `==`). See §5 for `1e7` and the floor.
4. **Per-line cost binding** (when CostAttestations are supplied) — for each line, the artifact resolved via `cost_attestation_digest` recomputes to that digest under `costAttestationDigest`, **has `schema == "motebit.cost-attestation.v1"`** (the substitution belt), verifies (§3.1), prices the same `receipt_id`/`receipt_digest`, and `line.cost_nanos <= attestation.cost_nanos`. A line above its cited attestation ⇒ `valid: false`.
5. **Issuer consistency** (when receipts/attestations are supplied) — every referenced `ExecutionReceipt` and `CostAttestation` has the same issuer as `invoice.issuer_id`. **You can only bill for outcomes you produced.** (Same equality discipline as the seed-escrow `identity_pubkey_check`.) Single-issuer in v1.
6. **Idempotency (detectable, not enforced)** — a `receipt_id` across two _held_ invoices is surfaced. Uniqueness is enforced in the issuer's stateful ledger, never in the artifact.
7. **Stale-cost overstatement (detectable; the §3.3 customer-protection direction)** — when a _later, non-superseded_ `CostAttestation` for a billed `receipt_id` is supplied, surface `passthrough_cost_minor > floor( Σ latest cost_nanos / 1e7 )` as the distinct `stale_cost_overstatement` axis. **Detectable, not necessarily `valid: false`** (whether a downward correction forces re-issue is consumer policy) — but never silent.

## 5. The rounding symmetry (foundation law)

Costs are carried in **nano-USD** (`cost_nanos`, 1e9/USD — fine enough for per-token cost); the bill is in **minor** (cents, 1e2/USD — the rail unit). `1 minor = 1e7 nanos`. motebit's canonical internal money unit is micro-USD (1e6) — **this law does not round through it**; the only crossing is `nano → minor` directly, so no consumer should infer a phantom round-through-micro step.

Two conversions, both biased **against the issuer**:

- **Meter → cost (producer-side).** The issuer renders an internal nano cost into chargeable cents by rounding **up**: the issuer's producer invariant is `receipt_cents == ceil(cost_nanos / 1e7)` — a solvency bias, never in the issuer's favor. (agency.computer's meter already does exactly this; the invariant ties the attested cents to the CostAttestation nanos so they can never drift.)
- **Bill-cap → passthrough (verifier-side).** The invoice's passthrough cap is `floor( Σ cost_nanos / 1e7 )` — rounds **down**, so the bill can never overstate the customer by a rounding crumb.

Meter up, bill-cap down: both round toward the customer. A consumer MUST NOT invert either direction.

## 6. Conventions

- **Signing:** JCS canonicalization → SHA-256 → Ed25519, suite `motebit-jcs-ed25519-b64-v1`; `signature` base64url; the `suite` tag is in the signed body (in-body domain separation). Same as the receipt family.
- **Digests (mandated helpers).** Bindings use exported helpers, never a prose recipe — producer and verifier call the _same_ function so the link is reproducible by construction (the `consolidationReceiptDigest` discipline). `@motebit/crypto` exports **`executionReceiptDigest(receipt)`** and **`costAttestationDigest(att)`**, each `canonicalSha256(artifact)` over the **full signed artifact** (`signature` included — the digest commits to the signature too). `DigestRef = { algorithm, value }` (`@motebit/protocol`, `evidence-provenance.ts`); `value` is lowercase hex.
- **Keys:** issuer keys hex (64 lowercase). The trust move is verification against the issuer's registered key; carried keys are convenience only.
- **Money:** integer units, zero floating point. `cost_nanos` nano-USD; invoice amounts minor (cents). The `nano → minor` conversion is the only unit crossing in the law (§5).

## 7. Relationship to Other Specs & Non-Goals

- **`spec/execution-ledger-v1.md`** — the `ExecutionReceipt` this chains to. Cost is NOT on that receipt (it carries only relative `price_efficiency`); the absolute figure is this spec's `CostAttestation`, by design (§2.3).
- **`docs/doctrine/receipts-unified.md`** — this is the settlement-layer member of the receipt family (JCS + Ed25519 + suite-dispatch + `@motebit/verifier`).
- **Orthogonal to the relay's settlement vocabulary — say it so no consumer conflates them.** `@motebit/crypto` already ships `SettlementRecord` / `signSettlement` (Merkle-batched, anchored — the relay's _inter-relay / onchain-anchor_ settlement layer) and `signSovereignPaymentReceipt` (a _sovereign payment_ receipt). Those are the relay's own money path. `Invoice` / `CostAttestation` are the **issuer↔customer bill** — a different layer; they sit beside `SettlementRecord`, never inside it.
- **Non-goals (deferred-with-trigger):**
  - A **paid-confirmation** artifact (proof the rails _settled_ — retrospective). NOT defined here, and when it lands it will **reuse / align with `SovereignPaymentReceipt`, not mint a third settlement dialect** (and not be named "SettlementReceipt" — that collides with `SettlementRecord`). Trigger: a consumer needs a verifiable receipt-of-payment.
  - Multi-issuer / delegated-issuer billing — out of scope until a consumer has the chain.
  - motebit defines no charge, balance, or ledger primitive — ever (§2.1).
