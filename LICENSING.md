# Licensing

Motebit uses a dual-license model: an open protocol layer and a source-available runtime.

## Protocol Layer — MIT License

The protocol specification, type definitions, identity verification, and scaffolding are MIT-licensed. Use them for any purpose, including commercial, without restriction.

| Package                    | npm                 | Purpose                                              |
| -------------------------- | ------------------- | ---------------------------------------------------- |
| `spec/`                    | —                   | Identity, execution-ledger, federation, market specs |
| `packages/protocol/`       | `@motebit/protocol` | Network protocol types (0 deps)                      |
| `packages/sdk/`            | `@motebit/sdk`      | Full type vocabulary (re-exports protocol)           |
| `packages/crypto/`         | `@motebit/crypto`   | Standalone signature verification (0 deps)           |
| `packages/create-motebit/` | `create-motebit`    | Identity scaffolding CLI (0 deps)                    |
| `packages/github-action/`  | —                   | GitHub Action for identity verification              |

These components have their own `LICENSE` files. They are **not** subject to the Business Source License.

## Runtime Layer — Business Source License 1.1

Everything else is licensed under BSL-1.1. The source is fully visible — you can read, audit, learn from, and contribute to it.

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
`crypto` · `core-identity` · `identity-file` · `policy` · `policy-invariants` · `privacy-layer`

**Infrastructure:**
`event-log` · `persistence` · `browser-persistence` · `sync-engine` · `tools` · `voice` · `render-engine` · `mcp-client` · `mcp-server`

**Economic layer:**
`market` · `semiring`

**Runtime:**
`runtime`

**Applications:**
`cli` · `desktop` · `mobile` · `web` · `admin` · `spatial`

**Services:**
`api` · `proxy` · `embed` · `summarize` · `web-search` · `read-url`

## Conversion

Every version of the BSL-licensed code converts to the **Apache License, Version 2.0** four years after its publication date. Once converted, the code is permanently Apache 2.0 — permissive, no restrictions, with an explicit patent grant from every contributor.

This applies to the entire runtime layer uniformly. There are no tiered conversion dates.

The conversion is automatic under the terms of BSL-1.1. It cannot be revoked.

## Why Apache 2.0 (not MIT)

The protocol layer is MIT because protocols need maximum simplicity for adoption. The runtime layer converts to Apache 2.0 — not MIT — because motebit deals with agent identity, trust algebra, and delegation protocols. These are domains where patents exist.

Apache 2.0 includes an explicit, irrevocable patent grant from every contributor. If a company contributes to the codebase and later tries to patent claims against users, they automatically lose their license. This protects the entire ecosystem — every motebit operator, every agent in the network.

MIT is silent on patents. For type definitions and verification utilities, that's fine. For a sovereign identity runtime that enterprises will depend on, patent clarity matters.

## Why four years

The four-year conversion reflects a belief: the value of a motebit is its accumulated interior — memory, trust, identity, gradient history — not the code that produces it. Two motebits running identical code diverge over time because their interiors are different. The code is the recipe. The interior is the meal.

After four years, the recipe is free. By then, the network of sovereign agents with compounding trust will be the moat, not the source.

## Quick reference

```
MIT (now, any use):          protocol · sdk · verify · create-motebit · spec · github-action
BSL-1.1 (source-visible):   runtime · engines · apps · services · everything else
BSL → Apache 2.0 conversion: 4 years per version, automatic, irrevocable
```
