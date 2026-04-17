/**
 * `motebit lsp` — launch the motebit.yaml Language Server over stdio.
 *
 * Speaks the Language Server Protocol, so any LSP-aware editor
 * (VS Code, Cursor, Vim/Neovim with coc.nvim / nvim-lspconfig, JetBrains
 * via LSP4IJ) works without a per-editor plugin. The `apps/vscode`
 * extension is a ~30-line shim that just spawns `motebit lsp`.
 *
 * No CLI flags beyond `--help` — LSP clients don't pass CLI args.
 */

import { createMotebitLanguageServer } from "../lsp/server.js";

export function handleLsp(): void {
  // The server owns the process lifecycle: it runs until the client
  // disconnects (editor closes the file / workspace).
  createMotebitLanguageServer(process.stdin, process.stdout);
}
