# Licensing

Motebit uses a dual-license model: a permissive floor and a source-available runtime. Both converge to Apache-2.0 in the end state.

## Permissive Floor — Apache License, Version 2.0

The protocol specification, type definitions, identity verification, scaffolding, and the hardware-attestation platform-leaf verifiers are licensed under the Apache License, Version 2.0. Use them for any purpose, including commercial, without restriction.

| Package                             | npm                                | Purpose                                                                                                               |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `spec/`                             | —                                  | Identity, execution-ledger, federation, market specs                                                                  |
| `packages/protocol/`                | `@motebit/protocol`                | Network protocol types (0 deps)                                                                                       |
| `packages/sdk/`                     | `@motebit/sdk`                     | Full type vocabulary (re-exports protocol)                                                                            |
| `packages/crypto/`                  | `@motebit/crypto`                  | Standalone signature verification (0 deps)                                                                            |
| `packages/verifier/`                | `@motebit/verifier`                | Library: `verifyFile`, `verifyArtifact`, `formatHuman`                                                                |
| `packages/verify/`                  | `@motebit/verify`                  | `motebit-verify` CLI (bundles the canonical platform leaves with motebit-canonical defaults)                          |
| `packages/crypto-appattest/`        | `@motebit/crypto-appattest`        | Apple App Attest chain verifier (pinned Apple root)                                                                   |
| `packages/crypto-android-keystore/` | `@motebit/crypto-android-keystore` | Android Hardware-Backed Keystore Attestation chain verifier (pinned Google attestation roots)                         |
| `packages/crypto-tpm/`              | `@motebit/crypto-tpm`              | TPM 2.0 EK chain verifier (pinned vendor roots)                                                                       |
| `packages/crypto-webauthn/`         | `@motebit/crypto-webauthn`         | WebAuthn packed-attestation verifier (pinned FIDO roots)                                                              |
| `packages/crypto-play-integrity/`   | `@motebit/crypto-play-integrity`   | _(deprecated)_ Google Play Integrity JWT verifier — see `crypto-android-keystore` for the canonical Android primitive |
| `packages/create-motebit/`          | `create-motebit`                   | Identity scaffolding CLI (0 deps)                                                                                     |
| `packages/github-action/`           | —                                  | GitHub Action for identity verification                                                                               |

These components have their own `LICENSE` files. They are **not** subject to the Business Source License. The canonical `crypto-*` platform leaves (`crypto-appattest`, `crypto-android-keystore`, `crypto-tpm`, `crypto-webauthn`) answer "how is this artifact verified?" against each platform's published public trust anchor — the permissive side of the protocol-model boundary test. The deprecated `crypto-play-integrity` ships alongside for one minor cycle for already-minted credentials and is removed at 2.0.0; see `docs/doctrine/hardware-attestation.md` § "Three architectural categories" for the structural reason. `@motebit/verify` aggregates them with motebit-canonical defaults (bundle IDs, RP ID, integrity floor) into a one-install CLI; the aggregator is Apache-2.0 too because it encodes no motebit-proprietary judgment — the defaults are overridable flags, not trust scoring, economics, or federation routing. The BSL line stays at `motebit` (the operator console), which contains the actual reference-implementation judgment (daemon, MCP server, delegation routing, market integration).

The architectural role is "permissive floor"; the specific license instance is "Apache License, Version 2.0." The role is load-bearing, the instance is replaceable. `check-deps.ts` uses `PERMISSIVE_PACKAGES` and `check-spec-permissive-boundary.ts` uses the same vocabulary — the gate names describe the invariant (third-party-implementable without BSL license friction), not the specific permissive instance.

## Runtime Layer — Business Source License 1.1

Everything else is licensed under BSL-1.1. The source is fully visible — you can read, audit, learn from, and contribute to it.

> **A note on `BSL` vs `BUSL`.** The license is commonly called "BSL" / "BSL-1.1" in prose — MariaDB's own BSL FAQ and major adopters (HashiCorp, CockroachDB, Sentry) all use "BSL." The SPDX-canonical identifier is `BUSL-1.1`; the `U` disambiguates against `BSL-1.0`, the Boost Software License. This codebase uses `BSL` / `BSL-1.1` where humans read prose and `BUSL-1.1` only where tooling parses it as a token (every `package.json` `license` field). `check-license-doc-sync` enforces the token register; the prose register is convention.

**Permitted:**

- Personal, educational, and research use
- Internal business use (within your own organization)
- Contributing to the project

**Not permitted without a commercial license:**

- Offering as a hosted service (SaaS, API, managed service)
- Distributing as part of a commercial product
- Providing services to third parties for a fee

**Contact:** daniel@motebit.com for commercial licensing.

### What's in the runtime layer

**Cognitive architecture:**
`ai-core` · `memory-graph` · `state-vector` · `behavior-engine` · `planner`

**Identity and security:**
`encryption` · `core-identity` · `identity-file` · `policy` · `policy-invariants` · `privacy-layer`

**Infrastructure:**
`event-log` · `persistence` · `browser-persistence` · `sync-engine` · `tools` · `voice` · `render-engine` · `mcp-client` · `mcp-server`

**Economic layer:**
`market` · `semiring`

**Runtime:**
`runtime`

**Applications:**
`cli` · `desktop` · `mobile` · `web` · `admin` · `spatial`

**Services:**
`api` · `research` · `code-review` · `web-search` · `read-url` · `summarize` · `embed` · `proxy`

## Convergence

Every version of the BSL-licensed code converts to the **Apache License, Version 2.0** four years after its publication date. Once converted, the code is permanently Apache-2.0 — permissive, no restrictions, with an explicit patent grant from every contributor.

This is load-bearing. The permissive floor is Apache-2.0 today; the BSL runtime becomes Apache-2.0 at each version's Change Date. The end state is a single-license codebase: one posture, one patent grant, one procurement decision. A monorepo whose meta-principle is "synchronization invariants — never let spec and code diverge" cannot carry a permanent two-license split built into the license choice itself.

The conversion applies to the entire runtime layer uniformly. There are no tiered conversion dates. It is automatic under the terms of BSL-1.1 and cannot be revoked.

## Why Apache-2.0 for the permissive floor

Three load-bearing arguments:

### 1. Patent clarity matters across the entire permissive floor

The permissive floor includes four canonical platform-attestation verifiers — Apple App Attest, Android Hardware-Backed Keystore Attestation, TPM 2.0, WebAuthn (plus the deprecated Google Play Integrity for one minor cycle) — that operate against vendor chains in heavy patent territory (Apple, Google, Microsoft, Infineon, Nuvoton, STMicro, Intel, Yubico, the FIDO Alliance). The VC/DID space the protocol builds on also carries patent filings. Every contributor who touches the permissive floor deserves to pass an explicit, irrevocable patent license to downstream consumers (Apache §3), and the project deserves protection from contributors who later assert patent claims (Apache §4.2 — "institute patent litigation … any patent licenses granted to You under this License for that Work shall terminate as of the date such litigation is filed"). MIT is silent on patents. Silence is a liability, not a simplification.

### 2. Convergence eliminates a permanent two-license drift

If the floor is MIT and the runtime converges to Apache-2.0, the end state is MIT floor + Apache runtime — two licenses forever. Built-in drift. If the floor is Apache-2.0, the end state is Apache everywhere — one license, one posture.

### 3. Enterprise and standards-track posture

Identity infrastructure that enterprises bet on ships Apache-2.0: Kubernetes, Kafka, Envoy, Istio, OpenTelemetry, SPIFFE, Keycloak. Reference implementations that reach IETF or W3C standards track ship Apache-2.0 (the DID WG, VC WG, OAuth WG norms). MIT is the license of npm utility libraries. Motebit is positioning as the former. The license is part of the signal.

## Why four years

The four-year conversion reflects a belief: the value of a motebit is its accumulated interior — memory, trust, identity, gradient history — not the code that produces it. Two motebits running identical code diverge over time because their interiors are different. The code is the recipe. The interior is the meal.

After four years, the recipe is free. By then, the network of sovereign agents with compounding trust will be the moat, not the source.

## Quick reference

```
Apache-2.0 (now, any use):  protocol · sdk · crypto · verifier · verify · crypto-appattest ·
                            crypto-android-keystore · crypto-play-integrity · crypto-tpm ·
                            crypto-webauthn · create-motebit · spec · github-action
BSL-1.1 (source-visible):   runtime · engines · apps · services · everything else
BSL → Apache-2.0 conversion: 4 years per version, automatic, irrevocable
End state:                  Apache-2.0 everywhere
```

## Trademarks

Apache-2.0 and BSL-1.1 are copyright licenses. Neither grants rights in the **Motebit** name, the **Liquescentia** name, or the glass-droplet trade dress. See [`TRADEMARK.md`](TRADEMARK.md) for permitted uses (descriptive nominative use, accurate compatibility statements) and what requires written permission (project names, logos, modified-build branding).

## Related documents

- [LICENSE](LICENSE) — the legal license text itself, including the Business Source License Additional Use Grant
- [CLA.md](CLA.md) — Contributor License Agreement; how contributions flow into the dual-license model
- [TRADEMARK.md](TRADEMARK.md) — Motebit name, wordmark, glass-droplet trade dress, and modified-build / fork branding rules
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to submit a contribution under these license terms
