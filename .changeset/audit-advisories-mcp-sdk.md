---
"motebit": patch
---

Raise the `@modelcontextprotocol/sdk` floor to `^1.31.0` (resolves 1.32.1) to close GHSA-6qxp-vccf-f47h (high), which affects `>=1.12.0 <1.31.0`. Same major, no API change for the CLI; the transitive `fast-uri` and `ip-address` copies under the SDK are also moved to their patched releases by root overrides.
