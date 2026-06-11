#!/usr/bin/env tsx
/**
 * `check-local-tool-gated` — structural lock for the surface-authority
 * keystone: a local frontend is not an exception to the policy gate
 * (`docs/doctrine/surface-authority-model.md` § "The keystone invariant").
 *
 * `MotebitRuntime.invokeLocalTool` is the explicit user-affordance entry
 * point that web/desktop tap to run filesystem/shell tools. It once ran
 * `this.toolRegistry.execute(name, args)` directly with no policy check —
 * the first symptom of the two-authorities drift the keystone forbids
 * (finding h, 2026-06-10). This gate keeps the bypass closed.
 *
 * Scoped to the `invokeLocalTool` method body, it asserts:
 *
 *   1. `this.policy.validate(` is called BEFORE `this.toolRegistry.execute(`
 *      — the side-effect never fires ahead of the gate decision.
 *   2. The decision is honored: a hard-deny guard (`!decision.allowed`) and
 *      an approval guard (`decision.requiresApproval`) sit between the
 *      validate and the execute, so a blocked tool returns before running.
 *   3. The money invariant is preserved: the approval guard keys on
 *      `RiskLevel.R4_MONEY` (R4 is never satisfiable by a bare tap) and the
 *      tap-satisfies rule keys on `"user-tap"` via `classifyTool(`.
 *
 * Same ordered-marker-scan shape as `check-money-authority` (#123) and
 * `check-affordance-routing` (#28).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RUNTIME = "packages/runtime/src/motebit-runtime.ts";

let failed = false;
function fail(message: string): void {
  console.error(`check-local-tool-gated: ${message}`);
  failed = true;
}

const source = readFileSync(resolve(ROOT, RUNTIME), "utf8");

const methodStart = source.indexOf("async invokeLocalTool(");
if (methodStart === -1) {
  fail(
    `could not find the invokeLocalTool method in ${RUNTIME} — update this gate alongside the rename.`,
  );
} else {
  // Bound the scan to the method body: the next top-level (2-space-indented)
  // member declaration or doc comment after the method start.
  const rest = source.slice(methodStart + 1);
  const boundary = rest.search(/\n {2}(async |private |public |get |set |\/\*\*)/);
  const body = boundary === -1 ? rest : rest.slice(0, boundary);

  const validateIdx = body.indexOf("this.policy.validate(");
  const executeIdx = body.indexOf("this.toolRegistry.execute(");

  if (validateIdx === -1) {
    fail(
      "invokeLocalTool no longer calls `this.policy.validate(` — a local-tool affordance " +
        "that skips the policy gate is the two-authorities drift the surface-authority keystone " +
        "forbids (docs/doctrine/surface-authority-model.md). Every local side-effect routes through the gate.",
    );
  } else if (executeIdx === -1) {
    fail(
      "invokeLocalTool no longer calls `this.toolRegistry.execute(` — update this gate alongside the refactor.",
    );
  } else if (validateIdx > executeIdx) {
    fail(
      "invokeLocalTool executes the tool BEFORE validating it — the side-effect fires ahead of the " +
        "policy decision. `this.policy.validate(` must precede `this.toolRegistry.execute(`.",
    );
  }

  if (!body.includes("!decision.allowed")) {
    fail(
      "invokeLocalTool is missing the hard-deny guard (`!decision.allowed`) — a denied tool would " +
        "fall through to execution. A hard deny must block regardless of origin.",
    );
  }
  if (!body.includes("decision.requiresApproval")) {
    fail(
      "invokeLocalTool is missing the approval guard (`decision.requiresApproval`) — an approval-band " +
        "tool would execute unconditionally.",
    );
  }
  if (!body.includes("RiskLevel.R4_MONEY")) {
    fail(
      "invokeLocalTool's approval guard no longer references `RiskLevel.R4_MONEY` — R4 money must NEVER " +
        "be satisfiable by a bare tap (only a verified standing grant clears it). " +
        "docs/doctrine/memory-never-confers-authority.md.",
    );
  }
  if (!body.includes('"user-tap"') || !body.includes("classifyTool(")) {
    fail(
      'invokeLocalTool no longer keys the tap-satisfies-approval rule on `"user-tap"` + `classifyTool(` — ' +
        "the deterministic-affordance approval semantics (docs/doctrine/surface-determinism.md) are gone.",
    );
  }
}

if (failed) {
  process.exit(1);
}
console.log(
  "✓ check-local-tool-gated: invokeLocalTool validates through the policy gate before executing; hard-deny + approval guards present; R4 never satisfiable by a bare tap.",
);
