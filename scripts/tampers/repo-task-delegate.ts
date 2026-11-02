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
const FILES = "repo-task files: owner-only, exclusive, all or nothing";
const PRE = "repo-task delegate: a refusal that needs no key never unlocks it";
const ERASE = "repo-task delegate and revoke: the key is erased before any exit";
const REV3 = "repo-task revoke: needs only the grant (or its id), never the scope or the tick";
/** The delegate's key-free refusals, before the passphrase prompt. */
const NO_DELEGATE_PRECHECK = {
  file: "apps/cli/src/subcommands/repo-task.ts",
  from: "    const pre = await precheckRepoTaskDelegation(request, principalPin);\n    if (pre.length > 0) {\n",
  to: "    const pre = await precheckRepoTaskDelegation(request, principalPin);\n    if ((false as boolean) && pre.length > 0) {\n",
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
    edit("  if (binding === null) {\n", "  if ((false as boolean) && binding === null) {\n"),
  ),
  // ── cold review rounds 1–3 ────────────────────────────────────────────
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
  command(
    "erase: a revoke exits on a post-key refusal before the key is erased",
    `${ERASE} a revoke refused after the key is unlocked erases it first`,
    edit(
      "    if (err instanceof RepoTaskDelegationRefusedError) {\n      throw new RepoTaskCliRefusal(",
      "    if (err instanceof RepoTaskDelegationRefusedError) {\n      (deps.exit as (code: number) => void)(1);\n      throw new RepoTaskCliRefusal(",
      CMD,
    ),
  ),
  ...[
    "--hours 25",
    "a non-canonical --path",
    "a repeated --path",
    "a --scope outside the repo-change tools",
    "a --base-ref other than main",
    "a delegate key in another spelling",
    "a delegate with an empty motebit_id",
    "self-delegation (the same identity)",
    "self-delegation by key under another id",
  ].map((t) =>
    command(
      `precheck: no key-free refusal before the key (${t})`,
      `${PRE} ${t}`,
      NO_DELEGATE_PRECHECK,
    ),
  ),
  command(
    "precheck: the party rule over the configured principal not run",
    `${PRE} self-delegation by key under another id`,
    edit(
      "    (code, detail) => out.push({ code, detail }),\n",
      "    (code, detail) => void [code, detail],\n",
    ),
  ),
  command(
    "revoke: a grant_id's spelling not judged before the key",
    `${REV3} a grant_id not in its one spelling is refused before the key`,
    edit(
      "      const pre = await grantIdRefusals(what.grantId);\n      if (pre.length > 0) {\n",
      "      const pre = await grantIdRefusals(what.grantId);\n      if ((false as boolean) && pre.length > 0) {\n",
      CMD,
    ),
  ),
  ...[
    "a forged grant.json is refused before the key, as not signed by its key",
    "a grant of another principal is refused before the key",
  ].map((t) =>
    command(
      `revoke: the grant file not judged before the key (${t})`,
      `${REV3} ${t}`,
      edit(
        "      const pre = await grantRefusals(grant, principalPin);\n      if (pre.length > 0) {\n",
        "      const pre = await grantRefusals(grant, principalPin);\n      if ((false as boolean) && pre.length > 0) {\n",
        CMD,
      ),
    ),
  ),
  command(
    "revoke: the grant's own signature not verified",
    `${REV3} a forged grant.json is refused before the key, as not signed by its key`,
    edit(
      "    !(await verifyStandingDelegation(grant, { checkExpiry: false, now: Number.MAX_SAFE_INTEGER }))\n",
      "    (false as boolean)\n",
    ),
  ),
  command(
    "revoke: the grant's delegator key not compared with the principal's",
    `${REV3} a grant of another principal is refused before the key`,
    edit(
      "  if (grant.delegator_public_key !== principal.public_key) {\n",
      "  if ((false as boolean) && grant.delegator_public_key !== principal.public_key) {\n",
    ),
  ),
  command(
    "revoke: reads the scope and the tick beside the grant",
    `${REV3} with the tick and the scope missing`,
    edit(
      "        grant = readGrantFile(what.file);\n",
      "        grant = readGrantFile(what.file);\n        readDelegationDirectory(path.dirname(what.file));\n",
      CMD,
    ),
    edit("  readGrantFile,\n", "  readGrantFile,\n  readDelegationDirectory,\n", CMD),
  ),
  command(
    "revoke: an existing revocation file surfaces as a crash, not a refusal",
    `${REV3} a revocation file that appears after the key is a clean refusal, the key erased first`,
    edit(
      "    if (err instanceof CanonicalFileExistsError) {\n      throw new RepoTaskDelegationRefusedError([",
      "    if ((false as boolean) && err instanceof CanonicalFileExistsError) {\n      throw new RepoTaskDelegationRefusedError([",
    ),
  ),
  // ── confirmation review ───────────────────────────────────────────────
  ...[
    [PRE, "an uppercase configured principal key"],
    [REV3, "an uppercase configured principal key is refused before the key"],
  ].map(([d, t]) =>
    command(
      `principal: a non-canonical configured key accepted (${t})`,
      `${d} ${t}`,
      edit("  if (fault !== null) {\n", "  if ((false as boolean) && fault !== null) {\n", CMD),
    ),
  ),
  command(
    "revoke by id: the target key taken from the config string",
    `${REV3} by grant_id, the target key is the loaded key, never the config string`,
    edit("? active.publicKey :", "? principalPin.public_key :", CMD),
  ),
  command(
    "delegate: existing output files not refused before the key",
    `${PRE} an output file that already exists`,
    edit(
      "    if (config.output !== undefined) {\n",
      "    if ((false as boolean) && config.output !== undefined) {\n",
      CMD,
    ),
  ),
  command(
    "revoke: an existing revocation file not refused before the key",
    `${REV3} an existing revocation file is refused before the key`,
    edit("    refuseExisting([path.join(outDir,", "    void ([path.join(outDir,", CMD),
  ),
  entry(
    "revoke: a directory named for a grant_id without grant.json is refused",
    "repo-task revoke: by grant_id and delegator key alone a directory named for a grant_id but holding no grant.json is the grant_id",
    edit('      if (await isGrantId()) return { kind: "grant-id", grantId: arg };\n', "", CMD),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
