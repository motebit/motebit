---
---

Workspace-private producers: `handleAgentTask` (`@motebit/runtime`) and `buildServiceReceipt` (`@motebit/mcp-server`) no longer lose the parent receipt when a hire's old child receipt holds an unpaired UTF-16 surrogate — the child is dropped from `delegation_receipts` (the runtime logs it) and the parent is signed. No release.
