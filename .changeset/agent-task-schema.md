---
"@motebit/wire-schemas": minor
---

Publish `agent-task-v1.json` — the task envelope every executing agent
receives. The "execute" link in the marketplace participation loop:

```
discover → advertise → authorize → EXECUTE → emit receipt
                                   ───────
```

A non-motebit worker (Python, Go, Rust) can now validate incoming task
payloads against the published JSON Schema BEFORE committing to run
anything: bad lifecycle status, unknown DeviceCapability, malformed
invocation_origin all reject at the schema layer, before any tool gets
spawned or any LLM call gets billed.

Two facets the schema enforces strictly:

- `required_capabilities` is a closed enum (the seven DeviceCapability
  values from @motebit/protocol). Free-form capability strings reject —
  the protocol refuses to dispatch tasks no agent can satisfy.
- `invocation_origin` and `delegated_scope` echo through into the
  ExecutionReceipt's signed body. The wire schema accepts them
  faithfully so the executor can stamp a receipt that verifies against
  the original delegation chain.

Drift defense #23 waiver count: 20 → 19.

Five wire formats now shipped, fully covering the participation loop:

- AgentResolutionResult (relay's discovery response — first contact)
- AgentServiceListing (capabilities + pricing + SLA — supply side)
- DelegationToken (signed authorization — scoped capability grant)
- AgentTask (task envelope — what the executor receives)
- ExecutionReceipt (signed per-task artifact — proof of work)

A non-motebit worker can now traverse the entire loop end-to-end
using only these five JSON Schemas + an Ed25519 library.
