---
"@motebit/protocol": minor
"@motebit/wire-schemas": minor
"@motebit/api": minor
---

Per-agent settlement anchoring becomes a first-class protocol artifact.

The `/api/v1/settlements/:id/anchor-proof` and `/api/v1/settlement-anchors/:batchId`
endpoints shipped on 2026-04-18 returned ad-hoc shapes with no spec, no
JSON Schema, and no protocol type. This pass closes the full doctrinal
stack so the worker-audit pyramid (signed `SettlementRecord` floor +
Merkle inclusion proof + onchain anchor ceiling) is externally legible
without bundling motebit:

- **Spec:** `spec/agent-settlement-anchor-v1.md` — parallel artifact to
  `credential-anchor-v1.md`. Defines leaf hash (whole signed
  `SettlementRecord` including signature), batch wire format,
  proof wire format, verification algorithm, and §9 distinguishing
  per-agent from federation (relay-federation-v1.md §7.6) and
  credential anchoring. Cross-references §7.6 for the shared Merkle
  algorithm — same precedent credential-anchor uses.

- **Protocol types** (`@motebit/protocol`): `AgentSettlementAnchorBatch`,
  `AgentSettlementAnchorProof`, `AgentSettlementChainAnchor`. Same
  shape grammar as the credential-anchor pair so verifiers built for
  one work for the other with a field-name swap.

- **Wire schemas** (`@motebit/wire-schemas`): published
  `agent-settlement-anchor-batch-v1.json` and
  `agent-settlement-anchor-proof-v1.json` JSON Schemas at stable `$id`
  URLs. A non-motebit Python/Go/Rust verifier consumes them at the
  URL and validates without any monorepo dependency. Drift gate #22
  pins them; gates #9 and #23 ensure spec ↔ TS ↔ JSON Schema parity.

- **Endpoint shape aligned to spec.** The 2026-04-18 endpoints used
  `{leaf_hash, proof, ...}` (older federation-style vocabulary).
  Per-agent now matches the credential-anchor convention:
  `{settlement_hash, siblings, layer_sizes, relay_id,
 relay_public_key, suite, batch_signature, anchor: {...} | null}`.
  Hours-old code, zero external consumers, alignment matters more
  than churn.

- **Architecture page** lists the new spec (`check-docs-tree` enforces).

- **Test setup** for per-agent anchoring uses the test relay's actual
  identity from `relay_identity` instead of synthesizing a fresh
  keypair — the proof-serve path looks up the relay's public key from
  that table, so this tests the production wiring end-to-end.

- **Cosmetic regen** of 14 previously-committed JSON Schemas to match
  the canonical `build-schemas` output (compact arrays expanded to
  one-element-per-line). Drift test was tolerant of the difference
  but the next `build-schemas` run would have surfaced them anyway.
