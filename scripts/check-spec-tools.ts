#!/usr/bin/env tsx
/**
 * check-spec-tools — protocol-faithfulness gate for the MCP tool surface.
 *
 * Promise enforcement, not change detection. The question is "is the
 * reference implementation faithful to the protocol?" — not "did the
 * implementation change?". A baseline file would re-cast it as the
 * latter and miss the load-bearing case (a spec promise that was never
 * served by any implementation).
 *
 * Three rules, derived live from spec + annotation + impl tree:
 *
 *   (a) promise-not-served — a spec declares a tool name in a
 *       "#### Tools (foundation law)" block but no implementation
 *       annotates a matching tool with @spec <that-spec-id>.
 *   (b) orphan-annotation — an implementation annotates a tool with
 *       @spec X but spec X does not declare that tool name in any
 *       "#### Tools (foundation law)" block.
 *   (c) unclassified — a public tool construct (a builtin
 *       ToolDefinition under packages/tools/src/builtins/, or a
 *       server.tool(...) call inside packages/mcp-server/src/index.ts)
 *       carries none of @spec / @internal / @experimental.
 *
 * Plus the @experimental temporal-sanity rule (mirrors
 * check-deprecation-discipline #39):
 *
 *   (d) experimental-incomplete — an @experimental annotation is
 *       missing any of the four-field contract (@since,
 *       @stabilizes_by, @replacement, @reason).
 *   (e) experimental-past-due — @stabilizes_by has elapsed. The
 *       construct must promote to @spec, demote to @internal, or be
 *       removed.
 *
 * Scope (today): the MCP tool surface only. The companion gate
 * check-spec-routes lands later, against the larger 155-route surface,
 * following the same three-layer pattern.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SPEC_DIR = join(REPO_ROOT, "spec");
const BUILTINS_DIR = join(REPO_ROOT, "packages", "tools", "src", "builtins");
const MCP_SERVER_INDEX = join(REPO_ROOT, "packages", "mcp-server", "src", "index.ts");

const TOOLS_HEADER = /^####\s+Tools\s*\(foundation law\)\s*$/i;
const SPEC_TITLE = /^#\s+(motebit\/[a-z0-9-]+@\d+\.\d+)/;
const ANY_HEADER = /^#{1,6}\s+/;
const BULLET_NAME = /^\s*[-*]\s+`([a-z_][a-z0-9_]*)`/;

interface SpecToolDecl {
  specId: string;
  toolName: string;
  file: string;
  line: number;
}

function parseSpecId(content: string): string | null {
  const lines = content.split("\n");
  for (const line of lines) {
    const m = line.match(SPEC_TITLE);
    if (m) return m[1]!;
    if (line.startsWith("#")) break;
  }
  return null;
}

function collectSpecTools(): SpecToolDecl[] {
  const out: SpecToolDecl[] = [];
  const files = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const file = join(SPEC_DIR, f);
    const content = readFileSync(file, "utf-8");
    const specId = parseSpecId(content);
    if (!specId) continue;
    const lines = content.split("\n");
    let inToolsBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (TOOLS_HEADER.test(line)) {
        inToolsBlock = true;
        continue;
      }
      // Any header (other than the Tools (foundation law) header itself) closes the block.
      if (inToolsBlock && ANY_HEADER.test(line)) {
        inToolsBlock = false;
        continue;
      }
      if (inToolsBlock) {
        const m = line.match(BULLET_NAME);
        if (m) {
          out.push({ specId, toolName: m[1]!, file: f, line: i + 1 });
        }
      }
    }
  }
  return out;
}

interface PendingAnnotation {
  type: "spec" | "internal" | "experimental";
  specId?: string;
  experimental?: {
    since?: string;
    stabilizesBy?: string;
    replacement?: string;
    reason?: string;
  };
  line: number;
}

interface ImplToolAnnotation {
  toolName: string;
  classification: "spec" | "internal" | "experimental";
  specId?: string;
  experimental?: PendingAnnotation["experimental"];
  file: string;
  annotationLine: number;
  declarationLine: number;
}

interface ImplToolUnclassified {
  toolName: string;
  file: string;
  line: number;
}

const SINGLE_LINE_ANN = /^\s*\/\*\*\s*@(spec|internal|experimental)(?:\s+([^\s*]+))?\s*\*\/\s*$/;
const JSDOC_OPEN = /^\s*\/\*\*\s*$/;
const JSDOC_CLOSE = /\*\/\s*$/;

const BUILTIN_DECL = /^\s*export\s+const\s+\w+(?:Definition)?\s*:\s*ToolDefinition\s*=\s*\{/;
const NAME_FIELD = /^\s*name:\s*"([a-z_][a-z0-9_]*)"/;
const SERVER_TOOL_INLINE = /server\.tool\(\s*"([a-z_][a-z0-9_]*)"/;
const SERVER_TOOL_OPEN = /^\s*server\.tool\(\s*$/;
const PENDING_TTL_LINES = 12;

function parseJsdocBlock(block: string): PendingAnnotation | null {
  // Single-pass parse — collect all tag/value pairs, then map to a
  // PendingAnnotation. Multi-tag blocks (e.g. an @experimental with
  // @since/@stabilizes_by/@replacement/@reason) are the four-field
  // temporal-sanity contract; the map captures every one.
  const tags: Record<string, string> = {};
  // Use [ \t]* not \s* — \s matches newlines, which would let @experimental
  // (with no value on its own line) swallow the next line's @since tag.
  const re =
    /@(spec|internal|experimental|since|stabilizes_by|replacement|reason)\b[ \t]*([^\n]*)/g;
  for (const m of block.matchAll(re)) {
    const tag = m[1]!.toLowerCase();
    const val = (m[2] ?? "")
      .replace(/\s*\*\/\s*$/, "")
      .replace(/^\s*\*\s*/g, "")
      .trim();
    tags[tag] = val;
  }
  if ("spec" in tags) {
    return { type: "spec", specId: tags.spec || undefined, line: 0 };
  }
  if ("internal" in tags) {
    return { type: "internal", line: 0 };
  }
  if ("experimental" in tags) {
    return {
      type: "experimental",
      experimental: {
        since: tags.since,
        stabilizesBy: tags.stabilizes_by,
        replacement: tags.replacement,
        reason: tags.reason,
      },
      line: 0,
    };
  }
  return null;
}

function scanImplFile(
  file: string,
  content: string,
): { annotations: ImplToolAnnotation[]; unclassified: ImplToolUnclassified[] } {
  const lines = content.split("\n");
  const annotations: ImplToolAnnotation[] = [];
  const unclassified: ImplToolUnclassified[] = [];

  let pending: PendingAnnotation | null = null;

  const consume = (toolName: string, declarationLine: number): void => {
    if (pending && declarationLine - pending.line <= PENDING_TTL_LINES) {
      annotations.push({
        toolName,
        classification: pending.type,
        specId: pending.specId,
        experimental: pending.experimental,
        file,
        annotationLine: pending.line,
        declarationLine,
      });
    } else {
      unclassified.push({ toolName, file, line: declarationLine });
    }
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Single-line JSDoc annotation (`/** @internal */` etc).
    const single = line.match(SINGLE_LINE_ANN);
    if (single) {
      const type = single[1] as "spec" | "internal" | "experimental";
      pending = {
        type,
        specId: type === "spec" ? single[2] : undefined,
        line: i + 1,
      };
      continue;
    }

    // Multi-line JSDoc block — collect until close, then parse.
    if (JSDOC_OPEN.test(line)) {
      let block = "";
      let j = i + 1;
      while (j < lines.length && !JSDOC_CLOSE.test(lines[j]!)) {
        block += lines[j] + "\n";
        j++;
      }
      // Include the closing line too in case it carries a final tag fragment.
      if (j < lines.length) block += lines[j];
      const parsed = parseJsdocBlock(block);
      if (parsed) {
        parsed.line = i + 1;
        pending = parsed;
      }
      i = j;
      continue;
    }

    // Builtin tool declaration: `export const xxxDefinition: ToolDefinition = {`
    if (BUILTIN_DECL.test(line)) {
      // Look ahead for the first `name: "..."` field within a small window.
      for (let k = i + 1; k < Math.min(i + 30, lines.length); k++) {
        const m = lines[k]!.match(NAME_FIELD);
        if (m) {
          consume(m[1]!, k + 1);
          break;
        }
      }
      continue;
    }

    // Synthetic tool declaration: `server.tool("name", ...)` inline form.
    const inlineST = line.match(SERVER_TOOL_INLINE);
    if (inlineST) {
      consume(inlineST[1]!, i + 1);
      continue;
    }
    // Synthetic tool declaration: multi-line form with name on a subsequent line.
    if (SERVER_TOOL_OPEN.test(line)) {
      for (let k = i + 1; k < Math.min(i + 5, lines.length); k++) {
        const m = lines[k]!.match(/^\s*"([a-z_][a-z0-9_]*)"/);
        if (m) {
          consume(m[1]!, k + 1);
          break;
        }
      }
      continue;
    }
  }

  return { annotations, unclassified };
}

function collectImplAnnotations(): {
  annotations: ImplToolAnnotation[];
  unclassified: ImplToolUnclassified[];
} {
  const allAnn: ImplToolAnnotation[] = [];
  const allUn: ImplToolUnclassified[] = [];

  // Builtins — every .ts file under packages/tools/src/builtins/ except the
  // re-export barrel (index.ts) and the path-sandbox helper (no tools).
  const builtinFiles = readdirSync(BUILTINS_DIR).filter(
    (f) => f.endsWith(".ts") && f !== "index.ts" && f !== "path-sandbox.ts",
  );
  for (const f of builtinFiles) {
    const relFile = `packages/tools/src/builtins/${f}`;
    const content = readFileSync(join(BUILTINS_DIR, f), "utf-8");
    const r = scanImplFile(relFile, content);
    allAnn.push(...r.annotations);
    allUn.push(...r.unclassified);
  }

  // Synthetics — all 8 motebit_* tools live in mcp-server/src/index.ts.
  const mcpContent = readFileSync(MCP_SERVER_INDEX, "utf-8");
  const r = scanImplFile("packages/mcp-server/src/index.ts", mcpContent);
  allAnn.push(...r.annotations);
  allUn.push(...r.unclassified);

  return { annotations: allAnn, unclassified: allUn };
}

function parseStabilizesBy(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  // Semver values (e.g. "1.5.0") aren't time-bound and can't be checked
  // against the wall clock — they're enforced by the changeset/release
  // pipeline, not by this gate.
  return null;
}

function main(): void {
  const specTools = collectSpecTools();
  const { annotations, unclassified } = collectImplAnnotations();

  const findings: string[] = [];

  // Index annotations by (specId, toolName) for the spec match-up rules.
  const annBySpecPair = new Map<string, ImplToolAnnotation>();
  for (const a of annotations) {
    if (a.classification === "spec" && a.specId) {
      annBySpecPair.set(`${a.specId}::${a.toolName}`, a);
    }
  }
  const specByPair = new Map<string, SpecToolDecl>();
  for (const s of specTools) specByPair.set(`${s.specId}::${s.toolName}`, s);

  // Rule (a) — spec declares X under Y, no impl annotates @spec Y with X.
  for (const [pair, s] of specByPair) {
    if (!annBySpecPair.has(pair)) {
      findings.push(
        `promise-not-served: spec/${s.file}:${s.line} declares "${s.toolName}" under ${s.specId} but no implementation annotates @spec ${s.specId} on a tool named "${s.toolName}".`,
      );
    }
  }

  // Rule (b) — impl annotates @spec X with tool Y, spec X has no Y.
  for (const [pair, a] of annBySpecPair) {
    if (!specByPair.has(pair)) {
      findings.push(
        `orphan-annotation: ${a.file}:${a.annotationLine} annotates @spec ${a.specId} on tool "${a.toolName}" but ${a.specId} declares no such name in any "#### Tools (foundation law)" block.`,
      );
    }
  }

  // Rule (c) — public tool construct lacks any classification annotation.
  for (const u of unclassified) {
    findings.push(
      `unclassified: ${u.file}:${u.line} tool "${u.toolName}" has no @spec/@internal/@experimental annotation.`,
    );
  }

  // Rule (d) — @experimental four-field contract.
  // Rule (e) — @experimental @stabilizes_by past-due.
  const today = new Date();
  for (const a of annotations) {
    if (a.classification !== "experimental") continue;
    const f = a.experimental ?? {};
    const missing: string[] = [];
    if (!f.since) missing.push("@since");
    if (!f.stabilizesBy) missing.push("@stabilizes_by");
    if (!f.replacement) missing.push("@replacement");
    if (!f.reason) missing.push("@reason");
    if (missing.length > 0) {
      findings.push(
        `experimental-incomplete: ${a.file}:${a.annotationLine} tool "${a.toolName}" @experimental annotation missing ${missing.join(", ")}. Four-field contract required (mirrors check-deprecation-discipline #39).`,
      );
    }
    if (f.stabilizesBy) {
      const d = parseStabilizesBy(f.stabilizesBy);
      if (d && d < today) {
        findings.push(
          `experimental-past-due: ${a.file}:${a.annotationLine} tool "${a.toolName}" @stabilizes_by ${f.stabilizesBy} is past due. Promote to @spec, demote to @internal, or remove.`,
        );
      }
    }
  }

  console.log(
    `check-spec-tools — ${specTools.length} spec-declared tool(s), ${annotations.length} annotation(s), ${unclassified.length} unclassified\n`,
  );

  if (findings.length > 0) {
    console.log(`✗ ${findings.length} finding(s):\n`);
    for (const f of findings) console.log(`  ${f}`);
    console.log(
      `\n  Fix: ensure every public tool has @spec/@internal/@experimental,\n` +
        `       every @spec X cross-references a "#### Tools (foundation law)" entry in spec X,\n` +
        `       every spec-declared tool is implemented under that @spec, and\n` +
        `       every @experimental carries the four-field contract with a not-past-due @stabilizes_by.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ All ${annotations.length} tool annotations align with ${specTools.length} spec declaration(s); no unclassified tools.`,
  );
}

main();
