---
"@motebit/mcp-server": major
"@motebit/relay": minor
---

A `task:dispatch` token admits a task; it never authenticates the transport. The relay authenticates to a worker as itself with a relay-signed `mcp:call` token (#981).

- `@motebit/mcp-server`: a worker configured with `relayTrust` (or `taskAdmission`) served any relay-signed `task:dispatch` token bound to it, presented as `Authorization: Bearer motebit:<token>`, as `relay:<did>` at Verified trust. The relay hands that same token to a submitter whenever the submitter is the presenter (`presenter: "submitter"`, or any task the relay did not route), so a submitter, or anyone the token leaked to, was served as the relay. Now the relay path accepts only an `mcp:call` token signed by the PINNED relay key, `sub` = this worker, within the `mcp:call` window, and accepted once (the #957 law, `checkMcpCallerClaims` + the caller replay store, with the pinned relay key in place of a caller-key lookup). A `task:dispatch` bearer is refused with a 401 whose `reason` names the fix; a relay-signed token that fails any other check is refused with a reason too, never passed to the caller path. The dispatch token still admits the task as the `motebit_task` `dispatch_token` argument, unchanged (`admitTask`: one admission, one completed execution).
- `@motebit/relay`: `forwardTaskViaMcp` takes a per-request bearer minter (new trailing parameter) and refuses a forward without one (`task.mcp_forward_refused`, `no_relay_bearer`); the submission route passes `mintRelayMcpBearer(relayIdentity, worker)` (new export: `aud mcp:call`, `mid` = the relay, `sub` = the worker, 60 s). The dispatch token travels only in the `motebit_task` arguments.

Spec: `auth-token-v1.md` 1.3 §7.3 and the audience table; `agent-mcp-surface-v1.md` 1.5 §5.1. Tests: `services/relay/src/__tests__/dispatch-presenter-981.test.ts` (real relay against a real worker: presenter × door × outcome), `packages/mcp-server/src/__tests__/relay-bearer.test.ts`. Tampers: `packages/mcp-server/tamper/dispatch-presenter-981.mjs` (8, all red).

## Migration

This is a coordinated break between the relay and every worker that trusts it. There is no compatibility window, because the old bearer is the hole.

- A worker on this version refuses a forward from an older relay: `401 {"error":"invalid motebit token","reason":"a task:dispatch token admits a task ... it never authenticates the transport ..."}`. The relay logs `task.mcp_forward_failed` (status 401, step `initialize`) and the task gets no receipt from that forward.
- An older worker refuses a forward from this relay: its relay path only knows `task:dispatch`, so the token falls to its caller path, which must resolve the relay's `mid` to a key. The relay's own id is not in its agent registry, so that lookup is expected to fail and the worker answers 401 ("caller key unknown"). This was reasoned from the code, not observed against a deployed older worker.
- Deploy the relay and its first-party workers together. Third-party workers on an older `@motebit/mcp-server` stop receiving relay forwards until they upgrade; the relay logs every such 401 loudly and never retries with another credential.
- A direct presenter is unaffected if it already authenticated as itself (the first-party molecules — research, web-search, code-review — do: their own `mcp:call` bearer, the dispatch token as the argument). A hand-written presenter that sent the dispatch token as its bearer must mint its own `mcp:call` token for each request and pass the dispatch token only as `dispatch_token`.
