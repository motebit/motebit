/**
 * motebit.yaml Language Server.
 *
 * Ships three features:
 *   - Diagnostics: every `parseMotebitYaml` error mapped to an LSP Diagnostic.
 *   - Hover:       zod `.describe()` text for the field under the cursor.
 *   - Completion:  field names + enum values, derived from the live zod schema.
 *
 * The zod schema in `../yaml-config.ts` is the single source of truth — no
 * field names, descriptions, or enum values are duplicated here. Adding a
 * new field in yaml-config.ts lights up in hover + completion automatically.
 *
 * Placement: CLI-only (ships with `motebit lsp`). The SDK stays zero-dep;
 * `vscode-languageserver` and `zod-to-json-schema` are CLI dependencies, the
 * same placement argument as `zod` and `yaml` themselves.
 */

import {
  createConnection,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  TextDocumentSyncKind,
  CompletionItemKind,
  MarkupKind,
  type Connection,
  type InitializeResult,
  type CompletionItem,
  type Hover,
  type TextDocumentPositionParams,
  type CompletionParams,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";

import { MotebitYamlObjectSchema, parseMotebitYaml } from "../yaml-config.js";
import { findPathAtOffset } from "./yaml-path.js";
import { enumValues, findDescription, objectKeys, resolvePath } from "./schema-walker.js";

/**
 * Create a motebit.yaml LSP connection over the given streams. Pass
 * `process.stdin`/`process.stdout` for production; pass paired `PassThrough`
 * streams for hermetic tests.
 */
export function createMotebitLanguageServer(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Connection {
  // Wrap the raw streams in reader/writer shims. Passing streams directly
  // opts into vscode-languageserver's "stdio process" mode, which registers
  // `end`/`close` handlers that call `process.exit` — lethal in hermetic
  // tests and unnecessary here because the CLI process already exits when
  // stdin closes.
  const reader = new StreamMessageReader(input);
  const writer = new StreamMessageWriter(output);
  const connection = createConnection(reader, writer);
  const documents = new TextDocuments(TextDocument);

  connection.onInitialize((): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        hoverProvider: true,
        completionProvider: {
          triggerCharacters: [":", " ", "\n", "-"],
          resolveProvider: false,
        },
      },
      serverInfo: { name: "motebit-lsp" },
    };
  });

  documents.onDidChangeContent(async (change) => {
    const diagnostics = await computeDiagnostics(change.document);
    await connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
  });

  connection.onHover((params) => computeHover(documents, params));

  connection.onCompletion((params) => computeCompletion(documents, params));

  documents.listen(connection);
  connection.listen();
  return connection;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export async function computeDiagnostics(doc: TextDocument): Promise<Diagnostic[]> {
  const result = await parseMotebitYaml(doc.getText(), doc.uri);
  if (result.ok) return [];
  const diagnostics: Diagnostic[] = [];
  for (const d of result.diagnostics) {
    const line = d.line != null ? d.line - 1 : 0;
    const col = d.column != null ? d.column - 1 : 0;
    const start = { line, character: col };
    // End-of-line anchor — the parser reports the start of the offending
    // token, so extend to the end of the line for a useful squiggle.
    const end = {
      line,
      character: Math.max(col + 1, doc.getText().split("\n")[line]?.length ?? col + 1),
    };
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: { start, end },
      source: "motebit.yaml",
      message: d.path.length > 0 ? `${formatPath(d.path)}: ${d.message}` : d.message,
    });
  }
  return diagnostics;
}

function formatPath(path: (string | number)[]): string {
  const parts: string[] = [];
  for (const seg of path) {
    if (typeof seg === "number") {
      parts.push(`[${seg}]`);
    } else if (parts.length === 0) {
      parts.push(seg);
    } else {
      parts.push(`.${seg}`);
    }
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export async function computeHover(
  documents: TextDocuments<TextDocument>,
  params: TextDocumentPositionParams,
): Promise<Hover | null> {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return hoverFor(doc, params.position.line, params.position.character);
}

export async function hoverFor(
  doc: TextDocument,
  line: number,
  character: number,
): Promise<Hover | null> {
  const { parseDocument } = await import("yaml");
  const text = doc.getText();
  const parsed = parseDocument(text, { prettyErrors: false });
  const offset = doc.offsetAt({ line, character });
  const ctx = findPathAtOffset(parsed, offset);
  if (ctx == null) return null;
  const description = findDescription(
    resolvePath(MotebitYamlObjectSchema, ctx.path) ?? MotebitYamlObjectSchema,
  );
  if (description == null) return null;
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: description,
    },
  };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export function computeCompletion(
  documents: TextDocuments<TextDocument>,
  params: CompletionParams,
): CompletionItem[] {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return completionsFor(doc, params.position.line, params.position.character);
}

/**
 * Best-effort context-aware completion.
 *
 *   - If the current line is `^\s*KEY:\s*$`, offer enum/boolean values for
 *     that key under the inferred parent.
 *   - Otherwise offer field names of the inferred parent object.
 *
 * "Parent" is inferred by scanning upward for the first line whose leading
 * indent is strictly less than the current line's indent and that starts
 * a key. Top-level (indent 0 context) resolves to the root schema.
 */
export function completionsFor(
  doc: TextDocument,
  line: number,
  character: number,
): CompletionItem[] {
  const text = doc.getText();
  const lines = text.split("\n");
  const curLine = lines[line] ?? "";
  const prefix = curLine.slice(0, character);

  // If we're after "KEY:" (optionally with a space), suggest values.
  const valueMatch = prefix.match(/^(\s*)(-\s+)?([a-zA-Z_][\w-]*)\s*:\s*$/);
  if (valueMatch) {
    const indent = valueMatch[1]!.length + (valueMatch[2] ? valueMatch[2].length : 0);
    const keyName = valueMatch[3]!;
    const parentPath = inferParentPath(lines, line, indent);
    const values = enumValues(MotebitYamlObjectSchema, [...parentPath, keyName]);
    if (values == null) return [];
    return values.map((v) => ({
      label: v,
      kind: CompletionItemKind.EnumMember,
      insertText: ` ${v}`,
    }));
  }

  // Otherwise offer keys of the inferred parent object.
  const indentMatch = prefix.match(/^(\s*)(-\s+)?/);
  const indent = indentMatch
    ? indentMatch[1]!.length + (indentMatch[2] ? indentMatch[2].length : 0)
    : 0;
  const parentPath = inferParentPath(lines, line, indent);
  const keys = objectKeys(MotebitYamlObjectSchema, parentPath);
  if (keys.length === 0) return [];

  // Filter by what the user has already typed on this line.
  const typedKey = prefix.replace(/^\s*(-\s+)?/, "").replace(/:.*$/, "");
  const filtered = typedKey === "" ? keys : keys.filter((k) => k.startsWith(typedKey));

  return filtered.map((k) => {
    const childSchema = resolvePath(MotebitYamlObjectSchema, [...parentPath, k]);
    const description = childSchema ? findDescription(childSchema) : undefined;
    const item: CompletionItem = {
      label: k,
      kind: CompletionItemKind.Property,
      insertText: `${k}: `,
    };
    if (description != null) {
      item.documentation = { kind: MarkupKind.Markdown, value: description };
    }
    return item;
  });
}

/**
 * Infer the path from document root to the object *containing* the cursor.
 * Walks upward from `currentLine - 1`, consuming any `KEY:` line whose
 * indent is strictly less than `currentIndent`, until indent 0. Array
 * bullets (`- key:`) are treated as starting a new element.
 */
function inferParentPath(
  lines: string[],
  currentLine: number,
  currentIndent: number,
): (string | number)[] {
  const stack: { indent: number; key: string; isArray: boolean }[] = [];
  for (let i = currentLine - 1; i >= 0; i--) {
    const raw = lines[i] ?? "";
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const m = raw.match(/^(\s*)(-\s+)?([a-zA-Z_][\w-]*)\s*:/);
    if (!m) continue;
    const indent = m[1]!.length;
    const arrayBullet = m[2] != null;
    const key = m[3]!;
    const effectiveIndent = indent + (arrayBullet ? m[2]!.length : 0);
    if (effectiveIndent >= currentIndent) continue;
    stack.unshift({ indent: effectiveIndent, key, isArray: arrayBullet });
    if (effectiveIndent === 0) break;
  }
  // Flatten: every KEY becomes a key path segment; array bullets insert a
  // "0" index to descend into the element schema.
  const path: (string | number)[] = [];
  for (let i = 0; i < stack.length; i++) {
    const cur = stack[i]!;
    path.push(cur.key);
    // If the next frame is a bulleted line, we crossed into an array element.
    const next = stack[i + 1];
    if (next && next.isArray) path.push(0);
  }
  // If the current line itself is a bulleted line at `currentIndent`, we're
  // inside an array element of the deepest parent.
  // (The caller already accounts for indent, so nothing extra needed here.)
  return path;
}
