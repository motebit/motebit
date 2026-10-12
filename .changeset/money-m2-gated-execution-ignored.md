---
"@motebit/runtime": patch
"@motebit/mcp-server": patch
---

An R4_MONEY tool's handler is unreachable without a runtime capability. The runtime's tool registry (handlers in an ECMAScript-private map) refuses a money tool unless the call carries a single-use capability bound to that tool name and its exact arguments, minted by the runtime's private minter only on a gate-decided path: `executeToolGated` (presenter- and delegator-bound `verifyGrantForTurn`, the policy gate, the blast-radius meter), the AI loop (a call the gate allowed under a grant `verifyGrantForTurn` produced, then metered) and the approval resume (the exact call the gate paused). `verifyGrantForTurn` takes required `presenter` and `delegator` options and refuses a grant not signed by the verifying runtime's identity (id and CURRENT key — a grant signed under a key the identity has since rotated away from is refused) or presented by anyone but its delegate; new `grantDelegatorIs` / `grantDelegateIs`, and `RuntimeConfig.identityPublicKeyHex` for a runtime built without `signingKeys`. `motebit_task` hands its handler the caller the transport verified.
