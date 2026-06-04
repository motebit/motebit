---
"@motebit/protocol": minor
"@motebit/state-export-client": minor
---

Add `motebit/agent-revocation@1.0` — operator de-listing of agents from the relay's discovery registry, made sovereign-verifiable. A permissionless registry accumulates junk (spam, abandoned test agents, abusive capabilities) and the only automatic remedy is the 90-day no-heartbeat TTL — too slow for live abuse. The operator needs a de-list tool, but a silent de-list is exactly the trust root the relay is forbidden from being (`services/relay/CLAUDE.md` rule 6). So the power is made accountable, not refused: every revoke/reinstate is a signed, reasoned, publicly-fetchable record against the relay's pinned key — declared posture → proven posture.

Invariants: **de-list, not de-identify** (sets `agent_registry.revoked`, which Discover filters; identity/key/succession/receipts stay served — distinct from identity revocation, which anchors an on-chain memo); **hygiene, not curation** (discovery stays permissionless); **operator-only** (master token; agents self-deregister, never de-list a peer); reversible + append-only.

- `@motebit/protocol`: `AgentRevocationReason` (ninth registered registry, full eight-artifact set + gate `check-agent-revocation-reason-canonical`), `AgentRevocationRecord` / `AgentRevocationFeed` / `AgentRevocationActor` signed wire types, `AGENT_REVOCATION_SUITE` / `AGENT_REVOCATION_SPEC_ID`. Additive — no existing export changes.
- `@motebit/state-export-client`: portable `verifyAgentRevocationRecord` / `verifyAgentRevocationFeed` against the relay's pinned key (same key as `verifyTransparencyDeclaration`). Additive.

Spec: `spec/agent-revocation-v1.md` (25th spec). Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §8. The relay producer + wire-schemas (both ignored packages) ride the sibling `-ignored` changeset.
