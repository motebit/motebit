---
"motebit": patch
---

Same-pass surface wiring for the hardware-attestation peer flow.

The CLI landed with `5e7a1922` (runtime-hardware-attestation-fetcher-cli-wiring). This commit closes one-pass delivery across the four other surfaces — `@motebit/desktop`, `@motebit/mobile`, `@motebit/web`, `@motebit/spatial` — so peer hardware claims fold into routing trust regardless of which surface the user delegates from.

## Why a lazy resolver

The CLI's sync URL was a constant the moment we constructed `MotebitRuntime`. The other four surfaces resolve it through cached fields that get repopulated on config changes:

- **Desktop** — `_proxySyncUrlCache` (cached at bootstrap from Tauri config)
- **Mobile** — `_proxySyncUrlCache` (cached at bootstrap from AsyncStorage)
- **Web** — `loadSyncUrl()` reads `localStorage` on each call
- **Spatial** — same `localStorage` accessor as the ProxySessionAdapter

Threading the URL into the runtime at construction would have meant runtime reconstruction every time the user changed relay settings. So `createRelayCapabilitiesFetcher` now accepts either a static string OR a synchronous resolver:

```text
baseUrl: string | (() => string | undefined | null)
```

If the resolver returns `undefined` / `null` / `""`, the fetcher returns `[]` without touching the network — matches the no-claim-observed semantics the runtime hook already handles. Three new unit tests pin the lazy branch (resolver yields, resolver returns undefined, resolver returns empty string); the static-string path is unchanged.

## Surface choice — why spatial gets the wiring

`apps/spatial/CLAUDE.md` rejects the panel metaphor, but the hardware-attestation peer flow isn't a panel — it's a runtime hook that fires on the same `MotebitRuntime.bumpTrustFromReceipt` path every other surface uses. The creature in spatial dispatches receipts through the same delegation engine; if a worker is running a hardware-backed identity, that should score at `HW_ATTESTATION_HARDWARE` (1.0) regardless of which surface the user delegated from. Skipping spatial would have introduced a routing asymmetry — same workers, same claims, different scores depending on the delegator's surface.

## What's now load-bearing

Each surface's runtime, on every successful delegation, pulls `GET /agent/:remote_motebit_id/capabilities`, parses the worker's self-published `hardware_attestation` credential, runs the embedded claim through the bundled platform adapter (App Attest / Android Hardware-Backed Keystore Attestation / TPM 2.0 / WebAuthn / + the deprecated Play Integrity), and on `valid: true` issues a peer `AgentTrustCredential` carrying the verified claim. The routing aggregator scores the result at `HW_ATTESTATION_HARDWARE` (1.0) — 10× the software sentinel's 0.1 — visible across every routing decision the user's motebit makes from now on.

## Why patch

Operator-facing surface (subcommands, flags, `~/.motebit/` layout, relay HTTP routes, MCP server tool list, web/desktop/mobile/spatial UI) is unchanged. The behavior change is visible only inside the routing semiring's edge weights.
