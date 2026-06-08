/**
 * Goal-artifact-signing drift gate.
 *
 * Enforces the doctrine commitment in `docs/doctrine/goal-results.md`
 * §"The three categories": every goal fire produces an **artifact**
 * category — content the agent created during the run, distinct from
 * the commitment card and the execution receipt. Per
 * `docs/doctrine/receipts-unified.md`, artifacts that cross
 * cryptographic-provenance boundaries MUST ship as a signed
 * `ContentArtifactManifest`. The runtime exposes that signing via
 * `MotebitRuntime.signGoalArtifact(content, { goalId, runId })`.
 *
 * The Phase-3 close (2026-05-14: commits 2428248a → 347b8461 →
 * 8b547f3f → 714d7e38) wired this call on all three flat surfaces:
 *
 *   - `apps/web/src/goal-scheduler.ts`
 *   - `apps/desktop/src/goal-scheduler.ts`
 *   - `apps/mobile/src/goal-scheduler.ts`
 *
 * Without this gate, a refactor that drops the call from one surface
 * (or a new surface that adds a goal-fire loop without calling
 * `signGoalArtifact`) passes typecheck silently — the call site is
 * optional from TypeScript's perspective. The gate catches the
 * silent regression at PR-diff time.
 *
 * The shape is the same load-bearing pattern as
 * `check-drop-handlers` (#48) — for each registered per-surface
 * goal-runner file, assert it calls the canonical signing primitive
 * before persisting goal-fire results. Failure to call the
 * primitive is a runtime contract break: persisted goal results
 * without manifests lose the cryptographic-provenance envelope the
 * receipts-unified doctrine mandates.
 *
 * Exit 1 on any violation. Runs in `pnpm check`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Registered per-surface goal-runner files. Each is the canonical
 * site where the goal-fire loop produces an artifact and is
 * required to sign it via `runtime.signGoalArtifact`.
 *
 * Adding a new surface that has a goal-fire loop = appending here.
 * The companion ALLOWLIST below documents surfaces that have a
 * goal-fire loop but intentionally don't sign yet (none today).
 */
const REGISTERED_GOAL_RUNNERS: ReadonlyArray<{
  /** Path relative to repo root. */
  readonly path: string;
  /** Short label for error messages. */
  readonly surface: string;
}> = [
  { path: "apps/web/src/goal-scheduler.ts", surface: "web" },
  { path: "apps/desktop/src/goal-scheduler.ts", surface: "desktop" },
  { path: "apps/mobile/src/goal-scheduler.ts", surface: "mobile" },
];

/**
 * Surfaces that have a goal-fire loop but intentionally skip
 * signing today. Empty at land — every registered surface signs.
 * Future entries name the deferral reason and the triggering
 * consumer (mirror of the `check-drop-handlers` ALLOWLIST shape).
 */
const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [];

interface Violation {
  readonly path: string;
  readonly surface: string;
  readonly kind: "missing_file" | "missing_call";
}

function checkSurface(rel: string, surface: string): Violation | null {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) {
    return { path: rel, surface, kind: "missing_file" };
  }
  const source = readFileSync(abs, "utf8");
  // Match `runtime.signGoalArtifact(` with any prefix (`this.runtime`,
  // `runtime`, `r.signGoalArtifact(...)` if aliased). The simple
  // identifier match is sufficient because the call name is
  // sufficiently unique — no other API in the codebase shares it.
  // A rename of the API itself would be a wire-format break the
  // package gate would catch separately.
  if (!source.includes("signGoalArtifact(")) {
    return { path: rel, surface, kind: "missing_call" };
  }
  return null;
}

function main(): void {
  const violations: Violation[] = [];
  const allowedPaths = new Set(ALLOWLIST.map((a) => a.path));

  for (const { path, surface } of REGISTERED_GOAL_RUNNERS) {
    if (allowedPaths.has(path)) continue;
    const v = checkSurface(path, surface);
    if (v !== null) violations.push(v);
  }

  if (violations.length === 0) {
    process.stderr.write(
      `✓ check-goal-artifact-signing: every registered goal-runner (${REGISTERED_GOAL_RUNNERS.length} surface(s)) calls runtime.signGoalArtifact — goal-result artifacts ship as signed ContentArtifactManifest per doctrine.\n`,
    );
    return;
  }

  process.stderr.write(`\n✗ check-goal-artifact-signing: ${violations.length} violation(s):\n\n`);
  for (const v of violations) {
    if (v.kind === "missing_file") {
      process.stderr.write(
        `  • ${v.path} (${v.surface}): registered as a goal-runner but the file does not exist.\n`,
      );
      process.stderr.write(
        `    → If the surface moved its goal-fire loop, update REGISTERED_GOAL_RUNNERS in this gate.\n`,
      );
    } else {
      process.stderr.write(
        `  • ${v.path} (${v.surface}): does not call runtime.signGoalArtifact().\n`,
      );
      process.stderr.write(
        `    → Per docs/doctrine/goal-results.md §"The three categories", every goal fire must produce a signed ContentArtifactManifest. Wire \`await runtime.signGoalArtifact(content, { goalId, runId })\` at the surface's fire-complete handler and persist the returned manifest alongside the artifact bytes (mirror the sibling surfaces' pattern).\n`,
      );
      process.stderr.write(
        `    → If the surface intentionally defers, add a per-path entry to ALLOWLIST in this gate with the deferral reason and triggering consumer (mirror the check-drop-handlers shape).\n`,
      );
    }
  }
  process.exit(1);
}

main();
