/**
 * Repo task — the frozen two-tool registry (docs/proposals/governed-repo-change-v1.md
 * § "The chain", step 4, "Tools: exactly two, frozen").
 *
 * The run's tools are built ONLY from a verified scope: the tick's capability
 * list (⊆ {repo_read_blob, repo_write_path}) chooses which exist, and the
 * repo-task scope's `allowed_paths` and `max_changed_files` are closed over
 * by the write handler. No builtin, MCP or delegation tool can stand in for
 * one: these have their own names, are constructed here and nowhere else,
 * and the run asserts on every model call that what it offers is exactly
 * what was constructed, by object identity, never by name.
 *
 * I/O is two ports (adapter pattern; the runtime is Ring 1):
 *   - `RepoTreeReader` — the tip's tree and blobs, read through git, never the
 *     filesystem (Node adapter: `apps/cli/src/repo-task/git-tree-reader.ts`);
 *   - `RepoPathWriter` — writes inside the worktree, refusing a symlink
 *     component and anything whose real path leaves the worktree (Node
 *     adapter: `apps/cli/src/repo-task/worktree-writer.ts`).
 * Every refusal that can be decided without I/O is decided here, BEFORE a
 * port is touched. A refusal is `denied`; a port that throws is `failed`.
 */

import type { RepoChangeTool, RepoTaskScope, ToolDefinition, ToolResult } from "@motebit/protocol";
import { RiskLevel } from "@motebit/protocol";

/** One entry of the tip's tree at a path, as git records it. */
export interface RepoTreeEntry {
  /** `blob` (a regular file, 100644 or 100755), `symlink` (120000), `gitlink` (160000) or `tree`. */
  readonly kind: "blob" | "symlink" | "gitlink" | "tree";
  /** Six octal digits. */
  readonly mode: string;
  /** Object id, lowercase hex. */
  readonly oid: string;
}

/** The tip's tree, read through git. Never the working tree, never the filesystem. */
export interface RepoTreeReader {
  /** The entry tracked at the tip for exactly this path, or `null` when nothing is tracked there. */
  lookup(path: string): Promise<RepoTreeEntry | null>;
  /** The bytes of a blob reached through `lookup`. */
  readBlob(oid: string): Promise<Uint8Array>;
}

/** Why the writer refused a write (each is a `denied` call). */
export type RepoPathWriteRefusal =
  /** A component of the path is a symlink in the worktree. */
  | "symlink_component"
  /** The path's real location is outside the worktree. */
  | "outside_worktree"
  /** Something other than a regular file (a directory, a socket) is at the path. */
  | "not_a_regular_file"
  /** A directory on the path does not exist (the writer creates files, never directories). */
  | "missing_directory";

export type RepoPathWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly refusal: RepoPathWriteRefusal };

/** Writes one file inside the worktree, by its real path. */
export interface RepoPathWriter {
  write(path: string, content: Uint8Array): Promise<RepoPathWriteResult>;
}

/** What a scope-built handler did: its receipt status and the result the model sees. */
export interface RepoTaskToolOutcome {
  readonly status: "completed" | "failed" | "denied";
  readonly result: ToolResult;
}

/** A handler constructed from the verified scope. Its object identity is what the run asserts. */
export interface RepoTaskToolHandler {
  readonly name: RepoChangeTool;
  invoke(args: Record<string, unknown>): Promise<RepoTaskToolOutcome>;
}

/** One offered tool: the definition the model sees and the handler that runs it. */
export interface RepoTaskToolEntry {
  readonly definition: ToolDefinition;
  readonly handler: RepoTaskToolHandler;
}

/** The frozen registry: built once, never mutated. */
export interface RepoTaskToolRegistry {
  readonly entries: readonly RepoTaskToolEntry[];
}

/**
 * What the run captured at construction and asserts against on every model
 * call: tool name → the exact entry object constructed for it.
 */
export type RepoTaskExpectedTools = ReadonlyMap<string, RepoTaskToolEntry>;

const ENCODER = new TextEncoder();
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const REGULAR_FILE_MODE = "100644";

const deny = (error: string): RepoTaskToolOutcome => ({
  status: "denied",
  result: { ok: false, error },
});

/**
 * A read path: repository-relative, no empty, `.` or `..` segment, no NUL, no
 * leading `/`. Looser than the scope's canonical rule (any tracked blob may be
 * read), and only a shape check: the tree lookup is what decides.
 */
function isReadablePath(p: string): boolean {
  if (p.length === 0 || p.includes("\0") || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function buildReadBlob(reader: RepoTreeReader): RepoTaskToolEntry {
  const handler: RepoTaskToolHandler = Object.freeze({
    name: "repo_read_blob" as const,
    async invoke(args: Record<string, unknown>): Promise<RepoTaskToolOutcome> {
      const path = args.path;
      if (typeof path !== "string" || !isReadablePath(path)) {
        return deny("repo_read_blob: path must be a repository-relative path");
      }
      const entry = await reader.lookup(path);
      if (entry === null) return deny(`repo_read_blob: ${path} is not tracked at the tip`);
      if (entry.kind !== "blob") {
        return deny(`repo_read_blob: ${path} is a ${entry.kind}, not a file`);
      }
      const bytes = await reader.readBlob(entry.oid);
      let content: string;
      try {
        content = STRICT_UTF8.decode(bytes);
      } catch {
        return {
          status: "failed",
          result: { ok: false, error: `repo_read_blob: ${path} is not UTF-8 text` },
        };
      }
      return {
        status: "completed",
        result: { ok: true, data: { path, mode: entry.mode, blob: entry.oid, content } },
      };
    },
  });
  const definition: ToolDefinition = Object.freeze({
    name: "repo_read_blob",
    mode: "api",
    description:
      "Read one file tracked in the repository at the commit the task starts from. Returns its text.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        path: Object.freeze({ type: "string", description: "Repository-relative path" }),
      }),
      required: Object.freeze(["path"]),
      additionalProperties: false,
    }),
    riskHint: Object.freeze({ risk: RiskLevel.R0_READ }),
  });
  return Object.freeze({ definition, handler });
}

function buildWritePath(
  scope: RepoTaskScope,
  writer: RepoPathWriter,
  reader: RepoTreeReader,
): RepoTaskToolEntry {
  // Closed over the exact allowed path strings, copied and frozen: nothing the
  // scope object does later can widen them.
  const allowed: ReadonlySet<string> = new Set([...scope.allowed_paths]);
  const maxChanged = scope.max_changed_files;
  const written = new Set<string>();
  const handler: RepoTaskToolHandler = Object.freeze({
    name: "repo_write_path" as const,
    async invoke(args: Record<string, unknown>): Promise<RepoTaskToolOutcome> {
      const path = args.path;
      const content = args.content;
      // Byte-exact membership, before any I/O. The allowed paths are ASCII
      // (canonical rule), so string equality is byte equality.
      if (typeof path !== "string" || !allowed.has(path)) {
        return deny("repo_write_path: the path is not one of the scope's allowed paths");
      }
      if (typeof content !== "string") return deny("repo_write_path: content must be a string");
      if (content.includes("\0")) return deny("repo_write_path: content contains a NUL byte");
      if (!written.has(path) && written.size >= maxChanged) {
        return deny(`repo_write_path: the scope allows at most ${maxChanged} changed file(s)`);
      }
      // A tracked path must stay a regular 100644 file: writing over a
      // symlink, submodule, directory or executable would change its kind or
      // mode, which the scope never authorizes.
      const tracked = await reader.lookup(path);
      if (tracked !== null && (tracked.kind !== "blob" || tracked.mode !== REGULAR_FILE_MODE)) {
        return deny(`repo_write_path: ${path} is tracked as ${tracked.kind} ${tracked.mode}`);
      }
      const bytes = ENCODER.encode(content);
      const outcome = await writer.write(path, bytes);
      if (!outcome.ok) return deny(`repo_write_path: refused (${outcome.refusal})`);
      written.add(path);
      return { status: "completed", result: { ok: true, data: { path, bytes: bytes.length } } };
    },
  });
  const definition: ToolDefinition = Object.freeze({
    name: "repo_write_path",
    mode: "api",
    description:
      "Write the full text of one file. Only these paths may be written: " +
      [...allowed].join(", ") +
      ".",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        path: Object.freeze({ type: "string", enum: Object.freeze([...allowed]) }),
        content: Object.freeze({ type: "string", description: "The file's complete new text" }),
      }),
      required: Object.freeze(["path", "content"]),
      additionalProperties: false,
    }),
    riskHint: Object.freeze({ risk: RiskLevel.R2_WRITE }),
  });
  return Object.freeze({ definition, handler });
}

/**
 * Build the frozen registry from a verified scope. `tools` is the tick's
 * capability set (as `checkRepoTaskAuthority` returned it); only those tools
 * exist. Returns the registry and the expected entries the run asserts
 * against — the same objects, captured here.
 */
export function buildRepoTaskTools(
  tools: ReadonlySet<RepoChangeTool>,
  scope: RepoTaskScope,
  ports: { readonly reader: RepoTreeReader; readonly writer: RepoPathWriter },
): { registry: RepoTaskToolRegistry; expected: RepoTaskExpectedTools } {
  const entries: RepoTaskToolEntry[] = [];
  // Fixed order, independent of the tick's spelling.
  if (tools.has("repo_read_blob")) entries.push(buildReadBlob(ports.reader));
  if (tools.has("repo_write_path")) entries.push(buildWritePath(scope, ports.writer, ports.reader));
  const registry: RepoTaskToolRegistry = Object.freeze({ entries: Object.freeze(entries) });
  const expected = new Map(entries.map((e) => [e.definition.name, e] as const));
  return { registry, expected };
}

/** Raised when the offered tools differ from the constructed ones; the run aborts. */
export class RepoTaskToolMismatchError extends Error {
  constructor(detail: string) {
    super(`repo task: the offered tools are not the scope's: ${detail}`);
    this.name = "RepoTaskToolMismatchError";
  }
}

/**
 * Assert the offered entries are exactly the constructed ones: same count,
 * every entry the very object built for its name, its definition and handler
 * the very objects too, and the names exactly the authorized set. Identity,
 * never name: a same-named stand-in fails.
 */
export function assertOfferedTools(
  offered: readonly RepoTaskToolEntry[],
  expected: RepoTaskExpectedTools,
  authorized: ReadonlySet<RepoChangeTool>,
): void {
  if (offered.length !== expected.size || expected.size !== authorized.size) {
    throw new RepoTaskToolMismatchError(
      `${offered.length} offered, ${expected.size} constructed, ${authorized.size} authorized`,
    );
  }
  const seen = new Set<string>();
  for (const entry of offered) {
    const name = entry.definition.name;
    const want = expected.get(name);
    if (
      want === undefined ||
      entry !== want ||
      entry.definition !== want.definition ||
      entry.handler !== want.handler ||
      entry.handler.name !== name ||
      !(authorized as ReadonlySet<string>).has(name) ||
      seen.has(name)
    ) {
      throw new RepoTaskToolMismatchError(`${JSON.stringify(name)} is not the constructed tool`);
    }
    seen.add(name);
  }
}
