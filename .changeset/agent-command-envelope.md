---
"@motebit/crypto": minor
"motebit": minor
---

Remote command ingress is now fail-closed (daemon-desktop unification, increment 4). `command_request` — previously an unsigned relay-forwarded message every surface trusted implicitly — requires a `signed-request-envelope@1.0` signed by the agent's own identity, audience-bound to the target (`agent-command/{motebit_id}`, registered in the spec's audience-convention table) and digest-bound to the exact `{command, args}` payload.

`@motebit/crypto` gains the convention helpers: `signAgentCommandEnvelope`, `verifyAgentCommandEnvelope` (verdict-shaped, honest rejection reasons), `agentCommandAudience`, `agentCommandPayload`. The relay verifies at ingress against the registered identity key as defense in depth and forwards the envelope verbatim; every consuming surface (CLI daemon, `motebit serve`, desktop, mobile, web, spatial) re-verifies fail-closed before executing — the relay remains a convenience layer, never the trust root.

Breaking only for unsigned senders, of which there are none advertised: the `/command` route was `@internal` with no production callers, so this flip carries no migration window. This closes the product-posture precondition for ever advertising remote-trigger.
