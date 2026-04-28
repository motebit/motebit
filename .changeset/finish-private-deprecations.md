---
"@motebit/relay": patch
---

Finish or decommission the 13 private-package `@deprecated` markers that were the half-finished work the new gate codified. Doctrine clarified: in a private workspace, `@deprecated` is structurally a TODO unless it names a deferred-design gap explicitly.

**Deleted (8 dead-code markers + their alias-only tests):**

- `@motebit/ai-core`: `OllamaDetectionResult`, `detectOllama`, `CloudProvider`, `CloudProviderConfig` — only their own alias-tests referenced them; deleted with the symbols.
- `@motebit/market`: `scoreCandidate`, `rankCandidates` — superseded by `graphRankCandidates` (graph-routing.ts); only tested themselves. Deleted with their private helpers (`computeSuccessRate`, `computeLatency`, `computePriceEfficiency`, `computeCapabilityMatch`) and trimmed `scoring.test.ts` to the active `applyPrecisionToMarketConfig` cases.
- `@motebit/relay` `federation.ts`: `PeerRateLimiter` alias — zero callers (the JSDoc's "two test imports" had already migrated).
- `@motebit/web` `storage.ts`: `SoulColorConfig` type alias — unused; the actual save/load uses `AppearanceConfig` from `@motebit/sdk` directly.

**Migrated / decommissioned (4 active markers, 1 dual-API correction):**

- `@motebit/relay` `anchoring.ts`: deleted the entire legacy EVM anchoring path — `EvmContractSubmitter` class, `chainRpcUrl`/`contractAddress`/`chainNetwork` config fields, the `sha256Hex` helper and `ANCHOR_SELECTOR` constant, and the boot-path branches at federation + agent-settlement loops. Solana memo is the canonical chain anchor (per shipped doctrine). The deleted submitter inlined `eth_sendTransaction` JSON-RPC envelopes — a `services/relay/CLAUDE.md` rule 14 violation (external medium plumbing must speak motebit vocabulary, not provider vocabulary). Removing it closes the doctrine seam.
- `@motebit/mcp-client`: dropped `@deprecated` on `McpClientAdapter.authToken`; documented as the ergonomic shorthand for the static-bearer case alongside the richer `credentialSource` for OAuth/keyring/vault. Dual-API surface is a pattern, not a category error. `credentialSource` still takes precedence when both are set.

**Kept (2 markers, deferred-design — case 3 of the new doctrine):**

- `@motebit/runtime`: `runHousekeeping()` and `MotebitRuntime.housekeeping()` keep `@deprecated` (no semver, replacement pointer + Reason). The unblock criterion is the curiosity-target unification design — does curiosity belong in the consolidation cycle's gather phase or stay a separate signal the gradient manager subscribes to? Tightened both `Reason:` blocks and the `check-consolidation-primitives` allowlist comment to name the gap concretely instead of the stale "tracked as the 1.0.0 cutover" semver promise.

**Doctrine update** (`docs/doctrine/deprecation-lifecycle.md`):

Added a "When `@deprecated` is the right tag inside a private package" subsection naming the three cases (dead → delete; active workspace consumer → migrate then delete; deferred-design → keep with concrete unblock criterion). Notes that case 1/2 markers shouldn't sit annotated more than ~30 days; only case 3 has a legitimate long-tail. Closes the loop the bird's-eye review opened.

Net: 13 markers cleared, 2 retained with sharpened doctrine, 1 dual-API correction. The sibling-boundary rule between the two deprecation gates is now invariant — discipline gate continues binding published packages, shape gate binds private packages, doctrine names the cases each handles.
