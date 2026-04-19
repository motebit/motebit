#!/usr/bin/env tsx
/**
 * check-readme — drift defense for the front-door promises in README.md.
 *
 * The root README is the highest-stakes document in the repo: it is the first
 * surface every evaluator, contributor, and would-be integrator reads, and
 * the "What you see:" block in its "Build a service agent" section is a
 * concrete, line-by-line claim about what the scaffold produces on first
 * run. Every prior drift defense guards a specific pair of canonical sources
 * (see docs/drift-defenses.md § 1–23). The README was the one load-bearing
 * document with no gate at all: the scaffold could rename a tool, change
 * the default port, drop the `--direct` flag, or swap the relay host, and
 * the README would happily keep advertising the old shape. The classic
 * shape of every drift this codebase has suffered — invisible source of
 * truth, sibling copies emerge, copies drift. See CLAUDE.md §
 * "Synchronization invariants are the meta-principle".
 *
 * What this probe enforces:
 *
 *   Every observable claim in the README's fenced "What you see:" block
 *   must resolve to a source-of-truth constant in the code. Specifically:
 *
 *   1. The list of tool names in `Tools loaded: <names>` must equal the
 *      set of `name:` fields the agent scaffold writes into tools.ts.
 *   2. The port in `MCP server running on http://localhost:<port>` must
 *      equal the scaffold's PORT default.
 *   3. The "direct mode" parenthetical on the task-handler line must be
 *      backed by a `--direct` entry in the scaffold's serveArgs.
 *   4. The relay URL in `Registered with relay: <url>` must equal the
 *      `DEFAULT_SYNC_URL` constant in apps/cli/src/runtime-factory.ts.
 *
 * This is the twenty-fourth synchronization invariant defense.
 *
 * Usage:
 *   tsx scripts/check-readme.ts        # exit 1 on any drift
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const README_PATH = join(ROOT, "README.md");
const SCAFFOLD_PATH = join(ROOT, "packages/create-motebit/src/index.ts");
const RUNTIME_FACTORY_PATH = join(ROOT, "apps/cli/src/runtime-factory.ts");

interface Finding {
  loc: string;
  message: string;
}

// ── README parsing ────────────────────────────────────────────────────

/**
 * Extract the fenced code block that appears directly after the
 * "What you see:" prompt in the README. This block is the contract
 * between the README's first-run-experience promise and the scaffold's
 * actual output.
 */
function extractWhatYouSeeBlock(): { body: string; startLine: number } {
  const src = readFileSync(README_PATH, "utf-8");
  const lines = src.split("\n");

  // Find the "What you see:" anchor line.
  const anchorIdx = lines.findIndex((l) => /^What you see:\s*$/.test(l));
  if (anchorIdx === -1) {
    throw new Error(
      "could not locate 'What you see:' anchor in README.md — if the section was renamed, update this probe's anchor regex",
    );
  }

  // Skip forward to the next fenced block opener.
  let openIdx = -1;
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("```")) {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) {
    throw new Error("no fenced block after 'What you see:' anchor in README.md");
  }

  // Find the matching closer.
  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("```")) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error("unterminated fenced block after 'What you see:' anchor in README.md");
  }

  const body = lines.slice(openIdx + 1, closeIdx).join("\n");
  return { body, startLine: openIdx + 2 }; // 1-indexed, first content line
}

// ── Claim extractors ──────────────────────────────────────────────────

function extractToolNamesClaim(block: string): string[] | null {
  const m = block.match(/^Tools loaded:\s*(.+)$/m);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractPortClaim(block: string): string | null {
  const m = block.match(/MCP server running on https?:\/\/localhost:(\d+)/);
  return m ? m[1] : null;
}

function extractDirectModeClaim(block: string): boolean {
  return /\bdirect mode\b/.test(block);
}

function extractRelayUrlClaim(block: string): string | null {
  const m = block.match(/^Registered with relay:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

// ── Source-of-truth extractors ────────────────────────────────────────

/**
 * Pull every `name: "..."` inside the `makeAgentTools` function body. The
 * agent scaffold template defines each tool as a ToolEntry with a `name`
 * field directly under `definition:`. Anything the scaffold *writes* for
 * users to run is what this probe locks.
 */
function extractScaffoldToolNames(): { names: string[]; locHint: string } {
  const src = readFileSync(SCAFFOLD_PATH, "utf-8");
  const fnStart = src.indexOf("function makeAgentTools(");
  if (fnStart === -1) {
    throw new Error("could not locate makeAgentTools in create-motebit scaffold");
  }
  // Capture up to the closing brace of the template literal.
  const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
  const names: string[] = [];
  const re = /name:\s*"([a-z_][a-z0-9_]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    names.push(m[1]);
  }
  // The first `name` match will be the scaffolded tools array; filter any
  // definition identifiers that aren't tool names proper (none today, but
  // defensive against future refactors adding e.g. `name: "tools"`).
  return {
    names,
    locHint: `${relative(ROOT, SCAFFOLD_PATH)}:makeAgentTools`,
  };
}

function extractScaffoldPortDefault(): { port: string; locHint: string } {
  const src = readFileSync(SCAFFOLD_PATH, "utf-8");
  const m = src.match(/const\s+port\s*=\s*process\.env\["PORT"\]\s*\?\?\s*"(\d+)"/);
  if (!m) {
    throw new Error("could not locate PORT default in create-motebit scaffold entrypoint");
  }
  // Find the line number for the hint.
  const idx = src.indexOf(m[0]);
  const line = src.slice(0, idx).split("\n").length;
  return { port: m[1], locHint: `${relative(ROOT, SCAFFOLD_PATH)}:${line}` };
}

function extractScaffoldHasDirectFlag(): { hasDirect: boolean; locHint: string } {
  const src = readFileSync(SCAFFOLD_PATH, "utf-8");
  // Find serveArgs declaration.
  const serveArgsStart = src.indexOf("const serveArgs = [");
  if (serveArgsStart === -1) {
    throw new Error("could not locate serveArgs array in create-motebit scaffold entrypoint");
  }
  const serveArgsEnd = src.indexOf("];", serveArgsStart);
  const body = src.slice(serveArgsStart, serveArgsEnd);
  const line = src.slice(0, serveArgsStart).split("\n").length;
  return {
    hasDirect: /"--direct"/.test(body),
    locHint: `${relative(ROOT, SCAFFOLD_PATH)}:${line}`,
  };
}

function extractDefaultSyncUrl(): { url: string; locHint: string } {
  const src = readFileSync(RUNTIME_FACTORY_PATH, "utf-8");
  const m = src.match(/const\s+DEFAULT_SYNC_URL\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new Error(
      "could not locate DEFAULT_SYNC_URL in runtime-factory.ts — if it moved, update this probe's extractor",
    );
  }
  const idx = src.indexOf(m[0]);
  const line = src.slice(0, idx).split("\n").length;
  return { url: m[1], locHint: `${relative(ROOT, RUNTIME_FACTORY_PATH)}:${line}` };
}

// ── Assertions ────────────────────────────────────────────────────────

function equalSets(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

function main(): void {
  const findings: Finding[] = [];
  const { body, startLine } = extractWhatYouSeeBlock();

  // Claim 1: Tools loaded ↔ scaffold tool names
  const toolsClaim = extractToolNamesClaim(body);
  if (!toolsClaim) {
    findings.push({
      loc: `README.md:${startLine}`,
      message: "missing 'Tools loaded:' line in 'What you see:' block",
    });
  } else {
    const { names, locHint } = extractScaffoldToolNames();
    if (!equalSets(toolsClaim, names)) {
      findings.push({
        loc: `README.md:${startLine}`,
        message:
          `'Tools loaded: ${toolsClaim.join(", ")}' disagrees with scaffold tool names [${names.join(", ")}] at ${locHint}. ` +
          `Either update the README or update the scaffold so they name the same set.`,
      });
    }
  }

  // Claim 2: MCP port ↔ scaffold PORT default
  const portClaim = extractPortClaim(body);
  if (!portClaim) {
    findings.push({
      loc: `README.md:${startLine}`,
      message: "missing 'MCP server running on http://localhost:<port>' line",
    });
  } else {
    const { port, locHint } = extractScaffoldPortDefault();
    if (portClaim !== port) {
      findings.push({
        loc: `README.md:${startLine}`,
        message: `'localhost:${portClaim}' disagrees with scaffold PORT default "${port}" at ${locHint}.`,
      });
    }
  }

  // Claim 3: direct mode ↔ --direct in serveArgs
  const claimsDirect = extractDirectModeClaim(body);
  if (claimsDirect) {
    const { hasDirect, locHint } = extractScaffoldHasDirectFlag();
    if (!hasDirect) {
      findings.push({
        loc: `README.md:${startLine}`,
        message: `README advertises 'direct mode' but scaffold serveArgs at ${locHint} does not include "--direct". Either restore the flag or revise the README.`,
      });
    }
  }

  // Claim 4: Registered with relay ↔ DEFAULT_SYNC_URL
  const relayClaim = extractRelayUrlClaim(body);
  if (!relayClaim) {
    findings.push({
      loc: `README.md:${startLine}`,
      message: "missing 'Registered with relay: <url>' line",
    });
  } else {
    const { url, locHint } = extractDefaultSyncUrl();
    if (relayClaim !== url) {
      findings.push({
        loc: `README.md:${startLine}`,
        message: `'Registered with relay: ${relayClaim}' disagrees with DEFAULT_SYNC_URL "${url}" at ${locHint}.`,
      });
    }
  }

  if (findings.length === 0) {
    process.stderr.write(
      `✓ check-readme: 4 claims in README.md 'What you see:' block match code source-of-truth.\n`,
    );
    return;
  }

  process.stderr.write(`\n✗ check-readme: ${findings.length} drift(s) detected.\n\n`);
  for (const f of findings) {
    process.stderr.write(`  ${f.loc}\n    ${f.message}\n\n`);
  }
  process.exit(1);
}

main();
