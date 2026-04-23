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
- **Settlement** — `BudgetAllocation`, `SettlementRecord`, `PLATFORM_FEE_RATE`
- **Trust algebra** — semiring operations for delegation-chain trust computation
- **Policy** — `ToolDefinition`, `PolicyDecision`, `RiskLevel`, `SensitivityLevel`
- **Storage adapters** — pluggable persistence contracts for any backend
- **Cryptosuite registry** — `SuiteId` union for crypto-agile wire artifacts

Product-level types (state vectors, creature behavior, rendering spec) live in [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk), which re-exports everything here plus the product vocabulary.

## Related

- [`@motebit/sdk`](https://www.npmjs.com/package/@motebit/sdk) — superset with product types for building on Motebit
- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — sign and verify every artifact this package types
- [`@motebit/verifier`](https://www.npmjs.com/package/@motebit/verifier) — offline third-party verifier CLI
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity
- [`motebit`](https://www.npmjs.com/package/motebit) — reference runtime and operator console

## License

MIT — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The MIT License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
