---
"motebit": minor
"@motebit/vscode": minor
---

Add `motebit lsp` — a Language Server for `motebit.yaml`. Ships three
features derived from the live zod schema in `apps/cli/src/yaml-config.ts`:
diagnostics (every `parseMotebitYaml` error mapped to an LSP Diagnostic),
hover (`.describe()` text for the field under the cursor), and completion
(field names + enum values). Because it speaks LSP, Cursor, Vim/Neovim,
and JetBrains IDEs pick it up without a per-editor plugin; a thin VS Code
extension (`apps/vscode`) spawns `motebit lsp` over stdio for VS Code /
Cursor users.

New drift defense #20 (`yaml-config.test.ts`) enumerates every schema
field and asserts each has a non-empty `.describe()` — a new field shipped
without hover documentation fails CI.
