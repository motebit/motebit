/**
 * Tamper checks for the archetype slate's promotion-readiness gate:
 * scripts/check-promotion-ready.ts (the decision, the gh read, the
 * program-entry test) and scripts/deploy-archetype-slate.ts (the refusal on a
 * real production promotion, before the first flyctl call).
 *
 * Each entry removes one rule and names the test in
 * scripts/__tests__/slate-promotion-readiness.test.ts that must go red:
 *   - the gate: the readiness read, the refusal, its place before the first
 *     flyctl call, fail-closed on unreadable gh, the fixed window of five,
 *     the staging and dry-run carve-outs;
 *   - the override: a real reason (length, trimming), printed with the
 *     result it overrode;
 *   - the decision: thin history, not-green, completed, first attempt, main,
 *     freshness, the window's own ordering, scheduled-only;
 *   - the gh read: `--event schedule`, `--repo`, the scrubbed environment;
 *   - the program entry: an extensionless or unresolvable entry is never a
 *     silent no-op;
 *   - the target: an exact TARGET, and the production relay as a promotion;
 *   - the clerk's relay key: one secret, the operator's pin or the fetched key.
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
const CLERK = (t: string) => `deploy-archetype-slate: the clerk's staged secrets ${t}`;
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
const FLAG_OVERRIDE = GATE(
  "a flag-like or too-short override is not a reason: refuses, and says why",
);
const TARGET_EXACT = GATE(
  "TARGET must be unset, staging or prod exactly: anything else refuses before anything runs",
);
const PROD_RELAY = GATE("staging apps joined to the PRODUCTION relay are gated as a promotion");
const STALE = DECISION(
  "a stale newest run: five old greens do not stand in for a stopped schedule (48 hours)",
);
const GH_READ = PROGRAM(
  "the gh read names the repository and inherits no GIT_* variable, whatever the environment says",
);
const NO_EXT_CHECK = PROGRAM(
  "check-promotion-ready run WITHOUT the .ts extension still checks: exit 1 on a red history, 0 on green",
);
const NO_EXT_SLATE = PROGRAM(
  "the slate's prod command run WITHOUT the .ts extension still gates: exit 1, flyctl never run",
);
const UNRESOLVED = PROGRAM(
  "an entry that cannot be resolved is never read as 'imported': both scripts exit non-zero and say why",
);
const CLERK_FETCHED = CLERK(
  "operator env unset: the clerk is staged the relay key fetched from the well-known descriptor",
);
const CLERK_PIN = CLERK(
  "operator env set: the clerk is staged the operator's pin; empty counts as unset",
);

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  test: TEST,
  red,
  edits,
});

const GATE_CALL =
  "  const refusal = gatePromotion(promotion, run, effects);\n  if (refusal !== null) return refusal;\n";
const DEPLOY_CALL =
  '      sh("flyctl", ["deploy", "--config", svc.config(target), "-a", app, "--remote-only"]);\n';
const ENTRY_CANDIDATES =
  '  for (const candidate of [entry, `${entry}.ts`, entry.replace(/\\.js$/, ".ts")]) {';
const ENTRY_THROW = "  throw new Error(\n    `${fileURLToPath(moduleUrl)}: cannot tell whether";
/** The original regression: no `.ts` candidate, and an unresolved entry reads as "imported". */
const SILENT_FALSE: TamperEdit[] = [
  edit(READY, ENTRY_CANDIDATES, "  for (const candidate of [entry]) {"),
  edit(READY, ENTRY_THROW, `  if (true as boolean) return false;\n${ENTRY_THROW}`),
];
const CLERK_KEY = "      MOTEBIT_RELAY_PUBLIC_KEY: ctx.clerkRelayPublicKey,";
const OPERATOR_PIN =
  '  const operatorPin = (env["MOTEBIT_RELAY_PUBLIC_KEY"] ?? "").trim().toLowerCase();';
const CLI = (t: string) => `check-promotion-ready CLI ${t}`;

const TAMPERS: TamperEntry[] = [
  // --- the gate ---------------------------------------------------------
  entry(
    "the slate never reads readiness (the call is removed)",
    REFUSES_RED,
    edit(
      SLATE,
      "  const refusal = gatePromotion(promotion, run, effects);\n",
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
      `${DEPLOY_CALL}      const refusal = gatePromotion(promotion, run, effects);\n      if (refusal !== null) return refusal;\n`,
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
      '  if (overrideReason !== null) {\n    effects.error("!!! PROMOTION READINESS OVERRIDDEN !!!");',
      '  if (overrideReason !== null || (readiness.reason as string) === "gh-unreadable") {\n    effects.error("!!! PROMOTION READINESS OVERRIDDEN !!!");',
    ),
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
    "a run that is not a promotion reads readiness too (the carve-out is gone)",
    GATE("staging real run: no readiness read, and it deploys the -stg apps"),
    edit(
      SLATE,
      "  if (!promotion) return null;",
      "  if ((false as boolean) && !promotion) return null;",
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

  // --- the override -----------------------------------------------------
  entry(
    "an empty override is accepted (no length rule at all)",
    EMPTY_OVERRIDE,
    edit(
      SLATE,
      "  if (reason.length < OVERRIDE_REASON_MIN_LENGTH) return null;",
      "  if ((false as boolean) && reason.length < OVERRIDE_REASON_MIN_LENGTH) return null;",
    ),
  ),
  entry(
    "a too-short override is accepted (any non-empty value is a reason)",
    FLAG_OVERRIDE,
    edit(
      SLATE,
      "  if (reason.length < OVERRIDE_REASON_MIN_LENGTH) return null;",
      "  if (reason.length < 1) return null;",
    ),
  ),
  entry(
    "the override value is not trimmed (padding counts toward the length)",
    FLAG_OVERRIDE,
    edit(SLATE, '  const reason = (raw ?? "").trim();', '  const reason = raw ?? "";'),
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

  // --- the decision -----------------------------------------------------
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
      '  const notGreen = runs.filter((r) => r.status !== "completed" || r.conclusion !== "success");',
      '  const notGreen = runs.filter((r) => r.conclusion === "failure");',
    ),
  ),
  entry(
    "the decision: a run that has not completed counts when it says success",
    DECISION("a run that says success but is not completed does not count: not-all-green"),
    edit(
      READY,
      '  const notGreen = runs.filter((r) => r.status !== "completed" || r.conclusion !== "success");',
      '  const notGreen = runs.filter((r) => r.conclusion !== "success");',
    ),
  ),
  entry(
    "the decision: a re-run attempt counts as an unattended green",
    DECISION(
      "a re-run attempt is not an unattended green: not ready, rerun-attempt, naming the run",
    ),
    edit(
      READY,
      "  const reruns = runs.filter((r) => r.attempt !== 1);",
      "  const reruns = runs.filter((r) => r.attempt < 1);",
    ),
  ),
  entry(
    "the decision: a run on another branch counts",
    DECISION("a run on another branch does not count: not ready, wrong-branch"),
    edit(
      READY,
      "  const offBranch = runs.filter((r) => r.headBranch !== CONFORMANCE_BRANCH);",
      '  const offBranch = runs.filter((r) => r.headBranch === "");',
    ),
  ),
  entry(
    "the decision: no freshness check (old greens stand forever)",
    STALE,
    edit(
      READY,
      "  if (newestAgeHours > PROMOTION_MAX_NEWEST_RUN_AGE_HOURS) {",
      "  if ((false as boolean) && newestAgeHours > PROMOTION_MAX_NEWEST_RUN_AGE_HOURS) {",
    ),
  ),
  entry(
    "the decision: the freshness limit is raised from 48 hours to 480",
    STALE,
    edit(
      READY,
      "export const PROMOTION_MAX_NEWEST_RUN_AGE_HOURS = 48;",
      "export const PROMOTION_MAX_NEWEST_RUN_AGE_HOURS = 480;",
    ),
  ),
  entry(
    "the decision: the answer's order is trusted (no sort by date)",
    DECISION(
      "the answer's order is not trusted: an oldest-first answer with a newer red row is not ready",
    ),
    edit(READY, "    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))\n", ""),
  ),
  entry(
    "the decision: manual dispatches count toward the window",
    DECISION(
      "only scheduled runs count: a manual dispatch in the answer is thin history, never a green",
    ),
    edit(READY, '    .filter((r) => r.event === "schedule")\n', ""),
  ),

  // --- the gh read ------------------------------------------------------
  entry(
    "the gh adapter no longer asks for scheduled runs only",
    PROGRAM(
      "check-promotion-ready: asks gh for the last 5 SCHEDULED conformance runs; exit 0 ready, 1 not ready / thin / unreadable",
    ),
    edit(READY, '      "--event",\n      "schedule",\n', ""),
  ),
  entry(
    "the gh read no longer names the repository (--repo dropped)",
    GH_READ,
    edit(READY, '      "--repo",\n      CONFORMANCE_REPO,\n', ""),
  ),
  entry(
    "the gh read inherits the caller's GIT_* variables (no scrubbed env)",
    GH_READ,
    edit(READY, '    { encoding: "utf8", env: cleanEnv() },', '    { encoding: "utf8" },'),
  ),

  // --- the program entry --------------------------------------------------
  entry(
    "the silent false is back: check-promotion-ready without .ts does nothing and exits 0",
    NO_EXT_CHECK,
    ...SILENT_FALSE,
  ),
  entry(
    "the silent false is back: the slate command without .ts does nothing and exits 0",
    NO_EXT_SLATE,
    ...SILENT_FALSE,
  ),
  entry(
    "an entry that cannot be resolved reads as 'imported' (silent, exit 0)",
    UNRESOLVED,
    edit(READY, ENTRY_THROW, `  if (true as boolean) return false;\n${ENTRY_THROW}`),
  ),

  // --- the target ---------------------------------------------------------
  entry(
    "a mistyped TARGET falls through to staging again",
    TARGET_EXACT,
    edit(
      SLATE,
      '  if (rawTarget !== undefined && rawTarget !== "staging" && rawTarget !== "prod") {',
      '  if ((false as boolean) && rawTarget !== undefined && rawTarget !== "staging" && rawTarget !== "prod") {',
    ),
  ),
  entry(
    "staging apps on the production relay are not a promotion",
    PROD_RELAY,
    edit(
      SLATE,
      '  const promotion = target === "prod" || prodRelay;',
      '  const promotion = target === "prod";',
    ),
  ),
  entry(
    "the production relay's Fly host is not recognised",
    PROD_RELAY,
    edit(
      SLATE,
      'const PROD_RELAY_HOSTS: readonly string[] = ["relay.motebit.com", "motebit-sync.fly.dev"];',
      'const PROD_RELAY_HOSTS: readonly string[] = ["relay.motebit.com"];',
    ),
  ),
  entry(
    "a trailing-dot spelling of the production relay slips past",
    PROD_RELAY,
    edit(
      SLATE,
      '  return url.hostname.toLowerCase().replace(/\\.$/, "");',
      "  return url.hostname.toLowerCase();",
    ),
  ),
  entry(
    "a RELAY_URL with another scheme (or host:port read as a scheme) is accepted",
    GATE("a RELAY_URL that is not an http(s) URL refuses before anything runs"),
    edit(
      SLATE,
      '  if (url.protocol !== "https:" && url.protocol !== "http:") return null;',
      '  if ((false as boolean) && url.protocol !== "https:" && url.protocol !== "http:") return null;',
    ),
  ),

  // --- the clerk's relay key ---------------------------------------------
  entry(
    "the clerk's relay key is the env pass-through again (the fetched key is never staged)",
    CLERK_FETCHED,
    edit(
      SLATE,
      CLERK_KEY,
      '      MOTEBIT_RELAY_PUBLIC_KEY: ctx.env["MOTEBIT_RELAY_PUBLIC_KEY"] ?? "",',
    ),
  ),
  entry(
    "the operator's pin is ignored for the clerk",
    CLERK_PIN,
    edit(SLATE, CLERK_KEY, "      MOTEBIT_RELAY_PUBLIC_KEY: ctx.relayPublicKey,"),
  ),
  entry(
    "a whitespace-only operator pin counts as set",
    CLERK(
      "operator pin of whitespace only behaves as unset: the fetched key is staged, nothing warned",
    ),
    edit(
      SLATE,
      OPERATOR_PIN,
      '  const operatorPin = (env["MOTEBIT_RELAY_PUBLIC_KEY"] ?? "").toLowerCase();',
    ),
  ),
  entry(
    "the operator pin is not lower-cased before it is checked and compared",
    CLERK("operator pin in upper case or padded: normalised, matches, staged lower-case"),
    edit(
      SLATE,
      OPERATOR_PIN,
      '  const operatorPin = (env["MOTEBIT_RELAY_PUBLIC_KEY"] ?? "").trim();',
    ),
  ),
  entry(
    "the operator pin's format is not checked (anything is staged)",
    CLERK(
      "operator pin that is not 64 hex characters: refused on staging and prod alike, value not echoed",
    ),
    edit(
      SLATE,
      "    if (!RELAY_KEY_FORMAT.test(operatorPin)) {",
      "    if ((false as boolean) && !RELAY_KEY_FORMAT.test(operatorPin)) {",
    ),
  ),
  entry(
    "a pin that disagrees with the relay no longer refuses a promotion",
    CLERK("operator pin MISMATCH on a promotion: refused, zero flyctl calls, both keys named"),
    edit(
      SLATE,
      "      if (promotion && run) {",
      "      if ((false as boolean) && promotion && run) {",
    ),
  ),
  entry(
    "a pin that disagrees with the relay proceeds on staging without a warning",
    CLERK(
      "operator pin MISMATCH on a staging run: warned loudly, proceeds with the operator's value",
    ),
    edit(SLATE, "      effects.error(`!!! WARNING: ${disagree}. ${consequence}`);\n", ""),
  ),
  entry(
    "a promotion without the operator's pin falls back to the fetched key again",
    CLERK(
      "operator pin unset on a PROMOTION: refused, zero flyctl calls; the fetched key is not a pin",
    ),
    edit(SLATE, "  const pinRequired = promotion;", "  const pinRequired = false as boolean;"),
  ),
  entry(
    "a promotion prints the full fetched key (a value to copy, not a cross-check)",
    CLERK(
      "operator pin unset on a PROMOTION: refused, zero flyctl calls; the fetched key is not a pin",
    ),
    edit(
      SLATE,
      "${promotion ? `${keyEnds(relayPublicKey)} (first",
      "${(false as boolean) ? `${keyEnds(relayPublicKey)} (first",
    ),
  ),

  // --- round three: the window, the rows, the repairs, the .js entry -------
  entry(
    "the decision: no gap bound (one green today adopts four from August)",
    DECISION("the window must be consecutive: no two counted runs more than 48 hours apart"),
    edit(
      READY,
      "    if (hours > PROMOTION_MAX_RUN_GAP_HOURS) {",
      "    if ((false as boolean) && hours > PROMOTION_MAX_RUN_GAP_HOURS) {",
    ),
  ),
  entry(
    "the decision: a run listed twice counts twice",
    DECISION("a run listed twice counts once: five copies of one green run are thin history"),
    edit(
      READY,
      "      if (seen.has(r.url)) return false;",
      "      if ((false as boolean) && seen.has(r.url)) return false;",
    ),
  ),
  entry(
    "a run in progress gets the failure repair, not the re-check one",
    CLI("a run still in progress reads `in progress`, with the re-check repair: exit 1"),
    edit(
      READY,
      "      if (result.failing.every(inProgress)) {",
      "      if ((false as boolean) && result.failing.every(inProgress)) {",
    ),
  ),
  entry(
    "a run in progress is printed with its empty conclusion",
    CLI("a run still in progress reads `in progress`, with the re-check repair: exit 1"),
    edit(
      READY,
      '  if (inProgress(r)) return "in progress";',
      '  if ((false as boolean) && inProgress(r)) return "in progress";',
    ),
  ),
  entry(
    "an older gh's unknown-field error gets the install-and-authenticate repair",
    CLI("an older gh that does not know a field: exit 1, and the repair is to upgrade gh"),
    edit(
      READY,
      '      if (result.detail.includes("Unknown JSON field")) {',
      '      if ((false as boolean) && result.detail.includes("Unknown JSON field")) {',
    ),
  ),
  entry(
    "a .js entry name is not resolved to the .ts file (unresolved: throws instead of running)",
    PROGRAM(
      "both scripts run by a .js name (tsx maps it to the .ts file) still run: exit 1 on a red history",
    ),
    edit(READY, ENTRY_CANDIDATES, "  for (const candidate of [entry, `${entry}.ts`]) {"),
  ),
];

await runTampers(TAMPERS, { root: ROOT });
