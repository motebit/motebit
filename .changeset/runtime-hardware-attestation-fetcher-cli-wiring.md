---
"motebit": patch
---

Wire the hardware-attestation peer flow in the CLI runtime.

The runtime hook in `packages/runtime/src/agent-trust.ts:258` (Phase 1 + Phase 2, shipped earlier) was dormant in production: `bumpTrustFromReceipt` gates on `if (getRemoteHardwareAttestations && updated.public_key)`, and no surface had ever called `setHardwareAttestationFetcher` or `setHardwareAttestationVerifiers`. The peer-attestation issuance loop existed only in the relay-side E2E tests; in the actual CLI runtime, hardware claims published by workers were never pulled, never verified, never folded into peer trust credentials, and never visible to routing.

## What shipped

1. **`createRelayCapabilitiesFetcher`** — new export on `@motebit/runtime`. Production fetcher that hits `GET /agent/:motebitId/capabilities`, parses the `hardware_attestations` array, and returns it shaped for the runtime's `HardwareAttestationFetcher` slot. Best-effort: every error surface (network throw, non-2xx, malformed JSON, missing fields, wrong types) returns `[]` so the existing reputation-credential path proceeds unchanged. 8 unit tests pin each error surface plus the success path.

2. **CLI wiring** at both runtime construction sites — `apps/cli/src/runtime-factory.ts` (REPL, `motebit delegate`, `motebit serve` paths) and `apps/cli/src/daemon.ts` site 1 (long-running daemon mode where `motebit run --price` workers + delegators accumulate trust). After `runtime.connectSync(...)`:

   ```ts
   runtime.setHardwareAttestationFetcher(createRelayCapabilitiesFetcher({ baseUrl: syncUrl }));
   runtime.setHardwareAttestationVerifiers(buildHardwareVerifiers());
   ```

   Adds `@motebit/verify` (Apache-2.0) as a CLI dep — which is what bundles the four canonical platform adapters (App Attest, Android Hardware-Backed Keystore Attestation, TPM 2.0, WebAuthn) plus the deprecated Play Integrity adapter into the CLI binary. Per `motebit-runtime.ts:2462`, `@motebit/verify` is intentionally NOT a runtime dep — surfaces own that choice.

## Why a patch and not a minor

Operator-facing surface (subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes, MCP server tool list) is unchanged. The change is internal: peer trust credentials now carry a hardware-attestation block at delegation time when the worker has published a verifiable claim, which the routing aggregator scores at `HW_ATTESTATION_HARDWARE` (1.0) instead of the software sentinel's `HW_ATTESTATION_SOFTWARE` (0.1). Per `apps/cli/README.md`'s public-promise paragraph, that's not a breaking change.

## What's still deferred

The other four surfaces — `@motebit/desktop`, `@motebit/mobile`, `@motebit/web`, `@motebit/spatial` — construct `MotebitRuntime` and may benefit from the same wiring. Mechanical follow-on (one-pass-delivery candidate); separated from this commit because each surface has its own sync-URL resolution pattern and adding `@motebit/verify` to four more workspaces is best reviewed in its own diff. The runtime hook stays dormant on those surfaces until the same two setters are called there.
