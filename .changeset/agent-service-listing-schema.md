---
"@motebit/wire-schemas": minor
---

Publish `agent-service-listing-v1.json` — the supply-side wire format
for the motebit marketplace. Any external worker (Python, Go, Rust,
Elixir) can now advertise services on the relay by emitting a listing
validated against the published schema and PUTing to the relay's
listing endpoint.

Three wire formats shipped so far in the protocol surface:

- ExecutionReceipt (signed per-task artifact — the trust accumulator)
- DelegationToken (signed authorization — the scoped capability grant)
- AgentServiceListing (capabilities + pricing + SLA — the supply side)

Together these close the loop: a non-motebit worker can publish a
listing, receive a delegation, execute, and emit a verifiable receipt
— the four-step marketplace participation protocol — using only the
three JSON Schemas and an Ed25519 library.
