# @motebit/sdk

The developer contract for building Motebit-powered agents, services, and integrations. Apache-2.0, zero runtime dependencies.

## Why this exists

`@motebit/sdk` is the **permissive-floor boundary** between the open protocol and your application. It re-exports everything in [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) (identity, receipts, credentials, settlement, trust algebra) and adds the product vocabulary the reference runtime consumes: state vectors, behavior cues, memory graph, rendering spec, AI provider interfaces. Binding to the SDK instead of the runtime keeps your code portable across surfaces (desktop, mobile, spatial, cloud) and across alternative runtimes.

If you only need the protocol core, depend on `@motebit/protocol` directly — both are Apache-2.0.

## Install

```bash
npm install @motebit/sdk
```

## Example

```ts
import type { IntelligenceProvider, ContextPack, AIResponse, MotebitState } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";

// Swap in any AI backend by implementing one interface.
class MyProvider implements IntelligenceProvider {
  async generate(ctx: ContextPack): Promise<AIResponse> {
    // Call your model + tool-use loop, then return the four required fields.
    return {
      text: "...",
      confidence: 0.8,
      memory_candidates: [],
      state_updates: { attention: 0.9 },
    };
  }
  async estimateConfidence() {
    return 0.8;
  }
  async extractMemoryCandidates(_r: AIResponse) {
    return [];
  }
}

// State vector — the motebit's self-model, bounded by species constraints.
const state: MotebitState = {
  attention: 0.7,
  processing: 0.2,
  confidence: 0.9,
  affect_valence: 0.3,
  affect_arousal: 0.15,
  social_distance: 0.4,
  curiosity: 0.6,
  trust_mode: TrustMode.Guarded,
  battery_mode: BatteryMode.Normal,
};
```

## What's included

Everything from `@motebit/protocol` (re-exported), plus:

- **State vector** — `MotebitState`, `TrustMode`, `BatteryMode`
- **Behavior** — `BehaviorCues`, `SPECIES_CONSTRAINTS`
- **Memory graph** — `MemoryNode`, `MemoryEdge`, `MemoryQuery`, `MemoryStorageAdapter`
- **Rendering** — `RenderSpec`, `GeometrySpec`, `MaterialSpec`, `LightingSpec`
- **AI provider** — `ContextPack`, `AIResponse`, `IntelligenceProvider`, `ConversationMessage`
- **Gradient** — `GradientSnapshot`, `GradientStoreAdapter`, `PrecisionWeights`
- **Export** — `ExportManifest`, `StorageAdapters`

## Related

- [`@motebit/protocol`](https://www.npmjs.com/package/@motebit/protocol) — the protocol subset (Apache-2.0, zero deps)
- [`@motebit/crypto`](https://www.npmjs.com/package/@motebit/crypto) — sign and verify every Motebit artifact (Apache-2.0, zero deps)
- [`@motebit/verifier`](https://www.npmjs.com/package/@motebit/verifier) — offline third-party verifier library (Apache-2.0)
- [`create-motebit`](https://www.npmjs.com/package/create-motebit) — scaffold a signed agent identity
- [`motebit`](https://www.npmjs.com/package/motebit) — reference runtime and operator console

## License

Apache-2.0 — see [LICENSE](./LICENSE).

"Motebit" is a trademark. The Apache License grants rights to this software, not to any Motebit trademarks, logos, or branding. You may not use Motebit branding in a way that suggests endorsement or affiliation without written permission.
