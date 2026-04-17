/**
 * motebit.yaml Language Server — roundtrip tests.
 *
 * Two invariants are load-bearing:
 *
 * 1. **Diagnostic fidelity.** When a user mistypes a field, the editor
 *    must show a squiggle in the right place with the zod error text —
 *    the same message `motebit up` would print. Drift here silently
 *    degrades the editor experience and breaks the promise that
 *    motebit.yaml is a first-class, self-describing surface.
 *
 * 2. **Hover ↔ zod `.describe()` parity.** The zod schema is the single
 *    source of truth for field documentation. A hover that doesn't
 *    match the zod description means a second source of truth has
 *    crept in — the exact drift the drift-defense for this feature
 *    is designed to prevent.
 *
 * These tests drive a full LSP over paired PassThrough streams using
 * vscode-jsonrpc (no `vscode` module), so the same transport the VS
 * Code extension uses in production is exercised in CI.
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as rpc from "vscode-jsonrpc/node";
import { createMotebitLanguageServer } from "../lsp/server.js";

interface LspClient {
  connection: rpc.MessageConnection;
  nextDiagnostics: () => Promise<{
    uri: string;
    diagnostics: Array<{
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      message: string;
      severity?: number;
    }>;
  }>;
  close: () => void;
}

async function startLspSession(): Promise<LspClient> {
  // client → server: client writes, server reads.
  const clientToServer = new PassThrough();
  // server → client: server writes, client reads.
  const serverToClient = new PassThrough();

  createMotebitLanguageServer(clientToServer, serverToClient);

  const connection = rpc.createMessageConnection(
    new rpc.StreamMessageReader(serverToClient),
    new rpc.StreamMessageWriter(clientToServer),
  );

  // Diagnostics are push notifications. Queue them so callers can
  // await the next one after a didOpen/didChange.
  const diagnosticsQueue: Array<{
    uri: string;
    diagnostics: Array<{
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      message: string;
      severity?: number;
    }>;
  }> = [];
  const waiters: Array<(v: (typeof diagnosticsQueue)[number]) => void> = [];
  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const p = params as (typeof diagnosticsQueue)[number];
    const w = waiters.shift();
    if (w) w(p);
    else diagnosticsQueue.push(p);
  });

  connection.listen();

  await connection.sendRequest("initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  });
  await connection.sendNotification("initialized", {});

  return {
    connection,
    nextDiagnostics: () => {
      const pending = diagnosticsQueue.shift();
      if (pending) return Promise.resolve(pending);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    close: () => {
      connection.dispose();
      clientToServer.destroy();
      serverToClient.destroy();
    },
  };
}

describe("motebit lsp", () => {
  let client: LspClient;

  beforeEach(async () => {
    client = await startLspSession();
  });

  afterEach(() => {
    client.close();
  });

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  it("publishes a diagnostic for a routine with an invalid `every`", async () => {
    const uri = "file:///tmp/motebit.yaml";
    const text = `version: 1
routines:
  - id: bad-interval
    prompt: "anything"
    every: "not-an-interval"
`;

    void client.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "yaml", version: 1, text },
    });

    const { diagnostics } = await client.nextDiagnostics();
    expect(diagnostics.length).toBeGreaterThan(0);

    const everyDiag = diagnostics.find((d) => d.message.toLowerCase().includes("interval"));
    expect(everyDiag).toBeDefined();
    // Must point at the `every:` line — yaml line 5 (0-indexed: 4).
    expect(everyDiag!.range.start.line).toBe(4);
    // Must identify the field path so an editor can group or filter.
    expect(everyDiag!.message).toMatch(/routines\[0\]\.every/);
    // No trailing stack trace or TypeScript internals leaked.
    expect(everyDiag!.message).not.toMatch(/at Object\.|\.ts:\d+:\d+/);
  });

  it("publishes zero diagnostics for a valid minimal document", async () => {
    const uri = "file:///tmp/minimal.yaml";
    void client.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "yaml", version: 1, text: "version: 1\n" },
    });
    const { diagnostics } = await client.nextDiagnostics();
    expect(diagnostics).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Hover
  // -------------------------------------------------------------------------

  it("resolves hover on `every:` to the zod-described interval semantics", async () => {
    const uri = "file:///tmp/hover.yaml";
    const text = `version: 1
routines:
  - id: daily
    prompt: "hello"
    every: 1h
`;
    void client.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "yaml", version: 1, text },
    });
    await client.nextDiagnostics(); // drain

    // Cursor on the `every` key (line index 4, inside the word "every").
    // Line 4: `    every: 1h` — `every` starts at column 4, so char=5 is inside.
    const hover = (await client.connection.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 4, character: 5 },
    })) as { contents: { kind: string; value: string } | string | Array<unknown> } | null;

    expect(hover).not.toBeNull();
    const value = extractHoverValue(hover);
    // The zod `.describe()` on the routine `every` field talks about
    // the run cadence; assertion is specific enough to catch a missing
    // description but loose enough to survive copy edits.
    expect(value.toLowerCase()).toMatch(/cadence|interval/);
  });

  it("resolves hover on the top-level `version` key to the schema version description", async () => {
    const uri = "file:///tmp/version-hover.yaml";
    const text = `version: 1\n`;
    void client.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "yaml", version: 1, text },
    });
    await client.nextDiagnostics();

    const hover = (await client.connection.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: 2 },
    })) as { contents: { value: string } | string } | null;
    expect(hover).not.toBeNull();
    const value = extractHoverValue(hover);
    expect(value.toLowerCase()).toMatch(/version/);
  });
});

/**
 * LSP hover responses have three shapes per the protocol:
 *   - MarkupContent:     { contents: { kind, value } }
 *   - MarkedString:      { contents: string }
 *   - MarkedString[]:    { contents: string[] }
 * Normalize to a single string for assertion.
 */
function extractHoverValue(hover: unknown): string {
  if (hover == null || typeof hover !== "object") return "";
  const contents = (hover as { contents?: unknown }).contents;
  if (contents == null) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(String).join("\n");
  if (typeof contents === "object" && "value" in contents) {
    return String((contents as { value: unknown }).value);
  }
  return "";
}
