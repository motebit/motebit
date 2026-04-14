# @motebit/protocol

Network protocol types for the Motebit agent identity standard.

Zero dependencies. Pure TypeScript — identity, execution receipts, verifiable credentials, settlement records, trust algebra, policy governance, and storage adapter contracts.

This package defines the types that any system needs to participate in the Motebit network: verify agent identity, validate execution receipts, issue credentials, compute trust scores, and settle payments. It does not include product-specific types (state vectors, creature behavior, rendering) — those are in `@motebit/sdk`.

## Install

```bash
npm install @motebit/protocol
```

## What's included

- **Branded ID types** — `MotebitId`, `DeviceId`, `GoalId`, `AllocationId`, etc.
- **Trust algebra** — semiring operations for delegation chain trust computation
- **Identity** — `MotebitIdentity`, `KeySuccessionRecord`, `DeviceRegistration`
- **Execution receipts** — `ExecutionReceipt` with nested delegation chains
- **Credentials** — W3C VC 2.0 types (`ReputationCredentialSubject`, `TrustCredentialSubject`)
- **Settlement** — `BudgetAllocation`, `SettlementRecord`, `PLATFORM_FEE_RATE`
- **Policy** — `ToolDefinition`, `PolicyDecision`, `RiskLevel`, `SensitivityLevel`
- **Storage adapters** — pluggable persistence contracts for any backend

## License

MIT — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The MIT License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
