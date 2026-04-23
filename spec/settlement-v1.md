# motebit/settlement@1.0

## Settlement Specification

**Status:** Stable
**Version:** 1.0
**Date:** 2026-04-08

---

## 1. Overview

A settlement is the movement of value between motebits — or between a motebit and an external counterparty — in exchange for a completed service, a delivered artifact, or a resource grant. This specification defines how settlements happen at the protocol layer, independently of any particular relay implementation, chain, wallet topology, or custody model.

The motebit protocol separates **rails** (how value physically moves) from **receipts** (the cryptographically signed record of what moved, why, and between whom). Rails are plural; receipts are singular. Any rail is valid as long as the receipt it produces satisfies the foundation law in §3.

This is the first motebit protocol spec where the operational test — _can a third party stand up a competing implementation today using only the published specs and the permissive-floor type packages (Apache-2.0), without permission?_ — passes without any relay dependency.

**Design principles:**

- **Rails are plural, receipts are singular.** The protocol does not prescribe any specific rail. It prescribes the invariants that every settlement must satisfy and the format every receipt must take.
- **Sovereignty is the floor.** Every motebit MUST have access to at least one settlement path that does not require authorization, mediation, or cooperation from any centralized relay.
- **Relay mediation is a convenience, not a requirement.** A relay MAY mediate settlement for orchestration, escrow, fee extraction, or convenience. A relay MUST NOT be required for settlement validity.
- **Identity binds the signature. The wallet is a data field.** Receipts are signed by the motebit's identity Ed25519 key. The wallet address and transaction hash appear _inside_ the signed payload as referenced data, but the wallet is not the signing authority. This decoupling is what lets every alternative wallet topology (multisig, hardware, other chains) coexist under the same protocol.

---

## 2. Scope and Non-Scope

**In scope:**

- The foundation law that every settlement implementation must satisfy (§3)
- The settlement map — how value flows through a motebit's economic life (§4)
- The rail taxonomy that classifies settlement shapes (§5)
- The default reference implementation using the Ed25519/Solana curve coincidence (§6)
- The sovereign payment receipt format (§7)
- Compatible alternative implementations (§8)
- Multi-hop coordination patterns (§9)
- The security model and recommended mitigations for high-value motebits (§10)

**Not in scope:**

- Which rail a specific motebit chooses at runtime (implementation concern)
- The fee structure of any particular relay or onchain program (commercial concern)
- The UX for on-ramps and off-ramps (surface concern)
- Discovery of counterparties (covered by a future `motebit/discovery` spec)
- Trust aggregation across counterparties (covered by `motebit/trust` spec, future)

---

## 3. Foundation Law of Settlement

Every conforming settlement implementation MUST satisfy the following five invariants. These are the load-bearing invariants; everything else in this spec is either a reference implementation (non-normative) or a recommended mitigation (also non-normative). An implementation that satisfies §3 is protocol-conformant regardless of which chain, rail, wallet topology, or coordination primitive it uses.

### §3.1 Sovereignty Invariant

> **Every motebit MUST be able to initiate settlement on at least one path that does not require authorization, mediation, or cooperation from any centralized relay.**

**Conformance test:** Given a motebit with valid identity and sufficient value in the implementation's chosen rail, and no network access to any specific relay operator, can the motebit still send value to a counterparty who is willing to receive it, and produce a valid receipt of the transfer? If yes, §3.1 is satisfied. If no, the implementation has leaked a relay dependency into settlement validity.

### §3.2 Self-Verifiable Receipt Invariant

> **Every settlement event MUST produce a receipt containing sufficient public cryptographic proof to verify — without contacting any relay, registry, or third party other than the public ledger the rail itself uses — that:**
>
> - **a specific identity authorized the movement,**
> - **a specific amount moved,**
> - **a specific counterparty received it,**
> - **the movement has reached a defined finality state.**

**Conformance test:** Given only the receipt, the public ledger the rail uses (if any), and standard cryptographic primitives, can an unaffiliated third party verify the claim? If yes, the receipt is conformant. If the receipt cannot be verified without contacting a relay or registry, it fails §3.2 and the settlement is not protocol-valid even if it "worked" operationally.

### §3.3 Identity-Signature Binding Invariant

> **Receipts are signed by the motebit's identity key. The wallet address and transaction reference appear inside the signed payload as data fields, not as the signing authority. An implementation MUST NOT require that the signing key and the wallet key be the same key.**

**Rationale:** This is the structural decoupling that preserves plural rails. When the identity signs the receipt and the wallet is referenced as data, the implementation is free to choose any wallet topology — single-key, multisig, hardware-backed, separate identity/wallet keys — without breaking the receipt format or the verification logic. The default reference implementation (§6) happens to use the _same_ key for identity and wallet because of the Ed25519/Solana curve coincidence, but this is an implementation convenience, not a protocol requirement.

**Conformance test:** Can an implementation with separate identity and wallet keys produce a protocol-valid receipt? If yes, §3.3 holds. If the receipt format requires identity and wallet to be the same key, §3.3 fails and the protocol has smuggled wallet topology into law.

### §3.4 Relay-Optionality Invariant

> **A relay MAY mediate settlement for convenience (orchestration, escrow, fee extraction, multi-hop coordination, dispute resolution, trust aggregation, multi-device sync). A relay MUST NOT be required for settlement validity. A receipt produced without any relay participation MUST be as protocol-valid as one produced with a relay in the loop.**

**Conformance test:** Strip every relay from the system. Does the sovereign settlement path still produce valid receipts? If yes, §3.4 holds. If no, the implementation has leaked a relay dependency into the law layer.

### §3.5 Plural Rails, Singular Receipt Invariant

> **Implementations MAY support any number of settlement rails simultaneously (sovereign onchain wallet rails, HTTP-native payment protocols, third-party processors, orchestration bridges, managed virtual ledgers, future rails yet to exist). The rail choice is an implementation concern, local to each motebit and selected per-transaction. The receipt format is protocol law — every rail must produce receipts that satisfy §3.2.**

**Conformance test:** Can two different rails (e.g., a Solana wallet transfer and an x402 HTTP settlement) both produce receipts that verify using the same logic? If yes, §3.5 holds.

---

## 4. The Settlement Map

A motebit's economic life, at a glance:

```
            User
             │
       ┌─────┴─────┐
       ▼           ▲
    on-ramp    off-ramp
  (fiat→USDC) (USDC→fiat)
       │           │
       ▼           │
  ┌─────────────────────┐
  │                     │
  │   MOTEBIT WALLET    │   ← Ed25519 identity public key
  │                     │     is a valid chain address on
  │  (economic body)    │     Ed25519-native chains, by
  │                     │     mathematical accident of
  │                     │     curve choice (§6)
  └──┬───────────────┬──┘
     │               │
     ▼               ▼
  Motebits      Other rails
  (direct       (x402, MPP,
   sovereign    Bridge, …
   rail)        via adapter
                boundary)
```

**Reading the map:**

- The **user lives at the edges**. They fund the motebit via an on-ramp (fiat → USDC) and withdraw value via an off-ramp (USDC → fiat). Between the edges, the motebit lives its economic life.
- The **wallet is the economic body**. It is the source of outbound payments, the destination of inbound earnings, the counterparty in trades, and the source of operational spending (inference, tools, services). The same wallet serves all of these roles.
- **Motebit-to-motebit payments use the sovereign rail** by default. Direct wallet-to-wallet transfers on the shared chain. No relay required, no processor required, no protocol negotiation required.
- **Motebit-to-external payments route through an adapter boundary.** If the counterparty accepts a different rail (x402 for HTTP-native endpoints, MPP for Stripe-accepting services, Bridge for fiat, direct USDC for other wallets, future rails), the motebit's rail registry picks the appropriate adapter and converts the payment into the counterparty's expected wire format.

**What the map deliberately does not show:**

- **The relay.** The relay is not required for the settlement path and therefore not part of the map. A motebit that never contacts a relay still settles. The relay appears only when a motebit _chooses_ to use its services (orchestration, discovery, trust aggregation, multi-device sync, managed convenience tier).
- **Specific chains or tokens.** The map is chain-agnostic. "MOTEBIT WALLET" is whatever wallet the implementation chooses, on whatever chain it chooses, holding whatever asset it chooses.
- **Wallet topology.** Single-key, multisig, hardware-backed, or separate-identity-and-wallet — the map shows only "the wallet" as a logical entity.

---

## 5. Rail Taxonomy

Settlement rails are classified by _how value physically moves_, not by vendor:

| Category               | Definition                                                                                             | Value custody                                              | Examples                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Wallet rail**        | The motebit holds the signing key; value moves as a direct transfer on a shared ledger                 | Self-custody                                               | Solana wallet-to-wallet, future Aptos/Sui, any Ed25519-native chain, EVM wallets with appropriate adapters |
| **Protocol rail**      | HTTP-native payment choreography; the motebit signs a payment authorization that a facilitator settles | Self-custody (the motebit's wallet is the source of funds) | x402, AP2                                                                                                  |
| **Processor rail**     | A third party custodies funds and moves them on the motebit's behalf based on authorized instructions  | Third-party custody                                        | Stripe MPP, card networks, managed virtual ledgers                                                         |
| **Orchestration rail** | Cross-rail or cross-currency conversion; handles fiat↔crypto, one chain↔another, fiat↔fiat routing     | Third-party custody during conversion                      | Bridge, onramp services                                                                                    |

**Implementation notes:**

- A single motebit MAY support multiple rails simultaneously. Rail selection is per-transaction, based on the counterparty's preference.
- Wallet rails are the only category that satisfies §3.1 (sovereignty invariant) by themselves. The other three categories involve third parties at some point in the value movement and can be _optional enrichments_ on top of the sovereign floor, but cannot _replace_ it.
- A motebit with only a processor rail (e.g., only a Stripe customer record) is not protocol-conformant unless it also has access to a wallet rail. The foundation law requires the sovereign floor.

---

## 6. Default Reference Implementation

> **⚠️ The following section describes a specific implementation convention, not a protocol requirement. It is the default used by motebit's canonical reference stack because it is the lowest-ceremony way to satisfy §3.1 (sovereignty invariant) on Ed25519-native chains. Implementations MAY choose any other approach that satisfies §3.**

### 6.1 The Ed25519 / Solana curve coincidence

Motebit's identity layer uses Ed25519 for cryptographic sovereignty reasons (speed, determinism, small signatures, modern curve). Solana — along with Aptos, Sui, and other chains — also uses Ed25519 for its account model. Solana addresses are defined as the base58 encoding of an Ed25519 public key.

**Consequence:** At the moment a motebit generates its Ed25519 identity keypair, its identity public key is _already_ a valid Solana address. No wallet creation step happens. No second key is generated. No binding ceremony is performed. The address exists by mathematical accident of curve choice.

```
identitySeed (32 bytes, generated at bootstrap)
       │
       ▼
Ed25519 keypair (privateKey, publicKey)
       │
       ├──► signs identity assertions, receipts, credentials, federation
       │
       └──► publicKey, base58-encoded, is a valid Solana address
            (via Keypair.fromSeed from @solana/web3.js)
```

The Solana address is "empty" at birth: zero SOL, zero SPL token accounts. Funding it requires sending value to the address (from an on-ramp, from another motebit, from a direct crypto deposit). Once funded, the motebit can send SPL token transfers using its identity Ed25519 key as the signer.

The reference implementation of this rail lives in `@motebit/wallet-solana`, which wraps `@solana/web3.js` and `@solana/spl-token` behind a minimal `SolanaRpcAdapter` interface. The rail is entirely optional — a motebit that uses a different rail is still protocol-conformant — but this implementation is the canonical path and the one that ships in the motebit reference stack.

### 6.2 Why this is convention, not law

The curve coincidence is elegant and makes the sovereignty floor essentially free: every motebit gets a wallet at birth with zero new primitives, zero vendor dependencies, zero ceremony. But the foundation law does not require this. The same foundation law is satisfied by:

- Hardware-backed storage of the same identity key (identity and wallet still the same key, but protected by hardware)
- Multisig wallets at the Solana program level (the identity key is _one_ signer of _N_; the wallet is a separate Solana account)
- Separate identity and wallet keys linked by a signed binding attestation (e.g., EVM support where the motebit's Ed25519 identity cannot directly sign secp256k1 transactions)
- A completely different Ed25519-native chain (Aptos, Sui, or a future chain) using the same curve coincidence
- A post-quantum replacement for Ed25519 with its own wallet model

All of these are protocol-conformant. The curve coincidence is the cleanest default, not the only valid path.

---

## 7. Sovereign Payment Receipt Format

When a motebit makes a direct payment via the sovereign rail (e.g., Solana wallet-to-wallet), the payee signs a `SovereignPaymentReceipt` structurally equivalent to an `ExecutionReceipt` from `motebit/execution-ledger@1.0`, with the following field conventions.

#### Wire format (foundation law)

Every sovereign-rail implementation MUST emit a receipt that matches this shape. The `SovereignPaymentReceipt` is not a new type — it is an `ExecutionReceipt` whose `task_id` anchors to an onchain transaction (§3.3) and whose `relay_task_id` is absent (§3.4). Any party with the public ledger the rail uses can verify the receipt with no relay contact (§3.2).

| Field                           | Value                                               | Notes                                                                |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `task_id`                       | `{rail}:tx:{txHash}`                                | Anchors the receipt to a specific, globally unique onchain proof     |
| `motebit_id`                    | payee's motebit ID                                  | The party signing this receipt                                       |
| `public_key`                    | payee's Ed25519 public key (hex)                    | Embedded for portable verification without any registry lookup       |
| `device_id`                     | payee's device ID                                   | Provenance                                                           |
| `submitted_at` / `completed_at` | unix milliseconds                                   | Temporal binding                                                     |
| `status`                        | `"completed"`                                       | Sovereign payments succeed atomically or not at all                  |
| `result`                        | service description + payer + amount + asset + rail | Human-readable record                                                |
| `prompt_hash` / `result_hash`   | SHA-256                                             | Request/result integrity                                             |
| `tools_used`                    | array                                               | Tools the payee used to render the service                           |
| `memories_formed`               | 0                                                   | Typically                                                            |
| `relay_task_id`                 | **undefined**                                       | Sovereign rail — no relay binding                                    |
| `suite`                         | `"motebit-jcs-ed25519-b64-v1"`                      | Cryptosuite identifier (see `SUITE_REGISTRY` in `@motebit/protocol`) |
| `signature`                     | Ed25519 signature over canonical JSON               | Signed by the payee's identity key                                   |

The reference helper lives in `@motebit/crypto` as `signSovereignPaymentReceipt`. Verification uses the standard `verifyExecutionReceipt` function against the embedded `public_key`. No relay lookup is required at any step.

**The critical structural fact:** the receipt is signed by the _identity key_ (§3.3). The `task_id` references the wallet transaction as a data field. An implementation where identity and wallet keys are different (multisig, hardware, separate keys with binding) produces a structurally identical receipt — the signature is still made by the identity key, the wallet transaction is still referenced as data.

The `ExecutionReceipt` type in `@motebit/protocol` is the binding machine-readable form for sovereign payment receipts; see `execution-ledger-v1.md §11.1` for the full field set.

#### Storage (reference convention — non-binding)

The reference stack persists sovereign payment receipts in each motebit's local execution ledger (event store), not in any relay database — there is no relay in the sovereign path. Apps MAY keep a separate "sovereign payments" index for UX; that index is a local convenience, not part of the wire format. The onchain transaction at `task_id`'s hash is the permanent record every party can independently verify.

---

## 8. Compatible Implementations

The foundation law explicitly permits any settlement implementation that satisfies §3. The following are all protocol-conformant. Future implementations SHOULD be added to this list.

### 8.1 Default — Ed25519 identity = Solana wallet

Described in §6. The canonical reference implementation. One key, minimal ceremony, low-value default.

### 8.2 Multisig treasury at the Solana account layer

The motebit identity remains one Ed25519 key. The identity key serves as the "hot operational wallet" for small daily transactions. A _separate_ Solana account is configured as a multisig (via Squads, SPL Token multisig, or a custom Solana program). The multisig requires N-of-M signatures to spend. The identity key is one signer; user-controlled keys (hardware wallet, recovery service, other devices) are the other signers.

This is the recommended mitigation for high-value motebits (§10). Critically, this is _not_ the rejected "Two Keys, One Soul" pattern because:

- The identity layer is unchanged. Still one Ed25519 key.
- The multisig is a Solana _program_ concern, not an identity concern.
- It's opt-in per motebit.
- It uses native Solana primitives; no vendor dependency.

Protocol-conformant under §3 because the identity key still signs receipts, the treasury is still self-custodial, and the sovereign floor is preserved.

### 8.3 Hardware-backed identity storage

The Ed25519 private key lives in hardware (Secure Enclave, TPM, YubiKey via WebAuthn, Ledger). The key never leaves hardware. Signing happens via the hardware authenticator. The wallet address is still derived from the identity public key (same as §6), but the attack surface is dramatically reduced because the raw private key cannot be extracted by software compromise.

Protocol-conformant. Highly recommended for any motebit holding meaningful value.

### 8.4 Separate identity and wallet keys with binding attestation

Some chains (EVM chains like Ethereum, Base, Arbitrum) do not support Ed25519 signatures. A motebit that wants to operate on such chains uses a separate wallet key (secp256k1) bound to the identity Ed25519 key via a signed binding attestation: the identity key signs a statement of the form _"the motebit identified by {motebit_id} owns the wallet at {address} on chain {chain_id}, public key {pubkey}, created at {timestamp}"_.

The receipt is still signed by the identity Ed25519 key (§3.3). The wallet is referenced in the receipt as a data field. The binding attestation is an additional artifact that proves the identity's ownership of the wallet address.

Protocol-conformant. This is how cross-chain support works without reintroducing "Two Keys, One Soul" at the identity layer.

### 8.5 Different Ed25519-native chains

The Ed25519/Solana curve coincidence also holds for Aptos, Sui, and any other chain using Ed25519 addresses. An implementation MAY use any of these as its sovereign rail. The receipt format is identical; only the `task_id` prefix changes (`aptos:tx:...`, `sui:tx:...`).

Protocol-conformant.

### 8.6 Post-quantum migration

If Ed25519 is ever broken by quantum advances, the protocol SHOULD migrate to a post-quantum signature scheme (SPHINCS+, Dilithium, Falcon). Under the foundation law, the migration is permitted: §3 makes no claim about which signature algorithm is used, only that receipts are signed by the identity and verifiable using public information. The `SovereignPaymentReceipt` format can be extended with an algorithm identifier.

Not yet specified in detail. Protocol permits it.

---

## 9. Multi-Hop Coordination Patterns

Multi-hop settlement — where motebit A delegates to motebit B who sub-delegates to motebit C — requires a coordination layer above the raw value transfers. The foundation law permits multi-hop sovereign settlement; the coordination layer is an implementation choice, not a protocol requirement.

Four coordination patterns are protocol-conformant under §3:

### 9.1 Pay-forward (trust-based)

A sends value to B via the sovereign rail. B immediately sends a portion to C via the sovereign rail. C delivers the work, returns a signed receipt to B. B completes the task using C's result, returns a signed receipt to A. Each hop is a direct sovereign transfer. No escrow, no relay, no onchain program.

**Trade-off:** B takes economic risk (paid C upfront, hopes A will accept B's work). Suitable for high-trust recurring chains and small hop values.

### 9.2 Onchain escrow program

A deposits the full budget into an onchain escrow program (a smart contract with a state machine: `pending → active → completed → settled`). The program releases portions to each hop upon proof of completion (signed receipts). A recovers funds on timeout. The program may extract a small protocol fee.

**Trade-off:** Requires an onchain program to exist (engineering cost: ~3-6 weeks Solana program + audit). Suitable for low-trust chains and meaningful value.

This pattern is permitted but not mandated by this spec. The reference implementation does not currently ship an escrow program. An implementation that does is protocol-conformant.

### 9.3 Hybrid (onchain escrow + direct settlement)

A deposits the budget into the escrow program (9.2). B and C settle with each other via direct sovereign transfers (9.1). Final reconciliation occurs via the escrow program confirming all parties have been paid within the timeout.

**Trade-off:** Combines the speed of direct transfers with the trustlessness of onchain escrow. More complex than either alone. Suitable for mature multi-party commerce.

### 9.4 Relay-mediated (managed tier)

A allocates budget at a relay, the relay holds the budget in an internal virtual ledger, the relay orchestrates the chain, verifies receipts at each hop, and disburses on completion. The relay may extract a fee for its orchestration, escrow, and dispute resolution services.

**Trade-off:** Relay is required for this specific multi-hop chain. The motebit voluntarily chose to use relay mediation. Other motebits in the same network may choose 9.1, 9.2, or 9.3 for their multi-hop chains.

**This is protocol-conformant because the motebit's _choice_ to use the relay is optional.** Other motebits in the same network may bypass the relay entirely for multi-hop by using patterns 9.1–9.3. The foundation law requires that the sovereign path exists; it does not prohibit the relay-mediated path from also existing as a paid convenience.

### Implementation status

| Pattern            | Specified                  | Referenced implementation                                                  | Status                |
| ------------------ | -------------------------- | -------------------------------------------------------------------------- | --------------------- |
| 9.1 pay-forward    | Yes                        | `SovereignDelegationAdapter` in `packages/planner`, CLI `--sovereign` flag | Available via flag    |
| 9.2 onchain escrow | Yes (as permitted pattern) | No reference implementation                                                | Deferred until demand |
| 9.3 hybrid         | Yes (as permitted pattern) | No reference implementation                                                | Deferred              |
| 9.4 relay-mediated | Yes                        | `services/api` task routing + virtual ledger                               | Current default       |

The runtime default is 9.4 (relay-mediated). Pattern 9.1 (pay-forward) is available via `SovereignDelegationAdapter` and the CLI's `--sovereign` flag. The foundation law treats all four patterns as equally valid.

---

## 10. Security Model

This section describes the threat model, blast radius, and recommended mitigations for the default reference implementation (§6). Alternative implementations (§8) have different security profiles and should document their own threat models.

### 10.1 Threat model for the default implementation

In the default implementation, a single Ed25519 private key signs all of the following:

- Identity assertions
- Execution receipts (all types, including sovereign payment receipts)
- Credential issuance
- Federation messages
- Key succession records
- The sync encryption key derivation (deterministic AES-256 key: HKDF-SHA256 over the identity private key with empty salt and the info string `"motebit-sync-encryption-v1"`)
- Solana SPL token transfers (because the Solana keypair _is_ the Ed25519 identity keypair via curve coincidence)

The key is stored locally, in a platform-specific keystore: browser IndexedDB (web), Tauri OS keychain (desktop), Expo SecureStore backed by Secure Enclave / Keystore (mobile), or filesystem at mode 0600 (CLI).

### 10.2 Blast radius of compromise

If the private key is extracted, the attacker gains:

| Asset               | Consequence                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Wallet balance      | Drainable; Solana finality is subsecond                                                                      |
| Identity            | Impersonatable until key succession takes effect                                                             |
| Trust history       | Forgeable; attacker can sign fraudulent receipts in the motebit's name                                       |
| Credentials         | Forgeable; attacker can issue VCs as the motebit                                                             |
| Federation standing | Spoofable; attacker can send federation messages                                                             |
| Encrypted memory    | Decryptable; the sync encryption key derives from the identity key                                           |
| Future identity     | At risk; attacker with current key can sign a succession record declaring an attacker-controlled replacement |

**Compromise is total loss.** The default implementation has the same probability of compromise as a browser-stored hot wallet (MetaMask, Phantom), but a larger consequence per compromise because identity, trust, credentials, and memory access are concentrated into the same key.

### 10.3 Risk profile by value held

| Value at risk | Recommended implementation                           | Reasoning                                                                 |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| $0 – $50      | Default (§6)                                         | Bounded loss; same risk profile as a consumer hot wallet; simplicity wins |
| $50 – $10,000 | Default + hardware-backed storage (§8.3)             | Hardware storage dramatically reduces compromise probability              |
| > $10,000     | Multisig treasury (§8.2) with hot operational wallet | Compromise of the identity key alone cannot drain the treasury            |

### 10.4 Recommended mitigations

Implementations holding meaningful value SHOULD apply one or more of the following:

**Multisig treasury at the Solana account layer (§8.2).** The motebit identity remains one Ed25519 key. A separate Solana account holds the bulk of value, configured as a multisig (e.g., Squads). The identity key is one of N signers; user-controlled keys (hardware wallets, recovery services) are the others. Compromise of the identity key alone cannot drain the treasury.

**Hardware-backed key storage (§8.3).** The Ed25519 private key lives in hardware (Secure Enclave, TPM, WebAuthn authenticator, Ledger). The key cannot be extracted by software compromise. Signing happens via the hardware authenticator.

**Hot/cold separation.** The motebit's "hot wallet" (the identity address) holds only operational value for daily microtransactions. A separate "cold treasury" holds the bulk of value with stronger protection (multisig, hardware, or both). Periodic refills move value from treasury to hot wallet via authorized transactions.

**Onchain spending limits.** A Solana program wraps the wallet and enforces rate limits: spend up to $X per day without additional authorization, more requires multisig or cooldown. Caps the damage window during a compromise.

**Independent sync encryption key.** An implementation MAY derive the sync encryption key from a separate seed stored alongside the identity key but rotatable independently. Under compromise, rotating the sync seed makes previously synced data safe from retroactive decryption (for the subset where the attacker only holds the identity key, not the new sync seed). This is a protocol extension and not required by the default.

### 10.5 Key succession as partial recovery

The `motebit/identity@1.0` key succession mechanism allows a motebit to declare a new identity key, signed by the old one. In a compromise scenario, the legitimate user races the attacker: whoever broadcasts a succession record first "wins" the identity going forward. Onchain drainage typically completes in seconds, so succession is more effective for recovering _identity continuity_ than for protecting the wallet funds.

Succession is partial recovery. It is not a substitute for the mitigations in §10.4.

---

## 11. Extension Points

The following areas are explicitly left open for future specifications:

- **Additional sovereign rails.** Aptos, Sui, Ton, and other Ed25519-native chains may be added as reference implementations by mirroring the `wallet-solana` package pattern. No protocol change required.
- **Onchain escrow programs.** Pattern 9.2 (onchain escrow) is permitted but not shipped. A future spec (`motebit/escrow@1.0` or similar) may define a canonical escrow program interface so that multiple implementations can interoperate.
- **Post-quantum signature migration.** When and how to migrate away from Ed25519 if/when it becomes necessary. The receipt format is extensible to carry an algorithm identifier.
- **Cross-rail receipts.** A settlement that spans multiple rails (e.g., motebit A pays motebit B via Solana, who pays external counterparty C via x402) may produce a composite receipt referencing both rails.
- **Fee mechanisms.** This spec deliberately does not prescribe a fee mechanism. Relays MAY charge for services (orchestration, discovery, sync). Onchain programs MAY extract fees at the contract layer (Uniswap pattern). These are commercial choices, not protocol law. The sovereign direct path (§6) MUST remain fee-free at the protocol layer.

### 11.1 P2P Settlement Mode (Implemented)

As of 2026-04-11, the reference implementation supports a **p2p settlement mode** alongside the default relay-mediated mode. The settlement mode is selected per-task based on policy, not per-agent.

**Settlement mode:** `"relay"` (default) or `"p2p"`. Stored on `relay_settlements.settlement_mode`.

**P2P payment proof:** When a delegator pays a worker directly onchain (e.g., USDC SPL transfer on Solana), the delegator submits a `P2pPaymentProof` with the task:

```
P2pPaymentProof {
  tx_hash:      string      // Onchain transaction signature
  chain:        string      // "solana"
  network:      string      // CAIP-2 identifier
  to_address:   string      // Worker's declared settlement_address
  amount_micro: number      // Exact payment amount in micro-units
}
```

**Payment verification status:** `"pending"` | `"verified"` | `"failed"`. Pending proofs are verified asynchronously by the relay's p2p verifier loop (Solana `getTransaction` RPC). Transient RPC errors (JSON-RPC error responses, HTTP failures, timeouts) are retried — they MUST NOT be classified as "transaction not found." Only a confirmed null result (transaction does not exist onchain) transitions to `"failed"`.

**Policy-based eligibility:** P2p settlement is not automatic. Both parties must opt in via `settlement_modes` on their agent registration. The relay evaluates eligibility based on:

1. Mutual opt-in (both parties advertise `"p2p"` in `settlement_modes`)
2. Worker has a declared `settlement_address` (explicit, not inferred from identity key)
3. Trust score ≥ configurable threshold (default: 0.6 / "verified")
4. Interaction count ≥ configurable minimum (default: 5)
5. No active disputes between the pair

**Explicit settlement address:** The worker's `settlement_address` is declared at registration, not derived from the identity public key. This preserves future compatibility with separate signing domains, key rotation, multi-chain support, and multisig wallets.

**Fee model:** P2p settlement has zero platform fee in the reference implementation. The relay monetizes routing and credential issuance for p2p tasks, not custody. This is an explicit product policy, not a protocol constraint.

**Foundation Law:**

- Settlement mode selection MUST be policy-based, not hardcoded to a single trust label.
- Payment verification status MUST distinguish between "transaction not found" (permanent) and "RPC error" (transient/retryable). A transient error MUST NOT trigger trust downgrade.
- Amount matching MUST be exact (not `>=`). Overpayment or underpayment semantics are not defined and MUST be rejected.
- The `settlement_address` MUST be explicitly declared by the agent, not inferred from the identity key.

### 11.2 Aggregated Withdrawal Execution (Implemented)

As of 2026-04-15, the reference relay supports a **withdrawal aggregation layer** on top of `GuestRail.withdraw`. The default sweep (`services/api/src/sweep.ts`) fires one withdrawal per eligible agent per tick — for agents with small balances, each fire pays the rail's fixed cost. Aggregation defers sub-threshold items into a shared queue and fires on a per-rail policy.

**Pending ledger.** Sweep-enqueued withdrawals live in `relay_pending_withdrawals` — keyed by `(pending_id)`, tagged with `rail`, and carrying a state machine `pending → firing → fired|failed` (also `cancelled` for operator intervention). The virtual account is debited at enqueue time; the fire path does not re-debit. A rail failure parks the row as `failed` with the debit still in place — the debit is the audit trail that funds were claimed.

**Policy.** A conformant implementation MUST decide whether to fire a pending queue based on (a) the aggregated micro-unit value, (b) a per-item fee estimate in micro-units, (c) the oldest-item age in milliseconds, and (d) an operator-configurable policy threshold. The reference relay's default policy fires when the aggregated amount is at least 20× the per-item fee (fees ≤ 5%) or when the oldest pending item has waited ≥ 24 hours, subject to a $1 aggregated floor. Operators MAY override the policy per rail. The reference predicate is `shouldBatchSettle` in `packages/market/src/settlement.ts`; the policy type and defaults live alongside.

**Batch primitive.** `GuestRail` gains two additive members: `supportsBatch: boolean` (discriminant) and optional `withdrawBatch(items): Promise<BatchWithdrawalResult>`. `BatchableGuestRail` is the narrowed type (`supportsBatch: true`). At fire time, the relay dispatches via `isBatchableRail(rail) ? rail.withdrawBatch(items)` : serial `rail.withdraw` in a loop. Both paths preserve the aggregation win — the serial fallback fires less often, amortizing per-fire overhead across items.

**Today's rails all ship `supportsBatch = false`.** No GuestRail currently implements a native multi-item primitive: x402 settles one payment per facilitator call; Stripe payouts are admin-completed manually; Bridge's public API exposes single transfers. The interface is laid so that when a rail gains a native batch primitive, flipping the discriminant is the only code change required.

**Foundation Law (unchanged).**

- Aggregation is an operator convenience, not a blocker on sovereign settlement. §3.1–§3.5 invariants still hold — the sovereign path (§6) never traverses the pending queue.
- Debit-at-enqueue is a reference-implementation invariant, not foundation law. Alternative implementations MAY choose debit-at-fire if they accept the concurrent-sweep double-spend window.
- Per-item idempotency keys MUST be stable across retries; the composite-PK + state-machine design in the reference implementation enforces this.

---

## 12. Compatibility with External Agent Payment Protocols

The motebit settlement spec is explicitly designed to _coexist_ with external agent payment protocols, not to replace them:

- **x402** (HTTP 402 payment protocol, stewarded by the Linux Foundation) — a protocol rail (§5). A motebit MAY use x402 to pay endpoints that accept it. The motebit's wallet is the source of funds; x402 handles the HTTP-level choreography.
- **MPP** (Stripe Machine Payments Protocol) — a processor rail (§5). A motebit with a Stripe customer record MAY use MPP for fiat-shaped payments. Motebit acts as one implementation of the MPP payer side.
- **AP2** (Google Agent Payment Protocol) — a protocol rail. Same shape as x402.
- **TAP** (Visa Trusted Agent Protocol) — a processor rail over card networks.
- **Bridge** — an orchestration rail (§5) for fiat↔crypto conversion.

Motebit provides the **sovereign floor** (§6), the **receipt format** (§7), and the **identity layer** (out of scope of this spec — see `motebit/identity@1.0`). External protocols fill the rail boundary for counterparties that do not accept direct sovereign settlement. **Rails are plural, receipts are singular** — motebit's contribution is the receipt format and the sovereign floor, not a competing payment protocol.

---

## 13. Security Considerations (Additional)

- **Canonical JSON signing.** Receipt signatures cover canonical JSON per `canonicalJson` in `@motebit/crypto`. Implementations MUST use the same canonical form or signatures will not verify.
- **Replay protection.** Sovereign payment receipts include the onchain `tx_hash` in the `task_id`, which is globally unique per the chain's consensus. An attacker cannot replay a receipt because the same tx hash cannot be produced twice on the same chain. For non-chain-anchored receipts (future rails without an onchain proof), an implementation-defined nonce or timestamp-based replay guard is required.
- **Public key embedding.** Receipts SHOULD embed the signer's Ed25519 public key in the `public_key` field for portable verification. Verifiers that already know the signer's public key from another source may ignore this field.
- **Clock skew tolerance.** Verifiers MUST allow reasonable clock skew (recommended: ±60 seconds) when checking temporal binding fields (`submitted_at`, `completed_at`).

---

## 14. Conformance

A motebit implementation is **settlement-conformant** if and only if it satisfies all five invariants in §3:

- §3.1 (sovereignty invariant)
- §3.2 (self-verifiable receipt invariant)
- §3.3 (identity-signature binding invariant)
- §3.4 (relay-optionality invariant)
- §3.5 (plural rails invariant)

Conformance does not require using the default reference implementation (§6). Any implementation that satisfies §3 is conformant, regardless of which chain, rail, wallet topology, or coordination pattern it uses.

---

## Change Log

- **1.0** (2026-04-08) — Initial specification. Foundation law, settlement map, rail taxonomy, default reference implementation (Ed25519/Solana), sovereign payment receipt format, compatible implementations, multi-hop coordination patterns, security model.
- **1.0** (2026-04-15) — Additive: §11.2 Aggregated Withdrawal Execution. Reference-implementation extension; foundation law unchanged. `shouldBatchSettle` predicate in `@motebit/market`; optional `BatchableGuestRail` in `@motebit/protocol`.
