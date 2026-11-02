/**
 * Tamper checks for milestone B build step 3 — `motebit repo-task delegate`
 * and `revoke`, the principal's side of a governed repo change
 * (docs/proposals/governed-repo-change-v1.md, "Build order" step 3).
 *
 * The mint self-checks what it produces with the run's authority law before
 * anything is written. Each entry removes that self-check (once per refusal
 * test, so every refusal is shown to rest on it), or one construction rule the
 * self-check would otherwise catch, and names the test that must go red.
 *
 *   npx tsx scripts/tampers/repo-task-delegate.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const MINT = "apps/cli/src/repo-task/delegation.ts";
const TEST = "src/repo-task/__tests__/delegation.test.ts";

const OK = "repo-task delegate: the principal signs a scope, a grant and one tick";
const NO = "repo-task delegate: a delegation that would not verify writes nothing";
const REV = "repo-task revoke: a revocation that binds the grant, from its delegator only";

const edit = (from: string, to: string): TamperEdit => ({ file: MINT, from, to });
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  pkg: "motebit",
  test: TEST,
  red,
  only: true,
  edits,
});

/** The delegate mint's self-check: refuse when the artifacts would not verify. */
const NO_SELF_CHECK = edit(
  "  if (!check.ok) throw new RepoTaskDelegationRefusedError(check.failures);\n",
  "  void check;\n",
);

const TAMPERS: TamperEntry[] = [
  entry(
    "delegate: no self-check (self-delegation)",
    `${NO} refuses self-delegation`,
    NO_SELF_CHECK,
  ),
  entry(
    "delegate: no self-check (non-canonical path)",
    `${NO} refuses a non-canonical path`,
    NO_SELF_CHECK,
  ),
  entry(
    "delegate: no self-check (duplicate path)",
    `${NO} refuses a duplicate path`,
    NO_SELF_CHECK,
  ),
  entry(
    "delegate: no self-check (lifetime over 24h)",
    `${NO} refuses a lifetime over 24 hours`,
    NO_SELF_CHECK,
  ),
  entry(
    "delegate: no self-check (unknown tool)",
    `${NO} refuses a tool outside the repo-change tools`,
    NO_SELF_CHECK,
  ),
  entry(
    "delegate: a signer's key refusal escapes as a crash, not a refusal",
    `${NO} refuses a delegate key that is not in its one spelling`,
    edit(
      "    p.catch((err: unknown) => {\n",
      "    p.catch((err: unknown) => {\n      if (err) throw err;\n",
    ),
  ),
  entry(
    "delegate: cadence one ms below the lifetime",
    `${OK} cadence below the lifetime is impossible by construction`,
    edit("      cadence_ms: lifetimeMs,\n", "      cadence_ms: lifetimeMs - 1,\n"),
  ),
  entry(
    "delegate: self-check judged at the signing time, not when the window opens",
    `${OK} a not_before delegation opens at not_before and not before`,
    edit("    windowOpens(minted),\n", "    now,\n"),
  ),
  entry(
    "delegate: subject_binding digests another scope",
    `${OK} writes canonical files that the run's authority law accepts`,
    edit(
      "        digest: await canonicalSha256(scope),\n",
      '        digest: await canonicalSha256({ ...scope, task: "" }),\n',
    ),
  ),
  entry(
    "delegate: an existing file is overwritten",
    `${OK} a second delegate into the same directory overwrites nothing`,
    edit('{ flag: "wx", mode: 0o600 }', '{ flag: "w", mode: 0o600 }'),
  ),
  entry(
    "revoke: a revocation that binds nothing is accepted",
    `${REV} refuses a key that is not the grant's delegator key`,
    edit("  if (!binds) {\n", "  if ((false as boolean) && !binds) {\n"),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
