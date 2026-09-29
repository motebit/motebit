---
"@motebit/mcp-server": major
"@motebit/mcp-client": major
"@motebit/planner": patch
"@motebit/runtime": patch
"@motebit/web-search": patch
---

MCP caller tokens are bound to their target and single-use (#957). Sibling: `mcp-caller-token-audience-957.md` (its `## Migration` section, including the paid-then-refused cost for an older sovereign-path planner, applies here).

- `@motebit/mcp-server`: `verifyCallerToken` accepts a `motebit:` bearer only when `aud` is `mcp:call`, `sub` is this server's `motebit_id`, the signature and expiry hold with at most `MAX_MCP_CALLER_TOKEN_LIFETIME_MS` (2 min: the 60 s mint lifetime plus a 60 s clock-skew allowance; `iat` at most 60 s ahead), the `jti` is at most 128 characters, and the `(mid, jti)` pair has not been accepted before. The law is `caller-token.ts` (`checkMcpCallerClaims`, `MemoryCallerTokenReplayStore`). The store keeps fixed-size SHA-256 digests, sweeps by expiry order (amortized, never an O(n) scan), holds at most 100,000 live tokens and 1,000 per caller, and refuses rather than forgets, with a distinct reason per bound (`token already used`, `too many live tokens for this caller`, `replay store at capacity — retry shortly`). Only a token that passed key lookup, signature and window takes a slot. `CallerTokenReplayStore.claim` now takes a `CallerReplayEntry` and returns a `CallerReplayClaim`. A shared store can be injected as `callerReplayStore` for a multi-instance deployment. Every refusal is a 401 with `{ error: "invalid motebit token", reason }`. The relay's `task:dispatch` bearer path is unchanged.
- `@motebit/mcp-client`: a motebit server connection mints a fresh `mcp:call` token per HTTP request (a per-request `fetch`, no static header), with `sub` set to the target's `motebit_id`. The id comes from the new `motebitId` config field, or from the server's `/health` on first contact; it is pinned once `motebit_identity` confirms it, and a server that identifies as a different id is refused. A signing failure now fails the request instead of sending it unauthenticated. Breaking for configurations that relied on the old static header.
- `@motebit/planner`: the sovereign delegation path mints a fresh `mcp:call` token per MCP request, bound to the candidate's `motebit_id`, and reports a worker's 401 reason instead of "did not initialize a session".
- `@motebit/runtime`: the planner's injected minter type carries `sub`.
- `@motebit/web-search`: the read-url hop binds caller tokens to the target it submitted the task for (`subDelegateClientConfig`).

## Migration

Before (`@motebit/mcp-client` and any hand-written caller): one token per session, any audience.

```ts
const { token } = await mintAudienceToken({ mid, did, aud: "task:submit" }, key);
// sent as a static header on every request of the session
```

After: one token per HTTP request, `mcp:call`, bound to the target server.

```ts
const { token } = await mintAudienceToken(
  { mid, did, aud: MCP_CALL_AUDIENCE, sub: serverMotebitId },
  key,
);
```

`McpClientAdapter` does this for you; pass `motebitId` when you already know the target (a relay listing), otherwise it is learned from `/health` and pinned. A server behind several instances should inject a shared `callerReplayStore`. Rationale: the pre-#957 shape let any token a motebit signed authenticate it at every MCP server, repeatedly; a window that still accepted it would leave that open. An older sovereign-path planner that pays a new worker first is refused after paying (see the sibling changeset).
