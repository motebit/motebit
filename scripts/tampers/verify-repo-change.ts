/**
 * Tamper checks for milestone B build step 4c-i — `motebit-verify repo-change`
 * in CI-on-PR mode (spec/repo-change-v1.md §7, §9): the inputs
 * `@motebit/verify/git` computes for `verifyRepoChange` from a repository.
 *
 * Each entry removes the computation of one input source (the bundle, the
 * entries, the tracked paths, the policy and pins read at the base, the
 * revocations, spent), one shape check, the every-axis rule, or the isolated
 * session, and names the test that must go red.
 *
 *   npx tsx scripts/tampers/verify-repo-change.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const RC = "packages/verify/src/git/repo-change.ts";
const STATE = "packages/verify/src/git/state.ts";
const SESSION = "packages/verify/src/git/session.ts";
const TEST = "src/__tests__/repo-change.test.ts";

const OK =
  "motebit-verify repo-change: a governed pull request is fully verified, pinned, fresh, with outcome completed";
const INPUT = "motebit-verify repo-change: every input source can fail the verdict";
const SHAPE = "motebit-verify repo-change: every shape check folds into integrity";
const MODIFY = "motebit-verify repo-change: a pull request that modifies or deletes a bundle";
const ISOLATION =
  "motebit-verify repo-change: the repository's own config is never read a core.fsmonitor program in .git/config never runs, and a config git cannot parse is never read";

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  pkg: "@motebit/verify",
  test: TEST,
  red,
  only: true,
  edits,
});
/** Disable an `if (<guard>` whose condition is one `&&` chain (no top-level `||`). */
const off = (file: string, guard: string): TamperEdit =>
  edit(file, `  if (${guard}`, `  if ((false as boolean) && ${guard}`);

const TAMPERS: TamperEntry[] = [
  // ── input sources ──────────────────────────────────────────────────────
  entry(
    "bundle: re-serialized from the six keys, not the committed bytes",
    `${INPUT} the bundle: an extra key`,
    edit(
      RC,
      "    bundle = await readBlob(git, added[0]!.blob);\n",
      "    bundle = new TextEncoder().encode(JSON.stringify((({ spec, scope, grant, tick, tool_receipts, receipt }: Record<string, unknown>) => ({ spec, scope, grant, tick, tool_receipts, receipt }))(JSON.parse(new TextDecoder().decode(await readBlob(git, added[0]!.blob))) as Record<string, unknown>)));\n",
    ),
  ),
  entry(
    "entries: only the first entry judged",
    `${INPUT} the entries: a change outside the scope`,
    edit(
      RC,
      "  const entries = await computeEntries(git, baseTree, changeTree);\n",
      "  const entries = (await computeEntries(git, baseTree, changeTree)).slice(0, 1);\n",
    ),
  ),
  entry(
    "entries: taken against the pull request head (the bundle counted as a change)",
    OK,
    edit(
      RC,
      "  const entries = await computeEntries(git, baseTree, changeTree);\n",
      "  const entries = await computeEntries(git, baseTree, headTree);\n",
    ),
  ),
  entry(
    "tracked paths: none supplied",
    `${INPUT} the tracked paths: the base's tree (a case collision with a tracked path)`,
    edit(RC, "    trackedPaths: baseTree.map((e) => e.path),\n", "    trackedPaths: [],\n"),
  ),
  entry(
    "policy and pins: read from the pull request head, not the base",
    `${INPUT} the path policy: read at the base, never from the head that widens it`,
    edit(
      RC,
      "  const state = await readRepoState(git, base, baseTree);\n",
      "  const state = await readRepoState(git, head, await listTree(git, head));\n",
    ),
  ),
  entry(
    "pins: a missing principal pin not named",
    `${INPUT} the pins: a missing principal pin`,
    edit(
      STATE,
      "  if (pf === undefined) refusals.push(`no principal pin at the tip (${PRINCIPAL_PIN_FILE})`);\n",
      "  if (pf === undefined) void PRINCIPAL_PIN_FILE;\n",
    ),
  ),
  entry(
    "pins: a missing principal pin filled from another pin",
    `${INPUT} the pins: a missing principal pin`,
    edit(
      RC,
      "    pins: { principal: state.principal, agents: state.agents },\n",
      "    pins: { principal: state.principal ?? state.agents[0] ?? null, agents: state.agents },\n",
    ),
  ),
  entry(
    "revocations: the set read at the base not supplied",
    `${INPUT} the revocations: a revoked grant`,
    edit(RC, "      set: state.revocations.set,\n", "      set: [],\n"),
  ),
  entry(
    "revocations: the files that failed strict parsing not supplied",
    `${INPUT} the revocations: a file at the base that fails strict parsing is unchecked, never fresh`,
    edit(RC, "      failures: state.revocations.failures,\n", "      failures: [],\n"),
  ),
  entry(
    "spent: never computed",
    `${INPUT} spent: the bundle path once existed on the base's first-parent history`,
    edit(
      RC,
      "    record.grantId !== null && isCanonicalGrantId(record.grantId)\n",
      "    (false as boolean) && record.grantId !== null && isCanonicalGrantId(record.grantId)\n",
    ),
  ),
  entry(
    "spent: read on the pull request's history, not the base's",
    OK,
    edit(
      RC,
      "      ? await isGrantSpent(git, base, record.grantId, pr.commonDir)\n",
      "      ? await isGrantSpent(git, head, record.grantId, pr.commonDir)\n",
    ),
  ),
  // ── shape checks ───────────────────────────────────────────────────────
  entry(
    "shape: parent_commit not compared with the base",
    `${SHAPE} parent_commit is not the base (main moved on)`,
    off(RC, "record.parentCommit !== base)"),
  ),
  entry(
    "shape: the pull request not required to be two linear commits on the base",
    `${SHAPE} three commits, not two`,
    edit(
      RC,
      "  if (changeParents.length !== 1 || changeParents[0] !== base) {\n",
      "  if ((false as boolean) && (changeParents.length !== 1 || changeParents[0] !== base)) {\n",
    ),
  ),
  entry(
    "shape: the pull request head not required to be one non-merge commit",
    `${SHAPE} a pull request head with no parent`,
    off(RC, "changeCommit === null) {\n    shapes.push("),
  ),
  entry(
    "shape: head_commit not compared with the bundle commit's parent",
    `${SHAPE} head_commit is not the bundle commit's parent`,
    off(RC, "changeCommit !== null && record.headCommit !== changeCommit) {"),
  ),
  entry(
    "shape: head_commit..pr_head not required to be exactly one A 100644 at the bundle path",
    `${SHAPE} an extra entry in the bundle commit`,
    edit(
      RC,
      "    shapes.push(\n      `head_commit..bundle_commit is not exactly one A 100644",
      "    ([] as string[]).push(\n      `head_commit..bundle_commit is not exactly one A 100644",
    ),
  ),
  entry(
    "shape: a pull request that adds no bundle not named",
    `${SHAPE} a pull request that adds no bundle (its head is the change commit)`,
    edit(
      RC,
      "    shapes.push(\n      `the pull request does not add exactly one regular file",
      "    ([] as string[]).push(\n      `the pull request does not add exactly one regular file",
    ),
  ),
  entry(
    "shape: the base ref not checked",
    `${SHAPE} the wrong base ref`,
    off(RC, "pr.baseRef !== REPO_TASK_BASE_REF) {"),
  ),
  entry(
    "shape: the author not checked",
    `${SHAPE} the wrong author`,
    off(RC, "pr.prAuthor !== null && pr.prAuthor !== REPO_CHANGE_PUBLISHER) {"),
  ),
  entry(
    "shape: an edit under .motebit/bundles/ not refused",
    `${SHAPE} an edit under .motebit/bundles/`,
    edit(
      RC,
      '    if (e.kind !== "add" && pathKey(e.path).startsWith(BUNDLES_DIR)) {\n',
      '    if ((false as boolean) && e.kind !== "add" && pathKey(e.path).startsWith(BUNDLES_DIR)) {\n',
    ),
  ),
  entry(
    "shape: a change entry under .motebit/bundles/ not refused",
    `${SHAPE} a change entry under .motebit/bundles/`,
    edit(
      RC,
      "    if (pathKey(e.path).startsWith(BUNDLES_DIR)) {\n      shapes.push(",
      "    if ((false as boolean) && pathKey(e.path).startsWith(BUNDLES_DIR)) {\n      shapes.push(",
    ),
  ),
  entry(
    "shape: the expected repository a constant, not the caller's",
    `${SHAPE} the wrong repository`,
    edit(RC, "    expectedRepo: pr.repository,\n", '    expectedRepo: "motebit/motebit",\n'),
  ),
  entry(
    "every axis: the bundle dropped when a shape check fails",
    `${SHAPE} a failing shape check still reports every axis`,
    edit(
      RC,
      "  const input: VerifyRepoChangeInput = {\n",
      "  if (shapes.length > 0) bundle = new Uint8Array();\n  const input: VerifyRepoChangeInput = {\n",
    ),
  ),
  // ── a modified or deleted bundle (§9: every axis still computed) ────────
  entry(
    "modified bundle: only an added bundle read (a modify judged as no bundle)",
    `${MODIFY} a second bundle under a grant whose first bundle landed is judged on every axis: spent`,
    off(RC, "added.length === 0 && modified.length === 1"),
  ),
  entry(
    "modified bundle: garbage at the head not read (no bundle path reported)",
    `${MODIFY} a modified bundle that is garbage at the head is malformed, never a crash`,
    off(RC, "added.length === 0 && modified.length === 1"),
  ),
  entry(
    "deleted bundle: the deleted blob read as the bundle judged",
    `${MODIFY} a pull request that only deletes a landed bundle has no bundle to judge`,
    edit(
      RC,
      '      (e) => e.kind === "modify" && pathKey(e.path).startsWith(BUNDLES_DIR),\n',
      '      (e) => e.kind !== "add" && pathKey(e.path).startsWith(BUNDLES_DIR),\n',
    ),
  ),
  // ── isolation ──────────────────────────────────────────────────────────
  entry(
    "isolation: git run on the repository's own git directory (its config read)",
    ISOLATION,
    edit(SESSION, "    GIT_DIR: privateRepo,\n", "    GIT_DIR: path.dirname(objectDirectory),\n"),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
