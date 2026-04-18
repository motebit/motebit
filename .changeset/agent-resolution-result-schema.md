---
"@motebit/wire-schemas": minor
---

Publish `agent-resolution-result-v1.json` — the response shape every
external client receives from `GET /api/v1/discover/{motebitId}`.

This is the first schema third-party clients hit when bootstrapping
against the relay: "find this agent." A Python client SDK, a Go test
harness, or a third-party dashboard can now validate the discovery
response against the published JSON Schema and consume `relay_url`,
`public_key`, `settlement_address`, and `resolved_via` fields with
typed confidence — no bundling motebit's TypeScript required.

Federation rules embedded in the type are preserved on the wire:
`resolved_via` carries the loop-prevention audit trail; `cached` +
`ttl` give callers the freshness signals they need to decide whether
to re-query; `settlement_modes` absence is meaningful (caller applies
the spec default `["relay"]`) and explicitly NOT defaulted in the
schema.

Drift defense #23 waiver count: 21 → 20.

Four wire formats now shipped:

- ExecutionReceipt (signed per-task artifact)
- DelegationToken (signed authorization)
- AgentServiceListing (capabilities + pricing + SLA — supply side)
- AgentResolutionResult (relay's discovery response — first contact)

Together: a non-motebit worker can discover agents, advertise its own
listing, receive an authorization, execute, and emit a verifiable
receipt — the full marketplace participation loop validated end-to-end
against published schemas.
