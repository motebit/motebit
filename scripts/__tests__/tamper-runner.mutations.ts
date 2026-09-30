#!/usr/bin/env node
/**
 * Mutations of the tamper runner itself: each entry removes ONE of its
 * anti-false-RED guarantees and names the self-test that must go red. Run by
 * the runner (so the law applies to its own proof: a green baseline of every
 * self-test file first, then a positive, exactly-named failure per mutation).
 *
 *   node scripts/__tests__/tamper-runner.mutations.ts [--concurrency=N]
 *
 * M1-M8 are the eight mutations a cold review of a8b2a8e found the old
 * self-test did not catch; N1-N12 remove one clause of the evidence law or
 * the isolation fixes each. Every entry must print RED (ok).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers } from "../lib/tamper-runner.ts";
import type { TamperEntry } from "../lib/tamper-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RUNNER = "scripts/lib/tamper-runner.ts";

const VERDICTS = { test: "scripts/__tests__/tamper-runner.test.ts" };
const ISOLATION = { test: "scripts/__tests__/tamper-runner.isolation.test.ts" };
const LIFECYCLE = { test: "scripts/__tests__/tamper-runner.lifecycle.test.ts" };

const edit = (from: string, to: string) => ({ file: RUNNER, from, to });
const NEVER = "if (false as boolean) {";

const MUTATIONS: TamperEntry[] = [
  // --- the eight a8b2a8e's self-test missed
  {
    name: "M1 no output restore (rebuilt ignored outputs neither restored nor verified)",
    ...ISOLATION,
    red: "tamper-runner isolation C4: an ignored output a rebuild changed (dist/ and a non-dist out/) is restored before the next tamper",
    edits: [
      edit("  const now = ignoredState(dir);\n", "  const now = slot.pristineIgnored;\n"),
      edit("  const ign = ignoredState(dir);\n", "  const ign = slot.pristineIgnored;\n"),
    ],
  },
  {
    name: "M2 no caller-tree-changed guard",
    ...ISOLATION,
    red: "tamper-runner isolation a check that writes into the caller's tree fails the run (exit 2)",
    edits: [edit("  if (treeFingerprint(root) !== start) {", `  ${NEVER}`)],
  },
  {
    name: "M3 red ignores the named test",
    ...VERDICTS,
    red: "tamper-runner evidence C3: red naming a test that stays green is GREEN even when a sibling fails",
    edits: [edit("  if (red != null) {", `  ${NEVER}`)],
  },
  {
    name: "M4 shared TMPDIR",
    ...ISOLATION,
    red: "tamper-runner isolation each copy has a private TMPDIR",
    edits: [
      edit(
        "  return { ...process.env, TMPDIR: slot.tmp, TMP: slot.tmp, TEMP: slot.tmp };",
        "  return { ...process.env };",
      ),
    ],
  },
  {
    name: "M5 no ignored-state copy",
    ...ISOLATION,
    red: "tamper-runner isolation P1: a hoisted store link resolves to the copy's workspace package, not the caller's",
    edits: [
      edit(
        "  for (const p of plan.ignored) {\n    const src = join(root, p);",
        "  for (const p of [] as string[]) {\n    const src = join(root, p);",
      ),
    ],
  },
  {
    name: "M6 BUILD FAILED never reported",
    ...ISOLATION,
    red: "tamper-runner isolation a rebuild that fails reports BUILD FAILED",
    edits: [edit("        if (b.code !== 0) {", `        ${NEVER}`)],
  },
  {
    name: "M7 no restore verification (hash check, git status, overlay, ignored state)",
    ...ISOLATION,
    red: "tamper-runner isolation a copy a check left dirty (tracked file) is never reused: exit 2",
    edits: [
      edit("    if (sha(readFileSync(abs)) !== sha(orig.bytes)) {", `    ${NEVER}`),
      edit("  verifySlot(slot, plan);\n}", "}"),
    ],
  },
  {
    name: "M8 no SIGINT cleanup",
    ...LIFECYCLE,
    red: "tamper-runner lifecycle a SIGINT mid-tamper kills the running test and removes every copy",
    edits: [edit('  process.on("SIGINT", onSignal);\n', "")],
  },
  // --- one per clause of the law and per isolation fix
  {
    name: "N1 no baseline gate (a failing baseline is ignored)",
    ...VERDICTS,
    red: "tamper-runner evidence C2: a misspelled test file aborts at the baseline (exit 2), never RED",
    edits: [
      edit(
        "      if (problem != null) state.baselineFailed.push({ label: g.label, problem });",
        "      void problem;",
      ),
    ],
  },
  {
    name: "N1b no baseline gate: an outside port holder",
    ...ISOLATION,
    red: "tamper-runner isolation C1: a fixed port held outside the run aborts it at the baseline, never a false RED",
    edits: [
      edit(
        "      if (problem != null) state.baselineFailed.push({ label: g.label, problem });",
        "      void problem;",
      ),
      // …and a tamper's failure counted without a baseline pass.
      edit(
        "  const bites = failed.filter((n) => baselinePassed.has(n));",
        "  const bites = failed;",
      ),
    ],
  },
  {
    name: "N2 verdict from the exit code",
    ...VERDICTS,
    red: "tamper-runner evidence C2: a tamper that breaks collection (a syntax error) is INCONCLUSIVE, never RED",
    edits: [
      edit(
        '  const bad = unusable(ev);\n  if (bad != null) return { verdict: "INCONCLUSIVE", detail: `(${bad})\\n${tail(ev.out)}` };',
        '  if (ev.code !== 0) return { verdict: "RED" };\n  const bad = unusable(ev);\n  if (bad != null) return { verdict: "INCONCLUSIVE", detail: `(${bad})\\n${tail(ev.out)}` };',
      ),
    ],
  },
  {
    name: "N3 red matched by substring",
    ...VERDICTS,
    red: "tamper-runner evidence C3: red naming only the describe block does not count a failing sibling",
    edits: [
      edit(
        "    const list = ev.tests.get(red);",
        "    red = [...ev.tests.keys()].find((n) => n.includes(red!)) ?? red;\n    const list = ev.tests.get(red);",
      ),
    ],
  },
  {
    name: "N4 no grouping (each entry its own slot)",
    ...ISOLATION,
    red: "tamper-runner isolation C1: entries on one test file run one after another in one copy (a fixed port never collides)",
    edits: [
      edit(
        "    const { key, label } = groupKey(e);",
        "    const { key, label } = { key: String(i), label: groupKey(e).label };",
      ),
    ],
  },
  {
    name: "N5 only dist/ and *.tsbuildinfo watched (a8b2a8e's plan.outputs)",
    ...ISOLATION,
    red: "tamper-runner isolation C4: an ignored output a rebuild changed (dist/ and a non-dist out/) is restored before the next tamper",
    edits: [
      edit(
        "  for (const r of roots) visit(r);",
        '  for (const r of roots.filter((p) => basename(p) === "dist" || p.endsWith(".tsbuildinfo"))) visit(r);',
      ),
    ],
  },
  {
    name: "N6 SIGHUP not handled",
    ...LIFECYCLE,
    red: "tamper-runner lifecycle a SIGHUP mid-tamper kills the running test and removes every copy",
    edits: [edit('  process.on("SIGHUP", onSignal);\n', "")],
  },
  {
    name: "N7 no stale-slot pruning at startup",
    ...LIFECYCLE,
    red: "tamper-runner lifecycle startup removes stale copies whose owner is dead or whose directory is gone, and keeps a live one",
    edits: [edit("  for (const p of pruneStaleSlots(root))", "  for (const p of [] as string[])")],
  },
  {
    name: "N8 the .pnpm store symlinked wholesale (hoisted workspace links reach the caller)",
    ...ISOLATION,
    red: "tamper-runner isolation P1: a hoisted store link resolves to the copy's workspace package, not the caller's",
    edits: [
      edit(
        '    if (e !== ".pnpm") {',
        '    if (e === ".pnpm") {\n      symlinkSync(join(src, e), join(dst, e));\n      continue;\n    }\n    if (e !== ".pnpm") {',
      ),
    ],
  },
  {
    name: "N9 a command entry without redMarker is run and judged by its exit code",
    ...VERDICTS,
    red: "tamper-runner evidence C2: a command entry that declares no redMarker is INCONCLUSIVE, never RED",
    edits: [
      edit(
        '    if (e.command != null && (e.redMarker == null || e.redMarker === "")) {',
        `    ${NEVER}`,
      ),
      edit(
        '        if (t.code !== 0 && marked) outcome = result("RED");',
        '        if (t.code !== 0 && (marked || entry.redMarker == null)) outcome = result("RED");',
      ),
    ],
  },
  {
    name: "N10 a command's red marker ignored (any non-zero exit is RED)",
    ...VERDICTS,
    red: "tamper-runner evidence C2: a command that crashes (non-zero exit, no red marker) is INCONCLUSIVE, never RED",
    edits: [
      edit(
        '        if (t.code !== 0 && marked) outcome = result("RED");',
        '        if (t.code !== 0) outcome = result("RED");',
      ),
    ],
  },
  {
    name: "N11 unhandled errors ignored",
    ...VERDICTS,
    red: "tamper-runner evidence C2: an unhandled error with every test passing is INCONCLUSIVE, never RED",
    edits: [edit("  if (ev.unhandled.length > 0) return", "  if (false as boolean) return")],
  },
  {
    name: "N12 suite-level errors ignored",
    ...VERDICTS,
    red: "tamper-runner evidence C2: a suite-level error (a failing afterAll) next to a failing test is INCONCLUSIVE, never RED",
    edits: [edit("  if (ev.suiteErrors.length > 0) return", "  if (false as boolean) return")],
  },
];

await runTampers(MUTATIONS, { root: here });
