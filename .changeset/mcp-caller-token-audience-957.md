---
"@motebit/protocol": minor
"motebit": minor
---

MCP caller tokens are bound to the server they are for and accepted once (#957). Sibling: `mcp-caller-token-audience-957-ignored.md` (the server, client and planner change).

`@motebit/protocol`: new `TokenAudience` registry entry `mcp:call` (+ `MCP_CALL_AUDIENCE`). It is the audience of a caller's own signed bearer on an HTTP request to a motebit MCP server: `sub` is the target server's `motebit_id`, and each token (`jti`) is accepted once. Verified by the MCP server; no relay route accepts it. Additive for the registry: existing audiences and relay routes are unchanged.

`motebit`: `motebit serve` over HTTP now accepts a motebit signed token only when its audience is `mcp:call`, it names this motebit as its target (`sub`), it verifies and has not expired, and it has not been used before. Before this fix, `motebit serve` accepted a token your peers signed for any purpose, for any server, as many times as it was shown until it expired. So a token another motebit signed for the relay, or for a different server, let whoever held it call your server as that motebit. The same was true of the tokens your own motebit signs. `/mcp add --motebit` and the other connections your motebit makes now sign a fresh `mcp:call` token for every request, bound to the server's `motebit_id`. The id comes from your config (`motebitId`, pinned after the first verified connect) or, the first time, from the server's `/health`.

## Migration

This is a break for callers of `motebit serve` over HTTP that sign their own tokens, and it has no compatibility window, because a window would leave the hole open.

- A caller on an older `motebit` or `@motebit/mcp-client` (one `task:submit` token per session) is refused with `401 {"error":"invalid motebit token","reason":"token audience \"task:submit\" is not accepted for MCP calls — ..."}`. Upgrade the caller.
- A hand-written caller must mint, for every HTTP request: `{ mid, did, aud: "mcp:call", sub: "<the server's motebit_id>" }` through `mintAudienceToken`, and send it as `Authorization: Bearer motebit:<token>`.
- An upgraded caller still connects to an older server, which checks no audience.
- The relay's forward to a worker (the `task:dispatch` bearer) is unchanged.

See `spec/auth-token-v1.md` 1.2 §7.3 and `spec/agent-mcp-surface-v1.md` 1.4.
