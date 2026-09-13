---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Task admission — priced work enters through the relay's gate (`docs/doctrine/task-admission.md`).

`@motebit/protocol`: new `TokenAudience` registry entry `task:dispatch` (`TASK_DISPATCH_AUDIENCE`) — the relay-signed per-task admission artifact a worker requires before running `motebit_task` (`mid` = worker, `sub` = relay task id). Registry append; no wire-format change to existing audiences.

`@motebit/crypto`: `SignedTokenPayload` and `MintAudienceTokenInput` gain an optional JWT `sub` (subject) claim, carried under the signature and omitted when absent. Additive — every existing audience is unaffected, and `verifySignedToken` behavior is unchanged.

Consumers in this repo (private packages, no changeset): `@motebit/mcp-server` `McpServerConfig.taskAdmission` / `ServiceServerConfig.taskAdmission` and the new optional `dispatch_token` argument on `motebit_task` (spec `agent-mcp-surface` §5.1); `@motebit/molecule-runner` exposes `taskAdmission` (code-review and research opt in; the priced-by-default flip is deferred with a recorded trigger and a loud boot warning); the relay attaches the token to every MCP forward and returns it from `POST /agent/:id/task`; the Researcher forwards it to its atoms.
