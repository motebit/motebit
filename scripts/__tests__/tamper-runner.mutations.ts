#!/usr/bin/env node
/**
 * Mutations of the tamper runner itself: each entry removes ONE of its
 * anti-false-RED guarantees and names the self-test that must go red. Run by
 * the runner (so the law applies to its own proof: a green baseline of every
 * self-test file first, then, per mutation, the sandwich: its named test
 * green just before, red with the mutation, green again after).
 *
 *   node scripts/__tests__/tamper-runner.mutations.ts [--concurrency=N]
 *
 * M1-M8 are the eight mutations a cold review of a8b2a8e found the old
 * self-test did not catch; N1-N12 remove one clause of the evidence law or
 * the isolation fixes each; X1-X10 and X17 are the ones a cold review of
 * ed573f1b9 found unnoticed; S1-S12 remove one clause of the sandwich law
 * (pre, post, reset, HOME, valid code, reaping); G1-G9 one clause of the
 * causation law (the second edited run, the middle unedited run, the group
 * kill, the survivor check, same test, same error class, no-op entries, the
 * group-wide flake veto). Every entry must print RED (ok).
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
const SANDWICH = { test: "scripts/__tests__/tamper-runner.sandwich.test.ts" };
const CAUSATION = { test: "scripts/__tests__/tamper-runner.causation.test.ts" };

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
    edits: [edit("    TMPDIR: tmp,\n    TMP: tmp,\n    TEMP: tmp,\n", "")],
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
    edits: [edit("      if (b.code !== 0) {", `      ${NEVER}`)],
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
    red: "tamper-runner lifecycle a SIGINT mid-tamper kills the running test (its whole process group) and removes every copy",
    edits: [edit('  process.on("SIGINT", onSignal);\n', "")],
  },
  // --- one per clause of the law and per isolation fix
  {
    name: "N1 no baseline gate (a failing baseline is ignored)",
    ...VERDICTS,
    red: "tamper-runner evidence C2: a misspelled test file aborts at the baseline (exit 2), never RED",
    edits: [
      edit(
        "        state.baselineFailed.push({ label: g.label, problem: r.problem });",
        "        void 0;",
      ),
    ],
  },
  {
    name: "N1b no baseline gate: an outside port holder",
    ...ISOLATION,
    red: "tamper-runner isolation C1: a fixed port held outside the run aborts it at the baseline, never a false RED",
    edits: [
      edit(
        "        state.baselineFailed.push({ label: g.label, problem: r.problem });",
        "        void 0;",
      ),
      // …and a tamper's failure counted without a baseline pass.
      edit("  const bites = failed.filter((n) => prePassed.has(n));", "  const bites = failed;"),
    ],
  },
  {
    name: "N2 verdict from the exit code",
    ...VERDICTS,
    red: "tamper-runner evidence C2: an unhandled error with every test passing is INCONCLUSIVE, never RED",
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
    red: "tamper-runner lifecycle a SIGHUP mid-tamper kills the running test (its whole process group) and removes every copy",
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
        '    if (t.code !== 0 && marked) return { verdict: "RED", bites: new Map() };',
        '    if (t.code !== 0 && (marked || entry.redMarker == null)) return { verdict: "RED", bites: new Map() };',
      ),
    ],
  },
  {
    name: "N10 a command's red marker ignored (any non-zero exit is RED)",
    ...VERDICTS,
    red: "tamper-runner evidence C2: a command that crashes (non-zero exit, no red marker) is INCONCLUSIVE, never RED",
    edits: [
      edit(
        '    if (t.code !== 0 && marked) return { verdict: "RED", bites: new Map() };',
        '    if (t.code !== 0) return { verdict: "RED", bites: new Map() };',
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
  // --- the cold review of ed573f1b9: mutations its self-test did not notice
  {
    name: "X1 cleanup kills only the direct child, not its process group",
    ...LIFECYCLE,
    red: "tamper-runner lifecycle a SIGINT mid-tamper kills the running test (its whole process group) and removes every copy",
    edits: [
      edit(
        '        if (c.pid != null) process.kill(-c.pid, "SIGKILL");',
        '        if (c.pid != null) process.kill(c.pid, "SIGKILL");',
      ),
    ],
  },
  {
    name: "X2 no .bin shim rewrite",
    ...ISOLATION,
    red: "tamper-runner isolation X2: a node_modules/.bin shim that bakes the tree's absolute path runs against the copy",
    edits: [edit("  rewriteBinShims(root, dir, plan.ignored);\n", "")],
  },
  {
    name: "X3 store entries linking into the workspace symlinked, not copied",
    ...ISOLATION,
    red: "tamper-runner isolation X3: a store entry whose dependency links into the workspace resolves to the copy's package",
    edits: [
      edit(
        '      if (s === "node_modules" || linksOutOfStore(store, s))',
        '      if (s === "node_modules")',
      ),
    ],
  },
  {
    name: "X4 red need not have passed before the edit",
    ...VERDICTS,
    red: "tamper-runner evidence X4: red naming a test that did not pass before the edit (one the edit adds) is never RED",
    edits: [edit("    if (!prePassed.has(red)) {", `    ${NEVER}`)],
  },
  {
    name: "X5 any failing test bites (not only one that passed before the edit)",
    ...VERDICTS,
    red: "tamper-runner evidence X5: without red, only a test that passed before the edit can bite (a new failing test cannot)",
    edits: [
      edit("  const bites = failed.filter((n) => prePassed.has(n));", "  const bites = failed;"),
    ],
  },
  {
    name: "X6 duplicate full names not rejected",
    ...VERDICTS,
    red: "tamper-runner evidence X6: red naming a full name two tests share is INCONCLUSIVE, never RED",
    edits: [edit("    if (list.length !== 1) {", `    ${NEVER}`)],
  },
  {
    name: "X7 the run-end reason ignored",
    ...VERDICTS,
    red: "tamper-runner evidence X7: a run that ended other than passed/failed (a bail: interrupted) is INCONCLUSIVE, never RED",
    edits: [
      edit(
        '  if (ev.reason !== "passed" && ev.reason !== "failed") return',
        "  if (false as boolean) return",
      ),
    ],
  },
  {
    name: "X8 results from ANY file the filter matched count as the target's",
    ...VERDICTS,
    red: "tamper-runner evidence X8: a failure in another file the filter also matched is not the target's",
    edits: [edit("    if (!isTarget(name)) continue;\n", "")],
  },
  {
    name: "X9 the baseline's exit code ignored",
    ...VERDICTS,
    red: "tamper-runner evidence X9: a baseline where every test passed but vitest exited non-zero aborts (exit 2)",
    edits: [
      edit("  if (ev.code !== 0) return `vitest exited ${ev.code} with every test passing`;\n", ""),
    ],
  },
  {
    name: "X10 overlay bytes not verified after a run",
    ...ISOLATION,
    red: "tamper-runner isolation X10: a copy whose caller-dirty (overlaid) file a check changed is never reused: exit 2",
    edits: [edit("    if (h !== plan.overlayHash.get(rel)) {", `    ${NEVER}`)],
  },
  {
    name: "X17 untracked caller bytes not fingerprinted",
    ...ISOLATION,
    red: "tamper-runner isolation X17: a check that appends to an UNTRACKED caller file fails the run (exit 2)",
    edits: [edit("      h.update(readFileSync(join(root, f)));", "      void f;")],
  },
  // --- one per clause of the sandwich law (this round's fix)
  {
    name: "S1 sandwich pre: a pre-run that is not green is ignored",
    ...SANDWICH,
    red: "tamper-runner sandwich pre: an entry whose pre-run (no edit, same slot, just before) is not green is never RED",
    edits: [edit("    if (pre.problem != null) {", `    ${NEVER}`)],
  },
  {
    name: "S2 sandwich post: no post-run",
    ...CAUSATION,
    red: "tamper-runner causation the post-run (run 5/5) must be green: state the edit left fails it",
    edits: [edit('  if (c.verdict === "RED" || !last) {', `  ${NEVER}`)],
  },
  {
    name: "S3 TMPDIR not emptied between runs",
    ...SANDWICH,
    red: "tamper-runner sandwich C1: a file a failing run left in TMPDIR does not turn the next entry red (same test file)",
    edits: [
      edit(
        "    rmSync(d, { recursive: true, force: true });",
        "    if (d !== slot.tmp) rmSync(d, { recursive: true, force: true });",
      ),
    ],
  },
  {
    name: "S3b TMPDIR not emptied: a cache from another test file",
    ...SANDWICH,
    red: "tamper-runner sandwich C1: a cache another test file left in TMPDIR does not turn later entries red (cross-file)",
    edits: [
      edit(
        "    rmSync(d, { recursive: true, force: true });",
        "    if (d !== slot.tmp) rmSync(d, { recursive: true, force: true });",
      ),
    ],
  },
  {
    name: "S4 HOME (and XDG dirs) not isolated",
    ...SANDWICH,
    red: "tamper-runner sandwich HOME: a file a failing run left in HOME (or XDG_CACHE_HOME) does not turn the next entry red",
    edits: [
      edit(
        '    HOME: home,\n    USERPROFILE: home,\n    XDG_CONFIG_HOME: join(home, ".config"),\n    XDG_CACHE_HOME: join(home, ".cache"),\n    XDG_DATA_HOME: join(home, ".local", "share"),\n    XDG_STATE_HOME: join(home, ".local", "state"),\n',
        "",
      ),
    ],
  },
  {
    name: "S5 no type-check of the edit (the compiler never asked)",
    ...CAUSATION,
    red: "tamper-runner causation C3: an edit tsc rejects (TS2551) is INCONCLUSIVE, never RED",
    edits: [edit("    if (validity.problem != null) {", `    ${NEVER}`)],
  },
  {
    name: "S6 JS edits not type-checked (checkJs off: an undefined name loads, then throws)",
    ...SANDWICH,
    red: "tamper-runner sandwich C2: an edit that names an undefined variable (static import) is INCONCLUSIVE, never RED",
    edits: [edit("checkJs: true", "checkJs: false")],
  },
  {
    name: "S8 reaping ignores the owner's host and pid namespace",
    ...LIFECYCLE,
    red: "tamper-runner lifecycle P-e: startup never reaps a dead-owner copy recorded by another host or pid namespace",
    edits: [
      edit(
        "      if (owner.host !== hostname() || owner.pidns !== pidNamespace()) continue;\n",
        "",
      ),
    ],
  },
  {
    name: "S9 startup reaps a dead run's slot without killing its process groups",
    ...LIFECYCLE,
    red: "tamper-runner lifecycle P-e: startup kills the process group a SIGKILLed run left running, then removes its copy",
    edits: [edit("      killLeftoverGroups(base, owner.pgids);\n", "")],
  },
  {
    name: "S10 the process groups a run starts are not recorded",
    ...LIFECYCLE,
    red: "tamper-runner lifecycle P-e: startup kills the process group a SIGKILLed run left running, then removes its copy",
    edits: [edit("      owner.pgids.push(pgid);\n", "")],
  },
  {
    name: "S12 sandwich post: a RED's failing tests need not pass in the post-run",
    ...CAUSATION,
    red: "tamper-runner causation each test a RED rests on must PASS in the post-run (skipped is not passed)",
    edits: [edit("        if (back.length > 0) {", `        ${NEVER}`)],
  },
  {
    name: "S11 only: the narrowing (-t) not passed to vitest",
    ...VERDICTS,
    red: "tamper-runner evidence only: runs just the red test (a failing sibling is never run)",
    edits: [edit("  if (only != null) args.push(", "  if (false as boolean) args.push(")],
  },
  // --- the causation law (round 4): one per clause, each named for what it drops
  {
    name: "G1 skip the second edited run (one observation counts)",
    ...CAUSATION,
    red: "tamper-runner causation C2: a self-enforced timeout (vi.waitFor) that does not reproduce is INCONCLUSIVE, never RED",
    edits: [
      edit(
        "  const second = await editedRun(entry, slot, plan, running, validity);",
        "  const second = first;",
      ),
    ],
  },
  {
    name: "G2 skip the middle unedited run",
    ...CAUSATION,
    red: "tamper-runner causation the unedited run BETWEEN the edited runs must be green (a failure no edit caused)",
    edits: [
      edit(
        '  const mid = await unedited("run 3/5");',
        "  const mid = { problem: null as string | null, passed: prePassed };",
      ),
    ],
  },
  {
    name: "G2b a RED's tests need not pass in the middle unedited run",
    ...SANDWICH,
    red: "tamper-runner sandwich post: a RED whose failing test the next unedited run does not pass (leaked state skipped it) is INCONCLUSIVE",
    edits: [edit("  if (midBack.length > 0) {", `  ${NEVER}`)],
  },
  {
    name: "G3 drop the process-group kill after a run",
    ...CAUSATION,
    red: "tamper-runner causation C1: a process a run leaves holding a port (FX_HOLD=1500 ms) never turns a comment-only edit red, and dies with its run",
    edits: [edit('      process.kill(-pgid, "SIGKILL");', "      void pgid;")],
  },
  {
    name: "G4 drop the survivor check (nothing verified after the kill)",
    ...CAUSATION,
    red: "tamper-runner causation C1: a process that escapes its run's process group (own session) is an orphan: the run is not green, and it is killed",
    edits: [
      edit(
        "    const found = scanProcesses(new Set([pgid]), [h]);",
        "    const found: Proc[] = [];",
      ),
    ],
  },
  {
    name: "G6 accept a different failing test in the second edited run",
    ...CAUSATION,
    red: "tamper-runner causation both edited runs must fail the SAME test (without red:, the same set)",
    edits: [
      edit(
        "  return x.size === y.size && [...x].every(([n, c]) => y.get(n) === c);",
        "  return x.size === y.size && [...x].every(([, c]) => [...y.values()].includes(c));",
      ),
    ],
  },
  {
    name: "G7 accept no-op entries",
    ...CAUSATION,
    red: "tamper-runner causation a no-op entry (no edits) aborts the run (exit 2), never runs",
    edits: [
      edit("      const noop = noopReason(root, e);", "      const noop = null as string | null;"),
    ],
  },
  {
    name: "G8 accept a different error class in the second edited run",
    ...CAUSATION,
    red: "tamper-runner causation both edited runs must fail with the same error class",
    edits: [
      edit(
        "  return x.size === y.size && [...x].every(([n, c]) => y.get(n) === c);",
        "  return x.size === y.size && [...x].every(([n]) => y.has(n));",
      ),
    ],
  },
  {
    name: "G9 a test seen failing with no edit does not void the REDs on it",
    ...CAUSATION,
    red: "tamper-runner causation a test seen failing with no edit anywhere in the run voids every RED on it",
    edits: [
      edit(
        '            if (r.verdict === "RED" && g.uneditedFailure != null) {',
        `            ${NEVER}`,
      ),
    ],
  },
];

// Every self-test is independent (each builds its own fixture), so each
// mutation runs only its red test: the sandwich runs it three times.
await runTampers(
  MUTATIONS.map((m) => ({ ...m, only: true })),
  { root: here },
);
