# @motebit/sdk

The stable developer-contract surface. Apache-2.0 (permissive floor), Layer 0. The shape external integrators build against when they want to embed motebit in their own application, federate a relay, or ship a custom surface that stays compatible with every other motebit.

## Why this package exists as its own namespace

At first glance `@motebit/sdk`'s top-level `index.ts` looks like a re-export of `@motebit/protocol` — the naming suggests redundancy. It isn't. The sdk ships ~1,600 lines of developer-contract code that `@motebit/protocol` deliberately doesn't own:

- **Provider-mode resolver** (`provider-mode.ts`, `provider-resolver.ts`) — the rules for choosing between sovereign / BYOK / subscription provider modes, including the sensitivity-aware routing that keeps medical / financial / secret payloads away from external AI. A third party integrator needs this logic to match motebit's runtime; the underlying types (`ProviderMode`, `SensitivityLevel`) belong to the protocol, but the resolver is the developer's copy-paste-stable starting point.
- **Presets** (`color-presets.ts`, `approval-presets.ts`, `risk-labels.ts`, `surface-options.ts`) — motebit's canonical preset sets, versioned independently from the protocol. A surface that wants the same palette + risk taxonomy users have seen before imports from here.
- **Config vocabularies** (`governance-config.ts`, `voice-config.ts`, `appearance-config.ts`) — the shape of per-motebit configuration files. Stable across protocol minor versions so config on disk isn't invalidated by internal protocol churn.
- **Model registry** (`models.ts`) — the canonical model-capability table motebit routes against. Published as part of the developer contract so integrators can reason about capability classes without tracking provider SKUs themselves.

## The split between `@motebit/protocol` and `@motebit/sdk`

Both are on the permissive floor (Apache-2.0), both at Layer 0, both zero-monorepo-dep. The line is intentional:

| `@motebit/protocol`                                                       | `@motebit/sdk`                                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Wire types: what's on the bus                                             | Developer contract: what integrators type against                                                   |
| Algebra: `Semiring<T>`, `WeightedDigraph<T>`                              | Presets + resolvers: `ProviderMode` logic, preset arrays                                            |
| Locked by the protocol spec — breaking changes are protocol-version bumps | Locked by the developer commitment — breaks follow semver, independent of protocol version          |
| "Can a Rust implementation read motebit wire bytes?"                      | "Can a third-party TypeScript integrator compose motebit surfaces without waiting for protocol v2?" |

Separating them means the protocol can evolve internal shapes (rename a field, tighten a union) without breaking every downstream TypeScript project that pinned `@motebit/sdk@1.x`. The sdk carries backward-compatible re-exports, deprecation shims, and preset versioning that the protocol itself must stay agnostic to.

## Rules

1. **Apache-2.0, zero monorepo deps.** Same discipline as `@motebit/protocol` and `@motebit/crypto`. A third party implementing motebit in another ecosystem can read the types here without pulling BSL code — all the provider-mode + preset logic is published under the Apache permissive-floor terms (explicit patent grant) so integrators reproduce motebit's behavior freely.
2. **Independent semver from the protocol.** `@motebit/sdk@1.x` is a stable developer promise. Internal protocol churn that renames a wire field lands in `@motebit/protocol@1.y` without bumping the sdk major, as long as the sdk re-exports surface stays compatible.
3. **Re-exports are load-bearing, not decorative.** `export * from "@motebit/protocol"` at the top of `src/index.ts` is the commitment that every protocol type is accessible through `@motebit/sdk`. Integrators type a single import path; internal code in apps/services imports from `@motebit/sdk` (enforced by `check-app-primitives`), never reaching past it to `@motebit/protocol`.
4. **Preset changes are public-API changes.** The color palettes, approval presets, and model registry are committed to semver like any other exported constant. A new preset is additive; renaming or removing a preset is a breaking change. Surfaces must not shadow canonical identifiers (`APPROVAL_PRESET_CONFIGS`, `COLOR_PRESETS`, `RISK_LABELS`, `DEFAULT_GOVERNANCE_CONFIG`, `DEFAULT_VOICE_CONFIG`, `DEFAULT_APPEARANCE_CONFIG`) with local `const`/`interface`/`type` declarations — enforced by `check-preset-imports` (drift-defenses #40). Re-export trampolines (`export { X } from "@motebit/sdk"`) are the allowed pattern when a surface wants a local module path with the canonical value underneath.

## Consumers

- Every `apps/*` surface (desktop, mobile, web, spatial, admin, cli) imports from `@motebit/sdk` for developer-contract types.
- Third-party integrators embedding motebit into their own TypeScript apps — the sdk is the stable face of the monorepo they pin to.
- `create-motebit` scaffolds new projects that depend on `@motebit/sdk` as their single import path for motebit types + config shapes.
