# @motebit/sdk

Core types for the motebit protocol.

Zero dependencies. Pure TypeScript interfaces, enums, and type definitions for building on the motebit identity and agent protocol.

## Install

```bash
npm install @motebit/sdk
```

## What's included

| Category | Types |
|----------|-------|
| **Identity** | `MotebitIdentity`, `MotebitType`, `AgentTrustLevel`, `AgentTrustRecord` |
| **State vector** | `MotebitState`, `TrustMode`, `BatteryMode` |
| **Behavior** | `BehaviorCues`, `SPECIES_CONSTRAINTS` |
| **Memory** | `MemoryNode`, `MemoryEdge`, `MemoryCandidate`, `MemoryType`, `RelationType`, `SensitivityLevel` |
| **Policy** | `PolicyDecision`, `ToolRiskProfile`, `RiskLevel`, `DataClass`, `SideEffect`, `TurnContext`, `InjectionWarning`, `ToolAuditEntry` |
| **Tools** | `ToolDefinition`, `ToolResult`, `ToolHandler`, `ToolRegistry` |
| **AI provider** | `ContextPack`, `AIResponse`, `IntelligenceProvider`, `ConversationMessage`, `ToolCall` |
| **Events** | `EventLogEntry`, `EventType` |
| **Sync** | `SyncCursor`, `ConflictEdge`, `SyncConversation`, `SyncConversationMessage`, `ConversationSyncResult` |
| **Plans** | `Plan`, `PlanStep`, `PlanStatus`, `StepStatus` |
| **Agent protocol** | `AgentTask`, `AgentTaskStatus`, `ExecutionReceipt`, `AgentCapabilities` (includes `did:key`) |
| **Render** | `RenderSpec`, `GeometrySpec`, `MaterialSpec`, `LightingSpec` |
| **Privacy** | `AuditRecord`, `ExportManifest` |

## Usage

```typescript
import { MotebitState, TrustMode, BatteryMode, ExecutionReceipt } from "@motebit/sdk";

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
```

## License

MIT. Motebit is a trademark of Daniel Hakim.
