/**
 * Motebit VS Code extension — thin shim that spawns `motebit lsp` over
 * stdio and hands the streams to vscode-languageclient. All of the
 * language-server logic lives in the CLI; this extension is intentionally
 * minimal so Cursor/VS Code/Vim/Neovim/JetBrains all run the same server
 * through their respective LSP integrations.
 *
 * Activation scope: any yaml file. The server filters internally by the
 * file being named motebit.yaml (or motebit.yml); the document filter
 * here is a coarse pre-filter.
 */

import { workspace, type ExtensionContext } from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(_context: ExtensionContext): void {
  const cfg = workspace.getConfiguration("motebit");
  const cliPath = cfg.get<string>("lsp.path", "motebit");

  const serverOptions: ServerOptions = {
    run: {
      command: cliPath,
      args: ["lsp"],
      transport: TransportKind.stdio,
    },
    debug: {
      command: cliPath,
      args: ["lsp"],
      transport: TransportKind.stdio,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "yaml", pattern: "**/motebit.yaml" },
      { scheme: "file", language: "yaml", pattern: "**/motebit.yml" },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/motebit.{yaml,yml}"),
    },
  };

  client = new LanguageClient("motebit", "Motebit", serverOptions, clientOptions);
  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) return undefined;
  return client.stop();
}
