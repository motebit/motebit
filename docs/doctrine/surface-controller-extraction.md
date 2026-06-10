# Surface-controller extraction

A _surface controller_ is the daemon/lifecycle logic a flat surface runs in-app: managing MCP servers, driving relay sync, scheduling goals. Sibling of [`panels-pattern.md`](panels-pattern.md) — that doc decides where a panel's _projection_ state lives; this one decides where a controller's _behavior_ lives. The home for genuinely-shared controller logic is `@motebit/surface-kit` (Layer 3); the first and so far only resident is `McpManager` (`packages/surface-kit/src/mcp-manager.ts`).

The default is **per-surface**. Extraction is the exception, justified only when the four-question test below passes. The audit framing of "~16k lines of cross-surface duplication to dedup" is wrong: most of those lines are platform-specific by design, with the reusable cores already living in packages. Reading the bytes — not the line counts — is the discipline.

## The pattern (when a controller IS extracted)

`McpManager` is the model. State + actions live in the package; every point of platform divergence is inverted into a narrow injected **port**; each surface keeps a thin adapter (`class MobileMcpManager extends McpManager`) that supplies the ports and nothing else; adoption is locked by `check-surface-controller-adoption` so the logic cannot silently re-fork.

- Ports carry the divergence, not subclasses: `KeyValueStore` (AsyncStorage vs localStorage), `ExternalToolHost` (the runtime — passed structurally so the package never imports `@motebit/runtime` and stays L3), a registry factory (`@motebit/tools` vs `/web-safe`).
- The adapter-inverts-the-higher-layer-dependency move is the same one `@motebit/panels` uses to stay L5 ([`panels-pattern.md`](panels-pattern.md)). It is what keeps an extracted controller low in the DAG.

## The extraction test

Ask all four before extracting a surface controller. A _no_ on any one means leave it per-surface.

1. **Is it duplicated logic, or the same shared call in N places?** If the "identical" code across surfaces is identical _because each surface calls the same package function_, it is already factored — leave it. The relay sync controllers look 80% identical, but `deriveSyncEncryptionKey` / `secureErase` (`@motebit/encryption`), `cmdSelfTest` / `RelayDelegationAdapter` / `executeCommand` (`@motebit/runtime`) are _imports_, not copies. Nothing to extract.
2. **Is the divergence platform plumbing over identical behavior?** Only when the surfaces run the _same algorithm_ and differ solely in storage / naming / transport does extraction pay. `McpManager` passed (identical connect/trust/tool-registration lifecycle; divergence was storage + naming). Genuinely different behavior — Spatial's sync controller is a relay _consumer_ with no task serving or discovery, not the desktop/mobile _provider_ — does not.
3. **Does it fit the layer DAG?** A controller that needs Layer-5 types — `ScheduledGoal` / `NewGoalInput` (`@motebit/panels`), `cmdSelfTest` (`@motebit/runtime`) — cannot live in L3 `@motebit/surface-kit` without dragging the layer up or duplicating rich types. It belongs in the L5 package that owns those types, or stays in the app. A guard so thin that inverting its L5 dependency leaves the surface holding the closure (the self-test once-per-device wrapper) is below the extraction threshold — the abstraction costs more than the duplication.
4. **Is it deliberately platform-specific?** Hardware attestation routes through different roots of trust per platform (WebAuthn vs Secure Enclave / TPM vs App Attest / Keystore) — `mint-hardware-credential.ts` is correctly per-surface with the shared composer (`composeHardwareAttestationCredential`) already in `@motebit/encryption`. A daemon substrate that was _deliberately_ de-shared belongs to the app that owns it.

## Verdicts

| Controller                  | Decision                               | Why                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP manager                 | **Extracted** → `@motebit/surface-kit` | Identical lifecycle; divergence was only storage backend + naming. The one genuine accidental fork.                                                                                                                                                     |
| Relay sync controller       | Per-surface                            | Reusable primitives already shared (`@motebit/encryption`, `@motebit/runtime`); remainder is genuinely-divergent, data-integrity-critical orchestration; Spatial is a relay consumer, not a provider (test Q1, Q2).                                     |
| Goal scheduler              | Per-surface                            | The projection controller is already shared in `@motebit/panels`; the daemon was deliberately moved _out_ of the shared package into the apps (`apps/web/src/goal-engine.ts`'s `createGoalsEngine`, 2026-06-08) and needs L5 panel types (test Q3, Q4). |
| Slash commands              | Per-surface                            | The dispatcher is already shared (`packages/runtime/src/commands/index.ts`, `executeCommand`); cross-surface visibility is enforced by `check-universal-slash-coverage`; the rest is irreducible surface-specific command logic (test Q1).              |
| Hardware-credential minting | Per-surface                            | Platform-specific attestation routing (`apps/web/src/mint-hardware-credential.ts` and siblings); shared envelope composer already in `@motebit/encryption` (test Q4).                                                                                   |

`slab-chrome` and the agent sigil are _renders_, not controllers — Ring-3 per-surface output governed by `chrome-as-state-render.md` and their own parity locks; out of scope here.

## Revisit trigger

Extract a new surface controller — and add it to `ADOPTIONS` in `check-surface-controller-adoption.ts` — only when a file appears that passes all four questions: genuinely duplicated _logic_ (not shared calls), divergent only in plumbing, fitting the DAG, and not deliberately platform-specific. Absent that, the per-surface controller is the correct architecture, not debt. Cheap-to-extract is not a reason to extract; the abstraction must remove real duplication, not relocate it.
