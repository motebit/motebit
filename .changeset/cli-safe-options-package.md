---
"motebit": patch
---

Internal: the runtime-host wire→runtime authority-field strip (`verifiedGrant` / `userActionAttestation` / `goalContext` never forwarded from an attached frontend) moved from CLI-local code into `@motebit/runtime-host` (`pickSafeChatOptions` / `pickSafeInvokeOptions`) so the desktop coordinator applies the identical guard. No behavior change at the CLI surface.
