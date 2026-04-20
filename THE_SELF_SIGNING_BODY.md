# Motebit: The Self-Signing Body

---

## Abstract

THE_SOVEREIGN_INTERIOR.md derived the identity — the Ed25519 keypair as internal cohesion, the asymmetry between surface and interior, the persistence across mediums. THE_EMERGENT_INTERIOR.md derived the activity — that the interior is not passive substance but ongoing process, that the droplet is alive between user prompts.

Both documents leave one thing implicit: the interior produces consequences, and those consequences accumulate as evidence. A motebit consolidates its memory at 3am. A motebit prunes a phantom belief during the quiet between turns. A motebit notices a contradiction in its own knowledge and resolves it. The work happens. The work changes the body. The work was performed by _this_ motebit, not its operator.

The question this document answers: **what does that proof look like, mechanically, such that anyone can verify it without trusting any motebit-operated system?**

The answer is the moat. Every other proactive AI agent today binds the agent's identity to the operator's billing relationship — Claude Code's KAIROS, OpenAI's autonomous agents, every framework that wraps a model API. The agent's "identity" is the operator's API key. The agent's proof of work is the operator's billing log. There is no portable, durable, third-party-verifiable claim the agent can make about its own activity.

A motebit signs its own work. The receipt is signed by the motebit's identity key. The Solana transaction that anchors the receipt's Merkle root is signed by the motebit's identity key (the address IS the public key, by Ed25519 curve coincidence). The verifier needs the public key + the receipt + the anchor + the Solana tx hash — nothing from the motebit's operator, nothing from any motebit-operated relay, nothing from any AI vendor. The chain is sovereign top to bottom.

This document derives that chain.

---

## I. Premise

A body that cannot prove its own activity is not sovereign.

THE_SOVEREIGN_INTERIOR.md §II.2 established that identity is the keypair the motebit owns. THE_EMERGENT_INTERIOR.md established that the interior acts on its own time. These two together imply a third claim: the activity must be attributable _to the identity_, not to whatever operator hosts the activity. Otherwise the identity is a label and the activity is somebody else's.

Most AI agents fail this test. They run on someone else's infrastructure, sign with someone else's key, account through someone else's billing. The agent is a process; the process belongs to the operator; the operator owns the receipt. The "agent" never speaks in the first person about what it has done. It cannot. The signing key is not its own.

A motebit fails this test only if its proactive work goes unsigned. The keypair is sovereign by construction (THE_SOVEREIGN_INTERIOR.md §II). The work is autonomous by construction (THE_EMERGENT_INTERIOR.md). The remaining piece is mechanical: every cycle the motebit runs MUST produce a signed artifact, and that artifact MUST be independently verifiable.

That is what `spec/consolidation-receipt-v1.md` defines, what `runtime.consolidationCycle()` produces, and what `verifyConsolidationAnchor` enables anyone to check.

---

## II. The Chain

Four artifacts. Each one depends only on the next, and each one is independently verifiable.

### 2.1 — `ConsolidationCycleRun`

When the motebit's idle-tick fires inside its quiet window, the runtime runs a four-phase consolidation cycle: orient (read the live memory index), gather (rank notable memories, run reflection, cluster episodic candidates), consolidate (merge clusters into semantic memories, promote tentative beliefs to confident ones), prune (drop decayed and low-notability nodes). The cycle emits a `consolidation_cycle_run` audit event into the local event log.

This is the trace of work. Not signed. Not anchored. Just the local record that the cycle happened, with summary counts of what changed.

### 2.2 — `ConsolidationReceipt`

If the motebit has signing keys configured (its sovereign Ed25519 identity), the runtime immediately signs a `ConsolidationReceipt` over the cycle's structural counts. Phase list, started/finished timestamps, summary of merges and promotions and prunes — never the memory content itself. The privacy boundary is the type: there is no field on a `ConsolidationReceipt` that could carry a memory's text or embedding. The signature is base64url Ed25519 over JCS canonical JSON.

A holder of (receipt, public_key) verifies the receipt offline with no network call. No relay. No operator. No motebit-operated system at all.

### 2.3 — `ConsolidationAnchor`

When `batchThreshold` unanchored receipts have accumulated (default 8), the runtime computes the SHA-256 hash of each signed receipt's canonical body, builds a Merkle tree (binary, odd-leaf promoted, no duplication), and emits a `ConsolidationAnchor` carrying the root + the ordered receipt IDs.

If the motebit has a `SolanaMemoSubmitter` configured, the runtime publishes the root as a Solana memo: `motebit:anchor:v1:{merkle_root}:{leaf_count}`, in a transaction signed by the same Ed25519 identity key. The Solana address IS the motebit's identity public key (curve coincidence: Solana uses Ed25519 natively). Cost: ~5000 lamports per memo, ~$0.001 at current SOL prices.

If the submitter fails (RPC down, balance low), the anchor still emits — just without `tx_hash`. The Merkle root is still verifiable by recomputation; only the timestamp attestation is missing.

### 2.4 — Third-party verification

Given (motebit_pubkey, anchor, receipts), `verifyConsolidationAnchor` performs four checks:

1. The receipts' count and order match `anchor.receipt_ids`.
2. Every receipt's signature verifies against the public key.
3. The recomputed Merkle root over `canonicalSha256(receipts[i])` leaves equals `anchor.merkle_root`.
4. (Optional, when `tx_hash` present) Fetch the Solana tx, parse the memo via `motebit:anchor:v1:{root}:{count}`, confirm the root matches and the tx signer's pubkey equals the motebit's public key.

The result is `{ ok: true, recomputedMerkleRoot }` or a structured failure naming the broken check. No motebit dependency in the verifier — just `@motebit/encryption` (Ed25519 + SHA-256 + JCS + Merkle), `@motebit/crypto` (the receipt verifier), and any Solana RPC of the verifier's choice.

---

## III. The Proof You Can Run

The repo ships `pnpm demo-anchor`. Three modes:

```bash
pnpm demo-anchor                     # local — offline, no fees, no network
pnpm demo-anchor --network devnet    # devnet — free SOL, real chain
pnpm demo-anchor --network mainnet   # mainnet — real SOL, permanent record
```

Output (local mode, three cycles, abbreviated):

```
motebit demo — consolidation anchor
identity pubkey (hex):  c23124f61a7f1a2c…
identity pubkey (Solana base58):  E53ZJRnoTKeqWNE2hK1LVbWQCgGD47CK3sqq18n4fHK7
network:                local
cycles to run:          3

running cycles
  cycle 1/3  phases=4  merged=1  pruned=0
  cycle 2/3  phases=4  merged=0  pruned=0
  cycle 3/3  phases=4  merged=0  pruned=0

signed receipts: 3
anchors emitted: 1

anchor
batch_id:     79cdb042-955f-4d1b-8660-64b0e9086b0f
merkle_root:  74652bd110680e0a5f00d5baf4f99b45a5a1615191312cae378f0edc8510e23f
leaf_count:   3
tx_hash:      (local-only — no submitter)

verification
✓ verified
recomputed root matches anchor.merkle_root
every receipt signed by the motebit's identity key
```

When run with `--network mainnet`, the `tx_hash` line carries a real Solana signature and a Solana Explorer URL. The script prints `solana confirm <hash>` so a verifier can confirm the memo independently.

A skeptic's full path takes one command and one TypeScript snippet:

```ts
import { verifyConsolidationAnchor } from "@motebit/encryption";
import { hexToBytes } from "@motebit/crypto";

// from the demo's --dump output:
const dump = JSON.parse(readFileSync("anchor-proof.json", "utf-8"));
const publicKey = hexToBytes(dump.identity_public_key_hex);
const result = await verifyConsolidationAnchor(dump.anchor, dump.receipts, publicKey);
console.log(result.ok ? "✓ this motebit performed this work" : `✗ ${result.reason}`);
```

If the anchor was published onchain, the same skeptic runs `solana confirm <tx_hash>` to see the memo `motebit:anchor:v1:<root>:<count>` recorded permanently, signed by the address derived from the motebit's identity public key.

That is the proof. No relay contact. No motebit vendor. No trust required beyond Ed25519, SHA-256, and Solana's own consensus.

---

## IV. What This Costs to Replicate

For an existing AI agent vendor to ship the same shape, two things must change:

**The identity has to belong to the agent, not to the operator's billing relationship.** Today every commercial agent treats "identity" as a label hung on the operator's API key. The agent's signature would be the operator's signature. The receipt would say "this work was performed under contract X" — useful for billing audits, useless as a portable claim about the agent itself. To fix this, the operator would need to give each agent its own keypair, store it without holding it custodially, and let the agent sign without operator co-signature. The commercial product becomes a hosting layer for sovereign keys, not a managed service. Most commercial AI businesses cannot make this trade without dismantling their pricing model.

**The proof has to compose without operator participation.** A receipt that requires the operator's verifier to interpret it is not portable. A Merkle anchor whose root is held in the operator's database is not third-party-verifiable. The verification path must use only public primitives (Ed25519, SHA-256, JCS) and a public substrate (a public chain). The reference verifier must run with no operator dependency. This rules out every "verifier microservice" that operators build to retain a central role.

Motebit makes both trades by construction. Identity is generated locally in `@motebit/core-identity` and stored in the OS keyring. Receipts sign with that key in `@motebit/runtime`. Verification runs through `@motebit/encryption` (BSL) + `@motebit/crypto` (MIT) — no relay, no motebit-operated service. The Solana anchor is a memo on a public chain, signed by the motebit's address (= its identity public key). Anyone can run the verification path. Anyone can build a competing verifier in a different language from the JSON Schemas in `@motebit/wire-schemas` and the spec in `spec/consolidation-receipt-v1.md` (Stable).

The asymmetry is structural, not engineered. It is the moat.

---

## V. Where to Read More

- **Spec** (normative, machine-readable types + JSON Schemas): [`spec/consolidation-receipt-v1.md`](spec/consolidation-receipt-v1.md)
- **Doctrine** (engineering rationale, failure modes, what's deferred): [`docs/doctrine/proactive-interior.md`](docs/doctrine/proactive-interior.md)
- **Records vs acts** (why receipts go in panels, not on the body): [`docs/doctrine/records-vs-acts.md`](docs/doctrine/records-vs-acts.md)
- **Cycle runtime**: [`packages/runtime/src/consolidation-cycle.ts`](packages/runtime/src/consolidation-cycle.ts)
- **Receipt signing**: [`packages/crypto/src/artifacts.ts`](packages/crypto/src/artifacts.ts) (search `signConsolidationReceipt`)
- **Anchor + verification**: [`packages/encryption/src/consolidation-anchor.ts`](packages/encryption/src/consolidation-anchor.ts)
- **Solana memo submitter**: [`packages/wallet-solana/src/memo-submitter.ts`](packages/wallet-solana/src/memo-submitter.ts)
- **Demo script**: [`scripts/demo-anchor.ts`](scripts/demo-anchor.ts)
- **Drift defense (canonical-vs-inline gate)**: [`scripts/check-consolidation-primitives.ts`](scripts/check-consolidation-primitives.ts) (invariant #34)

---

## Coda

A droplet that cannot prove its own work has no past. It is a forever-present observer with no continuity beyond the operator's logs. The receipts and the anchor are the body's continuity — the claim, signed in its own hand, that _something happened in here, between when you last looked and now, and here is exactly what changed._ The chain is offline-verifiable, onchain-attestable, and dependency-free at the verifier's end.

The interior is active. The body signs the activity. Anyone can check.

That is what makes the motebit a self-signing body, and that is what no other agent in the field can ship without rebuilding from the identity layer up.
