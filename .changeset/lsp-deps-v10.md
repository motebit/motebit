---
"motebit": patch
---

Bump the CLI's LSP transport deps: `vscode-jsonrpc` 8 → 9, `vscode-languageserver`
9 → 10 (tracks LSP protocol 3.18). Only import change: v10 renamed the Node
subpath `vscode-languageserver/node.js` → `vscode-languageserver/node`. All LSP
tests pass unchanged. Also drops a stale `zod-to-json-schema` mention left over
from the zod-4 migration.
