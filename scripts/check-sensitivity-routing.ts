/**
 * Sensitivity-routing drift gate (invariant #65).
 *
 * Privacy doctrine, CLAUDE.md:
 *   "Medical/financial/secret never reach external AI."
 *
 * Pre-existing reality (audited 2026-04-30): the doctrine was claimed
 * but partially enforced. Memory retrieval filtered context-injection
 * via `CONTEXT_SAFE_SENSITIVITY` (works), but provider-mode routing
 * had zero sensitivity references in `provider-resolver.ts`, the
 * runtime's `session_sensitivity` field was hardcoded `"none"`, and no
 * AI-call site checked the user-tier-vs-provider-tier mismatch before
 * invoking `runTurn` / `runTurnStreaming`. A surface that elevated
 * session sensitivity to `medical` would still happily ship the bytes
 * to Anthropic / OpenAI / Google via BYOK.
 *
 * The fix shape (this gate's invariant): every runtime method that
 * invokes `runTurn` or `runTurnStreaming` MUST call
 * `assertSensitivityPermitsAiCall()` somewhere earlier in the same
 * method body. The assertion is the canonical sensitivity-vs-provider
 * gate; it throws `SovereignTierRequiredError` before any provider
 * call when session is medical/financial/secret AND provider is not
 * sovereign.
 *
 * ── Rule ─────────────────────────────────────────────────────────────
 *
 * Scan `packages/runtime/src/motebit-runtime.ts`. For every method
 * containing a call to `runTurn(` or `runTurnStreaming(`, the method
 * body MUST also contain a call to `this.assertSensitivityPermitsAiCall()`
 * appearing BEFORE the AI invocation.
 *
 * ── Why this file only ───────────────────────────────────────────────
 *
 * The runtime is the single orchestrator for user-facing AI calls
 * (per `check-app-primitives` — apps don't reach past the SDK to
 * ai-core directly). Every external-AI call from a motebit surface
 * routes through the runtime. So the runtime file is the boundary
 * where the gate has to fire; gating ai-core directly would either
 * duplicate the check (and surface false positives in test fixtures)
 * or break the runtime's role as the policy gate.
 *
 * Consolidation calls (`provider.generate(...)` for memory
 * consolidation) are intentionally NOT gated here: they operate on
 * memories that have already passed through `CONTEXT_SAFE_SENSITIVITY`
 * at retrieval time, so high-sensitivity bytes never enter the
 * consolidation path. Locking that invariant is the memory-retrieval
 * filter's job, not this gate's.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const TARGET = resolve(ROOT, "packages/runtime/src/motebit-runtime.ts");
const AI_CALL_PATTERNS = [/\brunTurn\s*\(/g, /\brunTurnStreaming\s*\(/g];
const GATE_PATTERN = /\bthis\.assertSensitivityPermitsAiCall\s*\(/g;

interface MethodSlice {
  /** 1-indexed line where the method body starts (the line with the opening `{`). */
  startLine: number;
  /** 1-indexed line where the method body ends (the line with the closing `}`). */
  endLine: number;
  /** Source text of the method body (between the braces, trimmed). */
  body: string;
  /** Heuristic name extracted from the declaration line — for diagnostics. */
  name: string;
}

/**
 * Slice the file into method bodies. Heuristic: a method declaration
 * starts at indent depth 2 (`  async name(...)` or `  async *name(...)`)
 * and ends at the matching closing brace at the same indent. Brace
 * counting handles nested blocks.
 *
 * Skips type-import-only patterns and comments. The runtime file
 * follows a consistent class-method idiom so the heuristic is robust.
 */
function sliceMethods(src: string): MethodSlice[] {
  const lines = src.split("\n");
  const slices: MethodSlice[] = [];
  const declRe = /^ {2}(?:async\s+)?\*?[a-zA-Z_$][\w$]*\s*[(<]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!declRe.test(line)) continue;
    // Find the opening brace — could be on this line or a continuation line.
    let braceLineIdx = i;
    while (braceLineIdx < lines.length && !lines[braceLineIdx]!.includes("{")) {
      braceLineIdx++;
    }
    if (braceLineIdx >= lines.length) continue;
    let depth = 0;
    let started = false;
    let endIdx = braceLineIdx;
    for (let j = braceLineIdx; j < lines.length; j++) {
      const lineJ = lines[j]!;
      for (const ch of lineJ) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
          if (started && depth === 0) {
            endIdx = j;
            break;
          }
        }
      }
      if (started && depth === 0) {
        endIdx = j;
        break;
      }
    }
    const body = lines.slice(braceLineIdx, endIdx + 1).join("\n");
    const nameMatch = line.match(/^ {2}(?:async\s+)?\*?([a-zA-Z_$][\w$]*)/);
    slices.push({
      startLine: i + 1,
      endLine: endIdx + 1,
      body,
      name: nameMatch?.[1] ?? "<unknown>",
    });
    i = endIdx;
  }
  return slices;
}

/**
 * Check a single method body for the gate invariant. Returns null if
 * the method doesn't invoke an AI call (gate is irrelevant) or the
 * gate fires before every AI invocation. Returns a violation otherwise.
 */
function checkMethod(slice: MethodSlice): string | null {
  // Strip block + line comments so commented-out call sites don't
  // false-flag.
  const stripped = slice.body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // Find the earliest AI call site (line offset within the body).
  let firstAiCallOffset = Infinity;
  for (const pat of AI_CALL_PATTERNS) {
    pat.lastIndex = 0;
    const m = pat.exec(stripped);
    if (m && m.index < firstAiCallOffset) firstAiCallOffset = m.index;
  }
  if (firstAiCallOffset === Infinity) return null; // no AI call — gate not applicable

  GATE_PATTERN.lastIndex = 0;
  const gateMatch = GATE_PATTERN.exec(stripped);
  if (!gateMatch || gateMatch.index > firstAiCallOffset) {
    return `${slice.name} (lines ${slice.startLine}–${slice.endLine}) calls runTurn / runTurnStreaming without first calling \`this.assertSensitivityPermitsAiCall()\``;
  }
  return null;
}

/**
 * Tool-call-boundary check. Verifies that the runtime wraps the tool
 * registry through `wrapToolRegistryForSensitivity` when populating
 * `loopDeps.tools`. The wrapper is what enforces the sensitivity gate
 * at outbound tool dispatch (web_search, read_url,
 * delegate_to_agent, MCP tools — any tool tagged `outbound: true`).
 *
 * Without the wrap, ai-core invokes the underlying registry directly
 * and the gate silently no-ops. Same drift shape as the AI-call gate
 * above: a refactor that "simplifies" by removing the wrap re-opens
 * the privacy hole.
 *
 * Pattern enforced: the assignment to `tools:` in loopDeps must
 * either be `undefined` OR routed through `wrapToolRegistryForSensitivity`.
 * Anything else (raw assignment of `this.scopedToolRegistry`, a new
 * registry without the wrap) is flagged.
 */
function checkToolWrapPresent(src: string): string | null {
  // The wrap method must be defined on the runtime class.
  if (!/\bwrapToolRegistryForSensitivity\s*\(/g.test(src)) {
    return "missing `wrapToolRegistryForSensitivity` method on MotebitRuntime — the runtime must own a registry wrapper that gates outbound tools on session sensitivity";
  }
  // The loopDeps `tools:` assignment must route through the wrapper.
  // Locate the `this.loopDeps = { ... }` block (the outermost `{...}`
  // following the assignment) and confirm its `tools:` line references
  // the wrapper. Multi-line ternaries are common; matching from
  // `tools:` to the next top-level comma would miss the wrapper call
  // when it sits inside the ternary body. Simpler + correct: match the
  // entire block and verify both keywords coexist within it.
  const blockMatch = src.match(/this\.loopDeps\s*=\s*\{([\s\S]*?)\n\s{6}\};/);
  if (blockMatch) {
    const block = blockMatch[1] ?? "";
    if (block.includes("tools:") && !block.includes("wrapToolRegistryForSensitivity")) {
      return "loopDeps assignment defines `tools:` but doesn't route through `wrapToolRegistryForSensitivity` — outbound tool dispatch would skip the sensitivity gate";
    }
  }
  return null;
}

function main(): void {
  if (!existsSync(TARGET)) {
    console.error(`✗ check-sensitivity-routing: target file missing: ${TARGET}`);
    process.exit(1);
  }
  const src = readFileSync(TARGET, "utf-8");
  const slices = sliceMethods(src);
  const violations: string[] = [];
  for (const slice of slices) {
    const v = checkMethod(slice);
    if (v != null) violations.push(v);
  }
  // Tool-call boundary check (independent of the per-method AI-call check).
  const toolWrapViolation = checkToolWrapPresent(src);
  if (toolWrapViolation != null) violations.push(toolWrapViolation);

  if (violations.length === 0) {
    console.log(
      `✓ check-sensitivity-routing: every runtime AI-call entry gates on \`assertSensitivityPermitsAiCall\`, and the tool registry is wrapped through \`wrapToolRegistryForSensitivity\` for outbound-tool gating.\n`,
    );
    return;
  }
  console.error(
    `\n✗ check-sensitivity-routing: ${violations.length} sensitivity-gate violation(s).\n\n`,
  );
  for (const v of violations) {
    console.error(`  ${v}\n`);
  }
  console.error(
    'Per CLAUDE.md privacy doctrine ("Medical/financial/secret never reach external AI"): every runtime AI-call entry MUST call `this.assertSensitivityPermitsAiCall()` before invoking runTurn / runTurnStreaming, AND the runtime\'s tool registry MUST be wrapped through `wrapToolRegistryForSensitivity` so outbound tools (web_search, read_url, delegate_to_agent, MCP) fail-close at dispatch when session is medical/financial/secret AND provider is not sovereign. Both checks fire before any bytes leave the device.\n',
  );
  process.exit(1);
}

main();
