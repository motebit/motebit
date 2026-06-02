# @motebit/protocol

Wire-format types for the Motebit agent identity standard. Zero dependencies. Pure TypeScript.

## Why this exists

Motebit is an open protocol for sovereign AI agents — persistent cryptographic identity, signed execution receipts, verifiable credentials, and trust algebra. This package is the type-level contract any system needs to **interoperate** with motebits: verify an agent's identity, validate an execution receipt, issue a reputation credential, compute a trust score, settle a payment. Binding to these types instead of a BSL implementation is what makes an alternative runtime possible.

## Install

```bash
npm install @motebit/protocol
```

## Example

```ts
import type { MotebitId, ExecutionReceipt, VerifiableCredential } from "@motebit/protocol";
import { asMotebitId, PLATFORM_FEE_RATE } from "@motebit/protocol";

// Branded IDs — compile-time guardrail against mixing ID spaces.
const agent: MotebitId = asMotebitId("01234567-89ab-cdef-0123-456789abcdef");

// Receipts and credentials are pure data. Pair with @motebit/crypto to
// sign or verify.
function auditsPass(receipt: ExecutionReceipt): boolean {
  return receipt.status === "completed" && receipt.tools_used.length > 0;
}

// Protocol constants.
const relayFee = PLATFORM_FEE_RATE; // 0.05 — the universal 5% relay fee.
```

## What's included

- **Branded ID types** — `MotebitId`, `DeviceId`, `GoalId`, `AllocationId`, etc.
- **Identity** — `MotebitIdentity`, `KeySuccessionRecord`, `DeviceRegistration`
- **Execution receipts** — `ExecutionReceipt` with nested delegation chains
- **Credentials** — W3C VC 2.0 types (`ReputationCredentialSubject`, `TrustCredentialSubject`)
- **Settlement** — `BudgetAllocation`, `SettlementRecord`, `PLATFORM_FEE_RATE`; `computeP2pFeeMicro(netCostMicro, feeRate)` for the canonical P2P fee-leg amount in micro-units (`gross - net`) — the relay's proof validator and the delegator client building the proof share it so the fee can't drift; `computeFederatedFeeSplit(budgetMicro, feeRate)` for the cross-operator fee-from-budget split (origin-fee / executor-fee / worker-net legs, spec §7.1), shared the same way; `SettlementMode` closed union (`"relay" | "p2p"`) with `ALL_SETTLEMENT_MODES` for iteration and `isSettlementMode` for narrowing wire-format payloads pulled from discovery / peer-negotiation responses; `SettlementAsset` closed union (`"USDC"` at sub-phase A) with `ALL_SETTLEMENT_ASSETS` for iteration and `isSettlementAsset` for narrowing — the typed vocabulary of stablecoin assets the protocol clears settlement in; `SovereignRail.asset` is structurally tightened to this union so a peer announcing an unknown asset fails closed. **Guest-rail capability marker interfaces** + type guards — `GuestRail` carries `supportsDeposit` / `supportsWithdraw` / `supportsBatch` discriminants; `DepositableGuestRail` / `WithdrawableGuestRail` / `BatchableGuestRail` add the corresponding methods; `isDepositableRail` / `isWithdrawableRail` / `isBatchableRail` narrow at the call site. The marker on `WithdrawableGuestRail` is the structural enforcement of the off-ramp doctrine: rails that don't opt in (e.g., Bridge, treasury-only) cannot drive user-facing withdrawals because `withdraw` does not exist on the base type
- **Sovereign wallet port** — `SovereignWalletRail` (extends `SovereignRail` with `send` / `isAvailable`) + `SovereignSendResult`; the rail interface the interior consumes so a runtime can use a sovereign rail without depending on a settlement-rail provider package
- **Encoding** — `base58Encode`, a pure chain-agnostic base58btc codec (Bitcoin alphabet; the encoding behind Solana address derivation), sibling to the money converters
- **Trust algebra** — semiring operations for delegation-chain trust computation
- **Policy** — `ToolDefinition`, `PolicyDecision`, `RiskLevel`, `SensitivityLevel` (the 5-tier privacy ladder, the most load-bearing closed registry; `ALL_SENSITIVITY_LEVELS` for iteration, `isSensitivityLevel` for narrowing unknown payloads, `rankSensitivity` / `maxSensitivity` / `sensitivityPermits` for the algebra)
- **Event-log vocabulary** — `EventType` closed enum (59 entries spanning identity / memory / goals / approvals / plans / consolidation / co-browse / agents); `ALL_EVENT_TYPES` for iteration, `isEventType` for narrowing wire-format payloads pulled from sync peers or federation
- **Storage adapters** — pluggable persistence contracts for any backend
- **Cryptosuite registry** — `SuiteId` union for crypto-agile wire artifacts
- **Merkle tree-hash registry** — `MerkleTreeVersion` closed union (RFC 6962 §2.1 leaf/node domain separation as an agility axis) with `MERKLE_TREE_VERSION_REGISTRY` + `ALL_MERKLE_TREE_VERSIONS` for iteration, `isMerkleTreeVersion` / `getMerkleTreeVersionEntry` for narrowing/lookup, and `DEFAULT_MERKLE_TREE_VERSION` — the absent ⇒ v1 downgrade-safety default for a proof's optional `tree_hash_version` field
- **Auto-router registry** — `TaskShape` closed union (`ALL_TASK_SHAPES`, `isTaskShape`) for the model-selection primitive; named constants `QUICK_TASK_SHAPE`, `CHAT_TASK_SHAPE`, `REASONING_TASK_SHAPE`, `CODE_TASK_SHAPE`, `RESEARCH_TASK_SHAPE`, `CREATIVE_TASK_SHAPE`, `MATH_TASK_SHAPE`. Paired with `ProviderCapability` + `RoutingConstraint` + `RoutingDecision` types consumed by `@motebit/policy::dispatchRouting`

Product-level types (state vectors, creature behavior, rendering spec) live in [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk), which re-exports everything here plus the product vocabulary.

## Related

- [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk) — superset with product types for building on Motebit
- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — sign and verify every artifact this package types
- [`@motebit/verifier`](https://www.npmjs.com/package/@motebit/verifier) — offline third-party verifier CLI
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity
- [`motebit`](https://www.npmjs.com/package/motebit) — reference runtime and operator console

## License

Apache-2.0 — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
