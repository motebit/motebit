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
 * invokes the AI provider — via the turn-level orchestrators
 * (`runTurn`, `runTurnStreaming`) OR a direct `provider.generate*`
 * call (housekeeping completions: title generation, summarization,
 * classification) — MUST call `assertSensitivityPermitsAiCall()`
 * somewhere earlier in the same method body. The assertion is the
 * canonical sensitivity-vs-provider gate; it throws
 * `SovereignTierRequiredError` before any provider call when session
 * is medical/financial/secret AND provider is not sovereign.
 *
 * ── Rule ─────────────────────────────────────────────────────────────
 *
 * Scan `packages/runtime/src/motebit-runtime.ts`. For every method
 * containing a call to `runTurn(`, `runTurnStreaming(`, or a direct
 * `.generate(` / `.generateStream(` invocation on a provider
 * reference, the method body MUST also contain a call to
 * `this.assertSensitivityPermitsAiCall()` appearing BEFORE the AI
 * invocation. Methods on `DIRECT_PROVIDER_CALL_ALLOWLIST` are exempt
 * from the direct-call check (consolidation carve-out — see below).
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
 * consolidation) are intentionally exempted via
 * `DIRECT_PROVIDER_CALL_ALLOWLIST`: high-sensitivity bytes never enter
 * the consolidation path, so there is nothing for this gate to clear.
 * Locking that invariant is the consolidation cycle's job, not this
 * gate's: `runtime/consolidation-cycle.ts:gatherPhase` filters episodic
 * candidates at or above `Medical` out of LLM clustering/summarization
 * whenever the provider is non-sovereign (`deps.providerIsSovereign()`
 * false → BYOK / relay). Sovereign (on-device) providers consolidate
 * every tier — no egress, nothing to protect. The carve-out also covers
 * `consolidatePhase`, which only ever sees the already-filtered cluster
 * set (cross-file from this scan); since the conflict-resolution repair
 * it additionally routes summaries through `consolidateAndForm`, whose
 * classify call sends NEIGHBOR content to the provider — a second
 * egress surface the phase caps with the `sensitivityCeiling` option
 * (≤ Personal on non-sovereign providers), so neighbors honor the same
 * floor the cluster members do.
 *
 * ── Relationship to the `SensitivityCleared<T>` brand ──────────────
 *
 * This gate handles **in-file direct provider calls** within
 * `motebit-runtime.ts` (`generateCompletion`, `wireLoopDeps`'s
 * consolidation provider). It complements — does not replace — the
 * `SensitivityCleared<T>` phantom-type brand promoted in
 * `@motebit/protocol`, which structurally enforces the **cross-
 * package indirect direct-call family**:
 *
 *   - `summarizeConversation` in `@motebit/ai-core` — caller
 *     `ConversationManager` projects cleared provider from
 *     `assertSensitivityPermitsAiCall("summarizeConversation")`.
 *   - `reflect` in `@motebit/ai-core` — caller `performReflection`
 *     in `@motebit/reflection` receives cleared provider from the
 *     runtime's `assertSensitivityPermitsAiCall("runReflection")`.
 *   - `decomposePlan` / `reflectOnPlan` in `@motebit/planner` —
 *     `PlanEngine` projects cleared provider from cleared deps that
 *     `PlanExecutionManager` produced via
 *     `assertSensitivityPermitsAiCall("executePlanStep")`.
 *
 * Each branded parameter makes any path that bypasses the gate a
 * compile error. The static check this file performs is what's
 * left after the brand absorbs the cross-package family: in-file
 * regression coverage for direct `provider.generate(...)` calls
 * inside the runtime's own method bodies, where TS can't enforce
 * "this method call requires the receiver to be branded."
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
/**
 * Direct provider-call pattern. Matches `provider.generate(`,
 * `p.generate(`, `provider.generateStream(`, etc. — any method call on
 * an `IntelligenceProvider` reference that crosses the network boundary
 * outside the `runTurn` / `runTurnStreaming` orchestrators. Housekeeping
 * paths (title generation, summarization, classification) call these
 * directly, and the previous gate scoped only to `runTurn(*` missed them.
 *
 * Scoped to `.generate(` / `.generateStream(` because those are the
 * `IntelligenceProvider` interface's only network methods; nothing else
 * in the codebase shares the name.
 */
const DIRECT_PROVIDER_CALL_PATTERN = /\.(?:generate|generateStream)\s*\(/g;
const GATE_PATTERN = /\bthis\.assertSensitivityPermitsAiCall\s*\(/g;

/**
 * Methods exempt from the direct-provider-call check. The consolidation
 * provider built inside `wireLoopDeps` only ever sees memory bodies the
 * consolidation cycle has already filtered: `consolidation-cycle.ts`
 * gatherPhase drops ≥`Medical` episodics before clustering whenever the
 * provider is non-sovereign, so high-sensitivity bytes never enter that
 * path. Enforcing that invariant is the cycle's job, not this gate's.
 *
 * Adding an entry is a privacy-load-bearing decision: name the
 * justification in the comment so future readers can audit.
 */
const DIRECT_PROVIDER_CALL_ALLOWLIST: ReadonlySet<string> = new Set([
  // Constructs `consolidationProvider`; the inner `provider.generate`
  // call only sees the sensitivity-filtered cluster set produced by
  // `consolidation-cycle.ts:gatherPhase` (≥Medical dropped on non-sovereign).
  "wireLoopDeps",
]);

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

  // Direct-provider-call sites — same gate semantics as turn-level
  // calls, applied to `provider.generate*` invocations that bypass
  // `runTurn` / `runTurnStreaming` (housekeeping completions). Methods
  // on the consolidation allowlist are exempt by carve-out.
  if (!DIRECT_PROVIDER_CALL_ALLOWLIST.has(slice.name)) {
    DIRECT_PROVIDER_CALL_PATTERN.lastIndex = 0;
    const m = DIRECT_PROVIDER_CALL_PATTERN.exec(stripped);
    if (m && m.index < firstAiCallOffset) firstAiCallOffset = m.index;
  }

  if (firstAiCallOffset === Infinity) return null; // no AI call — gate not applicable

  GATE_PATTERN.lastIndex = 0;
  const gateMatch = GATE_PATTERN.exec(stripped);
  if (!gateMatch || gateMatch.index > firstAiCallOffset) {
    return `${slice.name} (lines ${slice.startLine}–${slice.endLine}) invokes the AI provider (runTurn / runTurnStreaming / provider.generate) without first calling \`this.assertSensitivityPermitsAiCall()\``;
  }
  return null;
}

/**
 * Surface-affordance registry. Each entry names a user-facing surface
 * that hosts a chat/slash-dispatch and therefore MUST expose a
 * `/sensitivity` affordance — without it, the runtime gate is
 * unreachable from any user action on that surface and the doctrine
 * claim "users can mark a session medical/financial/secret" is dead
 * letter for that surface.
 *
 * `apps/spatial` is intentionally excluded: per `apps/spatial/CLAUDE.md`
 * the surface is embodiment-only with no panels and no slash dispatch.
 * If spatial ever grows a chat surface, it joins this list — the
 * exclusion is structural, not policy.
 */
interface SurfaceAffordance {
  surface: string;
  /** Path (relative to repo root) of the file that hosts slash dispatch. */
  path: string;
}

const SURFACE_AFFORDANCES: ReadonlyArray<SurfaceAffordance> = [
  { surface: "cli", path: "apps/cli/src/slash-commands.ts" },
  { surface: "desktop", path: "apps/desktop/src/ui/chat.ts" },
  { surface: "mobile", path: "apps/mobile/src/slash-commands.ts" },
  { surface: "web", path: "apps/web/src/ui/slash-commands.ts" },
];

/**
 * Affordance check — every registered surface must wire `/sensitivity`
 * to the runtime API. Two signals required: the literal string
 * `"sensitivity"` must appear (the dispatch case) AND at least one of
 * `setSessionSensitivity` / `getSessionSensitivity` must appear (proves
 * the handler routes through the canonical runtime setter rather than
 * forking its own state). Both signals together are what makes the
 * affordance load-bearing — a `case "sensitivity"` that doesn't call
 * the runtime API is decorative.
 */
function checkSurfaceAffordances(): string[] {
  const violations: string[] = [];
  for (const entry of SURFACE_AFFORDANCES) {
    const abs = resolve(ROOT, entry.path);
    if (!existsSync(abs)) {
      violations.push(`${entry.surface}: dispatch file missing at ${entry.path}`);
      continue;
    }
    const src = readFileSync(abs, "utf-8");
    if (!/\bsensitivity\b/.test(src)) {
      violations.push(
        `${entry.surface} (${entry.path}): no \`sensitivity\` handler — users have no way to elevate session_sensitivity, so the runtime gate is unreachable from this surface`,
      );
      continue;
    }
    if (!/\bsetSessionSensitivity\b/.test(src)) {
      violations.push(
        `${entry.surface} (${entry.path}): \`sensitivity\` handler present but doesn't call \`setSessionSensitivity\` — display-only is not enough; users must be able to ELEVATE through the canonical runtime setter, otherwise the affordance is decorative`,
      );
    }
  }
  return violations;
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

/**
 * Surfaces that wire the `recall_memories` tool's search backend. Each must
 * route through the runtime's `recallMemoriesForTool` — the ONE place the
 * sensitivity egress ceiling is applied to explicit recall. A hand-rolled
 * `memory.recallRelevant` closure omits `sensitivityFilter`, and `undefined`
 * disables filtering end-to-end, so a stored medical/financial/secret memory
 * would reach an external provider on a `none`-tier session. That exact bypass
 * shipped on all four surfaces (fixed by centralizing here); this gate keeps it
 * from silently returning.
 */
const MEMORY_RECALL_SURFACES: ReadonlyArray<{ surface: string; path: string }> = [
  { surface: "cli", path: "apps/cli/src/runtime-factory.ts" },
  { surface: "web", path: "apps/web/src/web-app.ts" },
  { surface: "desktop", path: "apps/desktop/src/desktop-tools.ts" },
  { surface: "mobile", path: "apps/mobile/src/mobile-app.ts" },
];

/**
 * Recall-tool egress check. Two parts: (1) the centralized
 * `recallMemoriesForTool` on MotebitRuntime must gate the recall on the
 * provider (`providerIsSovereign` decides the `sensitivityFilter`); (2) every
 * surface wiring `memorySearchFn` must route through it, never a raw
 * `recallRelevant` closure.
 */
function checkRecallEgress(slices: MethodSlice[]): string[] {
  const violations: string[] = [];

  const method = slices.find((s) => s.name === "recallMemoriesForTool");
  if (!method) {
    violations.push(
      "MotebitRuntime is missing `recallMemoriesForTool` — the single sanctioned backend for the recall_memories tool. Surfaces must not hand-roll a `memory.recallRelevant` recall closure, which would omit the sensitivity egress filter.",
    );
  } else {
    const b = method.body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    if (!/providerIsSovereign/.test(b) || !/sensitivityFilter/.test(b)) {
      violations.push(
        `recallMemoriesForTool (lines ${method.startLine}–${method.endLine}) must key the recall's \`sensitivityFilter\` on the provider (external ⇒ CONTEXT_SAFE_SENSITIVITY only; sovereign ⇒ all tiers). Found providerIsSovereign=${/providerIsSovereign/.test(b)}, sensitivityFilter=${/sensitivityFilter/.test(b)}.`,
      );
    }
  }

  for (const s of MEMORY_RECALL_SURFACES) {
    const abs = resolve(ROOT, s.path);
    if (!existsSync(abs)) {
      violations.push(`${s.surface}: recall-wiring file missing at ${s.path}`);
      continue;
    }
    const src = readFileSync(abs, "utf-8");
    const idx = src.indexOf("memorySearchFn");
    if (idx === -1) continue; // surface doesn't wire recall — nothing to gate
    const window = src.slice(idx, idx + 500);
    if (!/recallMemoriesForTool/.test(window)) {
      violations.push(
        `${s.surface} (${s.path}): \`memorySearchFn\` does not route through \`runtime.recallMemoriesForTool\` — a hand-rolled recall closure omits the sensitivity egress filter (medical/financial/secret would reach an external provider).`,
      );
    } else if (/\.recallRelevant\s*\(/.test(window)) {
      violations.push(
        `${s.surface} (${s.path}): \`memorySearchFn\` calls \`recallRelevant\` directly — recall for the tool must go through \`recallMemoriesForTool\`, which owns the egress filter.`,
      );
    }
  }
  return violations;
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

  // Surface affordance check — every user-facing surface with chat/
  // slash dispatch MUST expose `/sensitivity`. Without this, the
  // runtime gate is unreachable from any user action on that
  // surface (the v1 + v2 enforcement infrastructure exists but
  // session_sensitivity stays pinned at "none" because no one can
  // elevate). spatial is excluded by structure — see SURFACE_AFFORDANCES.
  const affordanceViolations = checkSurfaceAffordances();
  violations.push(...affordanceViolations);

  // Recall-tool egress — the explicit recall_memories path must apply the same
  // provider-keyed sensitivity ceiling the auto-injection path does.
  violations.push(...checkRecallEgress(slices));

  if (violations.length === 0) {
    console.log(
      `✓ check-sensitivity-routing: AI-call entries (runTurn / runTurnStreaming / direct provider.generate) gate on \`assertSensitivityPermitsAiCall\`, the tool registry is wrapped via \`wrapToolRegistryForSensitivity\`, every registered surface (${SURFACE_AFFORDANCES.map((s) => s.surface).join(", ")}) exposes \`/sensitivity\` routed through the canonical runtime setter, and every surface routes recall_memories through \`recallMemoriesForTool\` (provider-keyed egress ceiling).\n`,
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
    'Per CLAUDE.md privacy doctrine ("Medical/financial/secret never reach external AI"), the gate has three load-bearing pieces:\n  1. Every runtime AI-call entry MUST call `this.assertSensitivityPermitsAiCall()` before invoking runTurn / runTurnStreaming OR a direct `provider.generate*` call. Housekeeping completions (title generation, summarization, classification) feed user-authored text straight to the provider, so they take the same gate as a turn.\n  2. The runtime\'s tool registry MUST be wrapped through `wrapToolRegistryForSensitivity` so outbound tools (web_search, read_url, delegate_to_agent, MCP) fail-close on high-sensitivity sessions.\n  3. Every user-facing surface with chat/slash dispatch MUST expose `/sensitivity` routed through `runtime.setSessionSensitivity` / `getSessionSensitivity` — without this affordance, the gate is enforced in code but unreachable from any user action.\n  4. The explicit `recall_memories` tool MUST route through `runtime.recallMemoriesForTool`, which applies the same provider-keyed egress ceiling (external ⇒ context-safe tiers only). A hand-rolled `memory.recallRelevant` closure omits `sensitivityFilter` and would return medical/financial/secret memories toward an external provider.\n\nAll four together close the doctrine end-to-end: enforcement at the boundary (turn calls, tool dispatch, AND explicit recall) + a path for users to actually trip the gate.\n',
  );
  process.exit(1);
}

main();
