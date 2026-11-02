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
const CMD = "apps/cli/src/subcommands/repo-task.ts";
const TEST = "src/repo-task/__tests__/delegation.test.ts";
const CMD_TEST = "src/repo-task/__tests__/delegation-commands.test.ts";

const OK = "repo-task delegate: the principal signs a scope, a grant and one tick";
const NO = "repo-task delegate: a delegation that would not verify writes nothing";
const REV = "repo-task revoke: a revocation that binds the grant, from its delegator only";
const REV2 = "repo-task revoke: only a grant the principal signed, read from its own file";
const FILES = "repo-task files: owner-only, exclusive, all or nothing";
const PRE = "repo-task delegate: a refusal that needs no key never unlocks it";
const ERASE = "repo-task delegate and revoke: the key is erased before any exit";
const PRE_REV = "repo-task revoke: a delegation the principal did not sign never unlocks the key";
const NO_REVOKE_PRECHECK = {
  file: "apps/cli/src/subcommands/repo-task.ts",
  from: '    if (pre.length > 0) {\n      refuse(\n        ["Refused before signing — this is not a delegation',
  to: '    if ((false as boolean) && pre.length > 0) {\n      refuse(\n        ["Refused before signing — this is not a delegation',
};

const edit = (from: string, to: string, file = MINT): TamperEdit => ({ file, from, to });
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  pkg: "motebit",
  test: TEST,
  red,
  only: true,
  edits,
});

const command = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  ...entry(name, red, ...edits),
  test: CMD_TEST,
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
    edit('fs.openSync(file, "wx", 0o600)', 'fs.openSync(file, "w", 0o600)'),
  ),
  entry(
    "revoke: a revocation that binds nothing is accepted",
    `${REV} refuses a key that is not the grant's delegator key`,
    edit(
      '  if (!failures.some((f) => f.code === "revocation.repo_change.revoked")) {\n',
      '  if ((false as boolean) && !failures.some((f) => f.code === "revocation.repo_change.revoked")) {\n',
    ),
  ),
  // ── cold review round 1 ───────────────────────────────────────────────
  entry(
    "revoke: an integrity fault of the grant is tolerated (forged grant_id)",
    `${REV2} refuses a grant whose signature does not verify (a forged grant_id)`,
    edit(
      "  if (integrity.length > 0) throw new RepoTaskDelegationRefusedError(integrity);\n",
      "  void integrity;\n",
    ),
  ),
  entry(
    "revoke: a malformed tick falls through to the wrong-key report",
    `${REV2} a malformed tick is reported as malformed, never as a wrong key`,
    edit(
      "  if (integrity.length > 0) throw new RepoTaskDelegationRefusedError(integrity);\n",
      "  void integrity;\n",
    ),
  ),
  entry(
    "revoke: any file name is read as its directory's grant.json",
    `${REV2} a file argument is read only as the delegation's grant.json`,
    edit(
      "    if (path.basename(arg) === DELEGATION_FILES.grant) return path.dirname(arg);\n",
      "    return path.dirname(arg);\n",
      CMD,
    ),
  ),
  entry(
    "files: a file is recorded only after its write (a partial survives)",
    `${FILES} a write that fails midway leaves no file, no partial and no directory it created`,
    edit(
      '      const fd = fs.openSync(file, "wx", 0o600);\n      written.push(file);\n',
      '      const fd = fs.openSync(file, "wx", 0o600);\n',
    ),
    edit(
      "        fs.closeSync(fd);\n      }\n",
      "        fs.closeSync(fd);\n      }\n      written.push(file);\n",
    ),
  ),
  entry(
    "files: no rollback of the files written",
    `${FILES} a write that fails midway in an existing directory removes only what it wrote`,
    edit(
      "    for (const file of written) fs.rmSync(file, { force: true });\n",
      "    void written;\n",
    ),
  ),
  entry(
    "files: the directories this call made are left behind",
    `${FILES} a write that fails midway leaves no file, no partial and no directory it created`,
    edit("    if (created !== null) {\n", "    if ((false as boolean) && created !== null) {\n"),
  ),
  entry(
    "files: 0644 files",
    `${FILES} files are 0600 and a directory it creates is 0700`,
    edit('fs.openSync(file, "wx", 0o600)', 'fs.openSync(file, "wx", 0o644)'),
  ),
  entry(
    "files: a plain mkdir",
    `${FILES} files are 0600 and a directory it creates is 0700`,
    edit("    mkdirOwnerOnly(dir);\n", "    fs.mkdirSync(dir, { recursive: true });\n"),
  ),
  command(
    "precheck: no lifetime rule before the key",
    `${PRE} --hours 25`,
    edit("    req.lifetimeMs > REPO_CHANGE_MAX_GRANT_LIFETIME_MS\n", "    (false as boolean)\n"),
  ),
  command(
    "precheck: no canonical-path rule before the key",
    `${PRE} a non-canonical --path`,
    edit(
      "    if (!isCanonicalRepoPath(p)) refuse(`path ${JSON.stringify(p)} is not canonical`);\n",
      "",
    ),
  ),
  command(
    "precheck: no repeated-path rule before the key",
    `${PRE} a repeated --path`,
    edit("    if (seen.has(p)) refuse(`path ${JSON.stringify(p)} repeats`);\n", ""),
  ),
  command(
    "precheck: no tool-list rule before the key",
    `${PRE} a --scope outside the repo-change tools`,
    edit(
      "  if (parseRepoChangeTools(canonicalToolOrder(req.tools)) === null) {\n",
      "  if ((false as boolean) && parseRepoChangeTools(canonicalToolOrder(req.tools)) === null) {\n",
    ),
  ),
  command(
    "precheck: no self-delegation rule before the key",
    `${PRE} self-delegation`,
    edit(
      "    req.delegate.motebit_id === principal.motebit_id ||\n    req.delegate.public_key === principal.public_key\n",
      "    (false as boolean)\n",
    ),
  ),
  command(
    "precheck: no scope-shape rule before the key",
    `${PRE} a --base-ref other than main`,
    edit(
      "  if (!isRepoTaskScopeShape(buildScope(req))) {\n",
      "  if ((false as boolean) && !isRepoTaskScopeShape(buildScope(req))) {\n",
    ),
  ),
  command(
    "erase: the process exits on a post-key refusal before the key is erased",
    `${ERASE} a refusal after the key is unlocked erases it first`,
    edit(
      "    if (err instanceof RepoTaskDelegationRefusedError) {\n      throw new RepoTaskCliRefusal(",
      "    if (err instanceof RepoTaskDelegationRefusedError) {\n      (deps.exit as (code: number) => void)(1);\n      throw new RepoTaskCliRefusal(",
      CMD,
    ),
  ),
  command(
    "erase: the key is never erased",
    `${ERASE} a delegation that verifies is written and the key erased`,
    edit("    deps.secureErase(active.privateKey);\n", "    void active;\n", CMD),
  ),
  // ── cold review round 2 ───────────────────────────────────────────────
  command(
    "precheck: no delegate-key spelling rule before the key",
    `${PRE} a delegate key in another spelling`,
    edit(
      "  const keyFault = await delegateKeyFault(req.delegate);\n  if (keyFault !== null) refuse(keyFault);\n",
      "",
    ),
  ),
  command(
    "revoke precheck: a forged grant reaches the key",
    `${PRE_REV} a forged grant_id (the grant's signature fails)`,
    NO_REVOKE_PRECHECK,
  ),
  command(
    "revoke precheck: a malformed tick reaches the key",
    `${PRE_REV} a malformed tick`,
    NO_REVOKE_PRECHECK,
  ),
  command(
    "revoke precheck: an unbound scope reaches the key",
    `${PRE_REV} a scope that is not the bound one`,
    NO_REVOKE_PRECHECK,
  ),
  command(
    "erase: a revoke exits on a post-key refusal before the key is erased",
    `${ERASE} a revoke refused after the key is unlocked erases it first`,
    edit(
      "    if (err instanceof RepoTaskDelegationRefusedError) {\n      throw new RepoTaskCliRefusal(",
      "    if (err instanceof RepoTaskDelegationRefusedError) {\n      (deps.exit as (code: number) => void)(1);\n      throw new RepoTaskCliRefusal(",
      CMD,
    ),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
