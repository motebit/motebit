/**
 * Tamper checks for milestone B build step 4b — `motebit repo-task run`, the
 * agent side of a governed repo change, and its change-commit and
 * bundle-commit harness (docs/proposals/governed-repo-change-v1.md § "The
 * chain", steps 4–7).
 *
 * Each entry removes one preflight rule, one bundle-shape rule, the
 * self-check's gate, or adds the write the run must never make (a ref, the
 * worktree), and names the test that must go red.
 *
 *   npx tsx scripts/tampers/repo-task-run.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const RUN = "apps/cli/src/repo-task/run-command.ts";
const PRE = "apps/cli/src/repo-task/preflight.ts";
const TIP = "apps/cli/src/repo-task/tip.ts";
const BUNDLE = "apps/cli/src/repo-task/bundle.ts";
const CMD = "apps/cli/src/subcommands/repo-task.ts";
const TEST = "src/repo-task/__tests__/run-command.test.ts";

const E2E = "repo-task run: a governed change, end to end";
const OK = `${E2E} makes the change commit and the bundle commit, verified, moving no ref`;
const REFUSE = "repo-task run: every preflight rule refuses before the first model call";
const TIP_TREE = "repo-task run: pins and policy are read from the tip's tree";
const ERASE = "repo-task run: the agent's key is erased on every exit path";

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  pkg: "motebit",
  test: TEST,
  red,
  only: true,
  edits,
});

const NO_AUTHORITY_PREFLIGHT = edit(
  RUN,
  "    if (!check.ok) {\n",
  "    if ((false as boolean) && !check.ok) {\n",
);
const NO_WORKTREE_CHECK = edit(
  RUN,
  "    if (dirty.length > 0) {\n",
  "    if ((false as boolean) && dirty.length > 0) {\n",
);
const NO_ERASE = edit(
  RUN,
  "        deps.secureErase(active.privateKey);\n",
  "        void active;\n",
);

const TAMPERS: TamperEntry[] = [
  // ── preflight: the agent identity ─────────────────────────────────────
  entry(
    "agent: the default config directory accepted as --agent",
    `${REFUSE} --agent pointing at the default config directory`,
    edit(
      RUN,
      "  if (isDefaultConfigDir(opts.agentDir, deps.defaultConfigDirs())) {\n",
      "  if ((false as boolean) && isDefaultConfigDir(opts.agentDir, deps.defaultConfigDirs())) {\n",
    ),
  ),
  entry(
    "agent: a non-canonical agent key accepted",
    `${REFUSE} a non-canonical agent key`,
    edit(RUN, "  if (fault !== null) {\n", "  if ((false as boolean) && fault !== null) {\n"),
  ),
  entry(
    "agent: A equal to the principal accepted",
    `${REFUSE} A is the principal`,
    edit(
      RUN,
      "      agentPin.motebit_id === principal.motebit_id ||\n      agentPin.public_key === principal.public_key\n",
      "      (false as boolean)\n",
    ),
  ),
  entry(
    "agent: A not an agent pin accepted",
    `${REFUSE} A is not an agent pin at the tip`,
    edit(RUN, "      !agents.some(\n", "      (false as boolean) &&\n      !agents.some(\n"),
  ),
  // ── preflight: the tip ────────────────────────────────────────────────
  entry(
    "tip: HEAD on another branch accepted",
    `${REFUSE} the tip is not on base_ref`,
    edit(TIP, "  if (m[1] !== ref) {\n", "  if ((false as boolean) && m[1] !== ref) {\n"),
  ),
  // ── preflight: pins, revocations, policy from the tip ─────────────────
  entry(
    "pins: a missing principal pin not named",
    `${REFUSE} a missing principal pin`,
    edit(
      PRE,
      "  if (pf === undefined) refusals.push(`no principal pin at the tip (${PRINCIPAL_PIN_FILE})`);\n",
      "  if (pf === undefined) void PRINCIPAL_PIN_FILE;\n",
    ),
  ),
  entry(
    "pins: the principal pin read from the worktree, not the tip",
    `${TIP_TREE} a pin edited in the worktree is not the pin`,
    edit(
      PRE,
      "  else {\n    const t = await text(pf);\n",
      '  else {\n    const t = fs.readFileSync(path.join(git.objectDirectory, "..", "..", PRINCIPAL_PIN_FILE), "utf8");\n',
    ),
  ),
  entry(
    "policy: read from the worktree, not the tip",
    `${TIP_TREE} a policy edited in the worktree is not the policy`,
    edit(
      PRE,
      "    const t = await text(pol);\n",
      '    const t = fs.readFileSync(path.join(git.objectDirectory, "..", "..", REPO_PATH_POLICY_FILE), "utf8");\n',
    ),
  ),
  entry(
    "policy: a missing policy not named",
    `${REFUSE} a missing path policy`,
    edit(
      PRE,
      "  if (pol === undefined) refusals.push(`no path policy at the tip (${REPO_PATH_POLICY_FILE})`);\n",
      "  if (pol === undefined) void REPO_PATH_POLICY_FILE;\n",
    ),
  ),
  entry(
    "policy: the run judged under a permit-all predicate",
    `${REFUSE} a scope path that fails the policy`,
    edit(
      RUN,
      "      isPathPermitted: tipState.isPathPermitted,\n      spent,\n",
      "      isPathPermitted: () => true,\n      spent,\n",
    ),
  ),
  entry(
    "revocations: the set read at the tip not handed to the authority law",
    `${REFUSE} a revoked grant`,
    edit(
      RUN,
      "      revocations: tipState.revocations,\n",
      "      revocations: { ...tipState.revocations, set: [] },\n",
    ),
  ),
  entry(
    "revocations: a file not named for its grant_id accepted",
    `${REFUSE} a malformed revocation file (its name is not its grant_id)`,
    edit(
      PRE,
      '      if (typeof grantId !== "string" || `${grantId}.json` !== name) {\n',
      '      if (typeof grantId !== "string") {\n',
    ),
  ),
  entry(
    "revocations: an unparsable file skipped, not a failure",
    `${REFUSE} an unparsable revocation file`,
    edit(PRE, "        failures.push(`${p} is not UTF-8 JSON`);\n", "        void p;\n"),
  ),
  entry(
    "spent: never spent",
    `${REFUSE} a grant already spent on the tip's first-parent history`,
    edit(PRE, '  return out.toString("latin1").trim().length > 0;\n', "  return out.length < 0;\n"),
  ),
  // ── preflight: the worktree ───────────────────────────────────────────
  ...[
    "a dirty worktree: a modified tracked file",
    "a dirty worktree: a type change",
    "a dirty worktree: a mode change",
  ].map((t) => entry(`worktree: not checked (${t})`, `${REFUSE} ${t}`, NO_WORKTREE_CHECK)),
  entry(
    "worktree: the mode not compared",
    `${REFUSE} a dirty worktree: a mode change`,
    edit(
      PRE,
      '      if (executable !== (e.mode === "100755")) {\n',
      '      if ((false as boolean) && executable !== (e.mode === "100755")) {\n',
    ),
  ),
  entry(
    "output: a receipt directory inside the repository accepted",
    `${REFUSE} an output directory inside the repository`,
    edit(RUN, "  if (inside !== null) {\n", "  if ((false as boolean) && inside !== null) {\n"),
  ),
  // ── preflight: the authority law before the key ────────────────────────
  ...["an expired tick", "a tick signature re-spelled in non-canonical base64url"].map((t) =>
    entry(`authority: not judged before the key (${t})`, `${REFUSE} ${t}`, NO_AUTHORITY_PREFLIGHT),
  ),
  // ── the bundle and the outcome ─────────────────────────────────────────
  entry(
    "bundle: an extra key",
    OK,
    edit(
      BUNDLE,
      "  return ENCODER.encode(canonicalJson(bundle));\n",
      "  return ENCODER.encode(canonicalJson({ ...bundle, extra: 1 }));\n",
    ),
  ),
  entry(
    "bundle: a non-canonical encoding",
    OK,
    edit(
      BUNDLE,
      "  return ENCODER.encode(canonicalJson(bundle));\n",
      "  return ENCODER.encode(JSON.stringify(bundle, null, 1));\n",
    ),
  ),
  entry(
    "outcome: a run that changed nothing reported completed",
    `${E2E} a run that changes nothing is failed, and exits non-zero`,
    edit(
      BUNDLE,
      '  if (ended !== "model_done" || entries.length === 0) return "failed";\n',
      '  if (ended !== "model_done") return "failed";\n',
    ),
  ),
  // ── the self-check ─────────────────────────────────────────────────────
  entry(
    "self-check: its verdict ignored by the command",
    `${E2E} a self-check that does not fully verify exits non-zero, publishing nothing`,
    edit(
      CMD,
      "    if (!report.accepted) {\n",
      "    if ((false as boolean) && !report.accepted) {\n",
    ),
  ),
  entry(
    "self-check: accepted without a verdict",
    `${E2E} a self-check that does not fully verify exits non-zero, publishing nothing`,
    edit(
      RUN,
      '    const accepted = isFullyVerified(verification.verdict) && verification.outcome === "completed";\n',
      "    const accepted = true as boolean;\n",
    ),
  ),
  // ── what the run must never write ──────────────────────────────────────
  entry(
    "refs: the base branch moved to the bundle commit",
    OK,
    edit(
      RUN,
      "    // -- The self-check. EVIDENCE, NOT AUTHORITY",
      '    fs.writeFileSync(path.join(tipInfo.commonDir, "refs", "heads", "main"), `${bundleCommit}\\n`);\n    // -- The self-check. EVIDENCE, NOT AUTHORITY',
    ),
  ),
  entry(
    "refs: a branch created for the bundle commit",
    OK,
    edit(
      RUN,
      "    // -- The self-check. EVIDENCE, NOT AUTHORITY",
      '    fs.writeFileSync(path.join(tipInfo.commonDir, "refs", "heads", "repo-task"), `${bundleCommit}\\n`);\n    // -- The self-check. EVIDENCE, NOT AUTHORITY',
    ),
  ),
  entry(
    "worktree: the change written to the worktree",
    OK,
    edit(
      RUN,
      "    // -- The self-check. EVIDENCE, NOT AUTHORITY",
      '    fs.appendFileSync(path.join(repoDir, "docs", "guide.md"), "x");\n    // -- The self-check. EVIDENCE, NOT AUTHORITY',
    ),
  ),
  // ── path identity by the filesystem, never by spelling ─────────────────
  entry(
    "agent: the default config dir judged by spelling only (hard-linked config)",
    `${REFUSE} --agent whose config.json is a hard link to the default config`,
    edit(
      "apps/cli/src/repo-task/agent-identity.ts",
      "  if (defaults.includes(realOrResolved(dir))) return true;\n  return defaults.some(",
      "  if (defaults.includes(realOrResolved(dir))) return true;\n  return [].some(",
    ),
  ),
  entry(
    "agent: the default config dir judged by spelling only (case alias)",
    `${REFUSE} --agent naming the default config directory by a case alias`,
    edit(
      "apps/cli/src/repo-task/agent-identity.ts",
      "  if (defaults.includes(realOrResolved(dir))) return true;\n  return defaults.some(",
      "  if (defaults.includes(realOrResolved(dir))) return true;\n  return [].some(",
    ),
  ),
  entry(
    "output: inside-the-repository judged by spelling only (case alias)",
    `${REFUSE} an output directory inside a separate git directory named by a case alias`,
    edit(
      "apps/cli/src/repo-task/fs-identity.ts",
      "    if (fileIdentity(cur) === target) return true;\n",
      "    if (cur === path.resolve(parent)) return true;\n",
    ),
  ),
  entry(
    "output: the repository's git directories not forbidden",
    `${REFUSE} an output directory inside a separate git directory`,
    edit(
      RUN,
      "  if (isWithinEntry(outputDir, tipInfo.gitDir) || isWithinEntry(outputDir, tipInfo.commonDir)) {\n",
      "  if ((false as boolean) && isWithinEntry(outputDir, tipInfo.gitDir)) {\n",
    ),
  ),
  ...[
    "an output directory inside another worktree of the same repository",
    "an output directory inside the main worktree of a repository with a separate git dir",
    "an output directory inside a linked worktree moved without a repair",
  ].map((t) =>
    entry(
      `output: another worktree of the repository not recognised (${t.split(" inside ")[1]})`,
      `${REFUSE} ${t}`,
      edit(
        RUN,
        "      if (isSameEntry(common, tipInfo.commonDir)) return `inside the repository's worktree ${cur}`;\n",
        "",
      ),
    ),
  ),
  // ── the agent's key ────────────────────────────────────────────────────
  ...["on success", "on a refusal after the key is unlocked", "on a thrown error"].map((t) =>
    entry(`erase: the key never erased (${t})`, `${ERASE} ${t}`, NO_ERASE),
  ),
  // The runtime's own copy of the key (the CLI erases only its own buffer).
  ...[
    "after a completed run, the buffer that signed is all zeros; the caller's is untouched",
    "after a run that throws mid-way, the buffer that signed is all zeros",
  ].map((t) => ({
    name: `erase: the runtime's key copy never erased (${t.split(",")[0]})`,
    pkg: "@motebit/runtime",
    test: "src/__tests__/repo-task-key-erasure.test.ts",
    red: `repo task: the run's copy of the agent key is erased on every exit ${t}`,
    only: true,
    edits: [edit("packages/runtime/src/repo-task/run.ts", "    privateKey.fill(0);\n", "")],
  })),
];

void runTampers(TAMPERS, { root: ROOT });
