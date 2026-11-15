/**
 * Tamper checks for the archetype slate's promotion-readiness gate:
 * scripts/check-promotion-ready.ts (the decision) and
 * scripts/deploy-archetype-slate.ts (the refusal, on a real prod run, before
 * the first flyctl call).
 *
 * Each entry removes one rule — the readiness read, the refusal, its place
 * before the first flyctl call, fail-closed on unreadable gh, the non-empty
 * override reason, the printed reason and overridden result, the fixed
 * window of five, the scheduled-only history, the staging and dry-run
 * carve-outs — and names the test in
 * scripts/__tests__/slate-promotion-readiness.test.ts that must go red.
 *
 *   node scripts/tampers/slate-promotion-readiness.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const READY = "scripts/check-promotion-ready.ts";
const SLATE = "scripts/deploy-archetype-slate.ts";
const TEST = "scripts/__tests__/slate-promotion-readiness.test.ts";

const DECISION = (t: string) => `readPromotionReadiness ${t}`;
const GATE = (t: string) => `deploy-archetype-slate: the promotion-readiness gate ${t}`;
const PROGRAM = (t: string) => `the scripts as programs (fake gh, fake flyctl) ${t}`;

const REFUSES_RED = GATE(
  "prod real run, not all green: refuses, zero flyctl calls, exit 1, naming the failing runs and the repair",
);
const REFUSES_GH = GATE(
  "prod real run, gh unreadable: refuses, zero flyctl calls, exit 1, naming the repair",
);
const ORDER = GATE(
  "prod real run, ready: proceeds, and the first flyctl call comes after the readiness read",
);
const FIVE = GATE(
  "prod real run reads exactly five runs: one fresh green above a red one refuses, whatever REQUIRED says",
);
const EMPTY_OVERRIDE = GATE("override empty or whitespace: refuses");

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  test: TEST,
  red,
  edits,
});

const GATE_CALL =
  "  const refusal = gatePromotion(target, run, effects);\n  if (refusal !== null) return refusal;\n";
const DEPLOY_CALL =
  '      sh("flyctl", ["deploy", "--config", svc.config(target), "-a", app, "--remote-only"]);\n';

const TAMPERS: TamperEntry[] = [
  entry(
    "the slate never reads readiness (the call is removed)",
    REFUSES_RED,
    edit(
      SLATE,
      "  const refusal = gatePromotion(target, run, effects);\n",
      "  const refusal = null as number | null;\n",
    ),
  ),
  entry(
    "the refusal is a warning: it prints and the deploy goes on",
    REFUSES_RED,
    edit(
      SLATE,
      "  return 1;\n}\n\n/** The ceremony. Returns the process exit code. */",
      "  return null;\n}\n\n/** The ceremony. Returns the process exit code. */",
    ),
  ),
  entry(
    "readiness is read after the first flyctl deploy, not before",
    ORDER,
    edit(SLATE, GATE_CALL, ""),
    edit(
      SLATE,
      DEPLOY_CALL,
      `${DEPLOY_CALL}      const refusal = gatePromotion(target, run, effects);\n      if (refusal !== null) return refusal;\n`,
    ),
  ),
  entry(
    "the decision: an unreadable gh reads as ready",
    DECISION("gh unreadable (the lister throws): not ready, gh-unreadable"),
    edit(
      READY,
      "  } catch (err) {\n    return unreadable(err instanceof Error ? err.message : String(err));\n  }",
      "  } catch {\n    return { ready: true, required, runs: [] };\n  }",
    ),
  ),
  entry(
    "the gate: an unreadable gh proceeds instead of refusing",
    REFUSES_GH,
    edit(
      SLATE,
      '  if (overridden) {\n    effects.error("!!! PROMOTION READINESS OVERRIDDEN !!!");',
      '  if (overridden || (readiness.reason as string) === "gh-unreadable") {\n    effects.error("!!! PROMOTION READINESS OVERRIDDEN !!!");',
    ),
  ),
  entry(
    "an empty override is accepted (set is enough, no reason needed)",
    EMPTY_OVERRIDE,
    edit(
      SLATE,
      '  const overridden = overrideReason !== "";',
      "  const overridden = effects.env[PROMOTION_READINESS_OVERRIDE_ENV] !== undefined;",
    ),
  ),
  entry(
    "a whitespace override is accepted (the reason is not trimmed)",
    EMPTY_OVERRIDE,
    edit(
      SLATE,
      '  const overrideReason = (effects.env[PROMOTION_READINESS_OVERRIDE_ENV] ?? "").trim();',
      '  const overrideReason = effects.env[PROMOTION_READINESS_OVERRIDE_ENV] ?? "";',
    ),
  ),
  entry(
    "the override is silent about its reason",
    GATE("override with a reason: proceeds, printing the reason"),
    edit(
      SLATE,
      "    effects.error(`!!! reason (${PROMOTION_READINESS_OVERRIDE_ENV}): ${overrideReason}`);\n",
      "",
    ),
  ),
  entry(
    "the override does not print the readiness result it overrode",
    GATE("override with a reason: prints the readiness result it overrode"),
    edit(SLATE, "    for (const line of lines) effects.error(`!!!   ${line}`);\n", ""),
  ),
  entry(
    "the required window is lowered from five to one",
    FIVE,
    edit(
      READY,
      "export const PROMOTION_REQUIRED_GREEN_RUNS = 5;",
      "export const PROMOTION_REQUIRED_GREEN_RUNS = 1;",
    ),
  ),
  entry(
    "the slate lets REQUIRED lower its window",
    FIVE,
    edit(
      SLATE,
      "    required: PROMOTION_REQUIRED_GREEN_RUNS,\n",
      '    required: Number(effects.env["REQUIRED"] ?? PROMOTION_REQUIRED_GREEN_RUNS),\n',
    ),
  ),
  entry(
    "the decision: thin history reads as ready",
    DECISION("thin history: not ready, thin-history"),
    edit(
      READY,
      "  if (runs.length < required) return {",
      "  if ((false as boolean) && runs.length < required) return {",
    ),
  ),
  entry(
    "the decision: only a `failure` blocks (a pending or cancelled run passes)",
    DECISION(
      "a failed, cancelled or pending run in the window: not ready, not-all-green, naming the runs",
    ),
    edit(
      READY,
      '  const failing = runs.filter((r) => r.conclusion !== "success");',
      '  const failing = runs.filter((r) => r.conclusion === "failure");',
    ),
  ),
  entry(
    "the decision: manual dispatches count toward the window",
    DECISION(
      "only scheduled runs count: a manual dispatch in the answer is thin history, never a green",
    ),
    edit(
      READY,
      '  const runs = listed.filter((r) => r.event === "schedule").slice(0, required);',
      "  const runs = listed.slice(0, required);",
    ),
  ),
  entry(
    "the gh adapter no longer asks for scheduled runs only",
    PROGRAM(
      "check-promotion-ready: asks gh for the last 5 SCHEDULED conformance runs; exit 0 ready, 1 not ready / thin / unreadable",
    ),
    edit(READY, '      "--event",\n      "schedule",\n', ""),
  ),
  entry(
    "staging reads readiness too (the carve-out is gone)",
    GATE("staging real run: no readiness read, and it deploys the -stg apps"),
    edit(
      SLATE,
      '  if (target !== "prod") return null;',
      '  if ((false as boolean) && target !== "prod") return null;',
    ),
  ),
  entry(
    "a prod dry run refuses instead of reporting",
    GATE("prod dry run: reports readiness, refuses nothing, runs no flyctl"),
    edit(
      SLATE,
      '  if (!run) {\n    effects.log("promotion readiness (dry run',
      '  if ((false as boolean) && !run) {\n    effects.log("promotion readiness (dry run',
    ),
  ),
];

await runTampers(TAMPERS, { root: ROOT });
