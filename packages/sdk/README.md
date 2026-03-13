# @motebit/sdk

Core protocol types for the motebit agent identity standard.

Zero dependencies. Pure TypeScript interfaces, enums, branded ID types, and utility functions for building on the motebit protocol.

## Install

```bash
npm install @motebit/sdk
```

## Usage

```typescript
import {
  type MotebitState,
  type ExecutionReceipt,
  type AgentTask,
  TrustMode,
  BatteryMode,
  AgentTrustLevel,
  RiskLevel,
} from "@motebit/sdk";

// Typed agent state vector
const state: MotebitState = {
  attention: 0.7,
  processing: 0.3,
  confidence: 0.85,
  affect_valence: 0.6,
  affect_arousal: 0.2,
  social_distance: 0.4,
  curiosity: 0.5,
  trust_mode: TrustMode.Guarded,
  battery_mode: BatteryMode.Normal,
};

// Typed execution receipt (returned by agents after task completion)
const receipt: ExecutionReceipt = {
  task_id: "...",
  motebit_id: "...",
  device_id: "...",
  submitted_at: Date.now(),
  completed_at: Date.now(),
  status: "completed",
  result: "...",
  tools_used: ["web_search"],
  memories_formed: 2,
  prompt_hash: "sha256:...",
  result_hash: "sha256:...",
  signature: "ed25519:...",
};
```

## Branded ID types

The SDK exports branded string types that enforce compile-time safety at API boundaries:

```typescript
import {
  type MotebitId,
  type DeviceId,
  type GoalId,
  type PlanId,
  type NodeId,
  asMotebitId,
  asDeviceId,
} from "@motebit/sdk";

// Prevent accidental ID swaps across API boundaries
function submitTask(motebitId: MotebitId, deviceId: DeviceId) { ... }

// Explicit branding at system boundaries
const id = asMotebitId(rawString);
```

## Trust algebra

```typescript
import {
  AgentTrustLevel,
  trustLevelToScore,
  composeTrustChain,
  evaluateTrustTransition,
  type AgentTrustRecord,
} from "@motebit/sdk";

// Compose trust through a delegation chain (semiring: max for parallel, multiply for serial)
const chainTrust = composeTrustChain([0.9, 0.6, 0.8]); // 0.432

// Evaluate whether a trust record should transition levels
const newLevel = evaluateTrustTransition(record); // AgentTrustLevel | null
```

## API reference

| Category             | Key exports                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Branded IDs**      | `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId` + `as*` factory functions                                               |
| **Identity**         | `MotebitIdentity`, `MotebitType`, `AgentCapabilities`                                                                                                      |
| **State vector**     | `MotebitState`, `TrustMode`, `BatteryMode`                                                                                                                 |
| **Behavior**         | `BehaviorCues`, `SPECIES_CONSTRAINTS`                                                                                                                      |
| **Memory**           | `MemoryNode`, `MemoryEdge`, `MemoryContent`, `MemoryCandidate`, `MemoryType`, `SensitivityLevel`, `RelationType`                                           |
| **Policy**           | `PolicyDecision`, `ToolRiskProfile`, `RiskLevel`, `DataClass`, `SideEffect`, `TurnContext`, `InjectionWarning`, `ToolAuditEntry`                           |
| **Tools**            | `ToolDefinition`, `ToolResult`, `ToolHandler`, `ToolRegistry`                                                                                              |
| **AI provider**      | `ContextPack`, `AIResponse`, `IntelligenceProvider`, `ConversationMessage`, `ToolCall`                                                                     |
| **Events**           | `EventLogEntry`, `EventType`                                                                                                                               |
| **Sync**             | `SyncCursor`, `ConflictEdge`, `SyncConversation`, `SyncConversationMessage`                                                                                |
| **Plans**            | `Plan`, `PlanStep`, `PlanStatus`, `StepStatus`                                                                                                             |
| **Agent protocol**   | `AgentTask`, `AgentTaskStatus`, `ExecutionReceipt`, `DeviceCapability`                                                                                     |
| **Trust algebra**    | `AgentTrustLevel`, `AgentTrustRecord`, `trustLevelToScore`, `composeTrustChain`, `joinParallelRoutes`, `evaluateTrustTransition`, `composeDelegationTrust` |
| **Execution ledger** | `GoalExecutionManifest`, `ExecutionTimelineEntry`, `ExecutionStepSummary`, `DelegationReceiptSummary`                                                      |
| **Market**           | `BudgetAllocation`, `SettlementRecord`, `RouteScore`, `AgentServiceListing`, `MarketConfig`                                                                |
| **Credentials**      | `GradientCredentialSubject`, `ReputationCredentialSubject`, `TrustCredentialSubject`, `VC_TYPE_GRADIENT`, `VC_TYPE_REPUTATION`, `VC_TYPE_TRUST`            |
| **Precision**        | `PrecisionWeights`                                                                                                                                         |
| **Privacy**          | `AuditRecord`, `ExportManifest`                                                                                                                            |
| **Render**           | `RenderSpec`, `GeometrySpec`, `MaterialSpec`, `LightingSpec`                                                                                               |

## Related

- [`@motebit/verify`](https://www.npmjs.com/package/@motebit/verify) — verify a `motebit.md` identity file signature
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity in 30 seconds
- [motebit/identity@1.0 spec](https://github.com/motebit/motebit/blob/main/spec/identity-v1.md) — the open protocol specification

## License

MIT. Motebit is a trademark of Daniel Hakim.
