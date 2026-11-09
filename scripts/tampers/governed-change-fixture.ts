/**
 * Tamper checks for scripts/governed-change-fixture.ts — the negative
 * acceptance tests B3, B4, B5a, B5b and B6 (docs/proposals/governed-repo-change-v1.md).
 *
 * One entry per case makes the fixture produce NO defect or the WRONG one,
 * and names the test that must go red; the others remove the exactness of
 * the verdict check, a refusal, or a key erase.
 *
 *   npx tsx scripts/tampers/governed-change-fixture.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCRIPT = "scripts/governed-change-fixture.ts";
const TEST = "scripts/__tests__/governed-change-fixture.test.ts";

const EACH = "governed-change fixture: each case makes exactly its one defect";
const CASE = (c: string) =>
  `${EACH} ${c}: two unreachable commits, the push command, and exactly the expected verdict in CI`;
const REFUSE =
  "governed-change fixture: no push command when the defect is absent or a second one is present";
const ERASE = "governed-change fixture: every key is erased on every exit path";
const JUDGE = "governed-change fixture: judge holds every row and every failure detail";
const GUARD = "governed-change fixture: every preflight and postcondition guard refuses";
const DIRECT = "governed-change fixture: b5a's respelling and b5b's bundle commit";
const TIME =
  "governed-change fixture: the tick must outlast CI, and the run records the CLI's version";
/** Disable an `if (` whose condition is one term (no top-level `||`) on the same line. */
const off = (from: string): TamperEdit =>
  edit(SCRIPT, from, from.replace("if (", "if ((false as boolean) && "));

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  test: TEST,
  red,
  only: true,
  edits,
});

const TAMPERS: TamperEntry[] = [
  // ── one per case: no defect, or the wrong one ─────────────────────────────
  entry(
    "b3: the out-of-scope path is never staged (no defect)",
    CASE("b3"),
    edit(
      SCRIPT,
      "        await stager.stage(outsidePath, ENCODER.encode(fixtureMarker(c)));\n",
      "        void outsidePath;\n",
    ),
  ),
  entry(
    "b4: the tool receipts embed the delegate's key over the ephemeral signature (the wrong defect: integrity)",
    CASE("b4"),
    edit(
      SCRIPT,
      "      i.signer.privateKey,\n      i.signer.publicKey,\n    );\n",
      '      i.signer.privateKey,\n      Buffer.from(i.authority.grant.delegate_public_key, "hex"),\n    );\n',
    ),
  ),
  entry(
    "b5a: the tick's signature is re-spelled to itself (no defect)",
    CASE("b5a"),
    edit(SCRIPT, "BASE64URL.indexOf(s.at(-1)!) | 1]", "BASE64URL.indexOf(s.at(-1)!)]"),
  ),
  entry(
    "b5b: the run is told the real spent status (the run refuses; no fixture)",
    CASE("b5b"),
    edit(SCRIPT, "        told = { ...honest, spent: false };\n", "        told = honest;\n"),
  ),
  entry(
    "b5b: the bundle commit adds a second bundle path beside the landed one (the wrong defect)",
    CASE("b5b"),
    edit(
      SCRIPT,
      "  await stager.stage(target, bytes);\n  const { headCommit, entries } = await stager.buildChangeCommit(commit);\n",
      '  await stager.stage(target.replace(".json", "-2.json"), bytes);\n  const { headCommit, entries } = await stager.buildChangeCommit(commit);\n',
    ),
  ),
  entry(
    "b6: the run is told the real revocation set (the run refuses; no fixture)",
    CASE("b6"),
    edit(
      SCRIPT,
      "          revocations: { set: [], failures: [], readAt: honest.revocations.readAt },\n",
      "          revocations: honest.revocations,\n",
    ),
  ),

  // ── the verdict check is exact ───────────────────────────────────────────
  entry(
    "judge compares the axes only, not the failures (a second code on the same axis passes)",
    `${REFUSE} b3: a tick that expires before the self-check is a second defect, and refused`,
    edit(
      SCRIPT,
      "  const matches = rows.every((r) => r.ok) && missing.length === 0 && unexpected.length === 0;\n",
      "  const matches = rows.every((r) => r.ok);\n",
    ),
  ),
  entry(
    "judge ignores the shape failures",
    `${REFUSE} a valid change's verdict is no case's expectation: each differs on exactly its own axis`,
    edit(
      SCRIPT,
      '    row(\n      "shape failures",\n      JSON.stringify(expected.shapeFailures),\n      JSON.stringify(computed.shapeFailures),\n    ),\n',
      "",
    ),
  ),

  // ── refusals before the key ──────────────────────────────────────────────
  entry(
    "b3 runs on a scope of max_changed_files 1 (entries_exceed_max a second defect)",
    `${REFUSE} b3: a scope of max_changed_files 1 would add entries_exceed_max, so it refuses before the key`,
    edit(
      SCRIPT,
      "      if (scope.max_changed_files < 2) {\n",
      "      if (scope.max_changed_files < 1) {\n",
    ),
  ),
  entry(
    "b5b/b6 accept a real check failing on more than the case's one rule",
    `${REFUSE} b6: a grant both revoked and spent is a second defect, refused before the key`,
    edit(
      SCRIPT,
      "      if (got.length !== 1 || got[0] !== want) {\n",
      "      if (!got.includes(want)) {\n",
    ),
  ),
  entry(
    "the output directory may lie inside the repository",
    `${REFUSE} an unknown case, and an output directory inside the repository, are refused`,
    edit(
      SCRIPT,
      "  if (inside !== null) {\n    refuse(\n",
      "  if ((false as boolean) && inside !== null) {\n    refuse(\n",
    ),
  ),

  // ── the keys ─────────────────────────────────────────────────────────────
  entry(
    "b4's ephemeral key is not erased",
    `${ERASE} b4's ephemeral key, when signing throws`,
    edit(SCRIPT, "          deps.secureErase(key.privateKey);\n", "          void key;\n"),
  ),
  entry(
    "A's key is not erased",
    `${ERASE} A's key, when the run throws`,
    edit(SCRIPT, "          deps.secureErase(active.privateKey);\n", "          void active;\n"),
  ),

  // ── judge(): each row and the failure detail ────────────────────────────
  entry(
    "judge matches failures on code only",
    `${JUDGE} one change, the same code with another detail (value_not_canonical on receipt.signature), is not a match`,
    edit(
      SCRIPT,
      "(want.detail === undefined || f.detail === want.detail)",
      "(want.detail === undefined || true)",
    ),
  ),
  entry(
    "judge drops the outcome row",
    `${JUDGE} one change, outcome failed, is not a match`,
    edit(SCRIPT, '    row("outcome", expected.outcome, String(verification.outcome)),\n', ""),
  ),
  entry(
    "judge drops the bundle row",
    `${JUDGE} one change, another bundle path, is not a match`,
    edit(SCRIPT, '    row("bundle", expected.bundlePath, String(computed.bundlePath)),\n', ""),
  ),
  entry(
    "judge drops the change-commit row",
    `${JUDGE} one change, another change commit, is not a match`,
    edit(
      SCRIPT,
      '    row("change commit", expected.changeCommit, String(computed.changeCommit)),\n',
      "",
    ),
  ),

  // ── preflight and postcondition guards ─────────────────────────────────
  entry(
    "--agent may name a default config directory",
    `${GUARD} --agent naming a default config directory (an injected throwaway, never ~/.motebit)`,
    off("  if (isDefaultConfigDir(opts.agentDir, deps.defaultConfigDirs())) {\n"),
  ),
  entry(
    "a dirty worktree is accepted",
    `${GUARD} a dirty worktree`,
    off("    if (dirty.length > 0) {\n"),
  ),
  entry(
    "--agent may be the principal",
    `${GUARD} --agent is the principal`,
    edit(
      SCRIPT,
      "      agentPin.motebit_id === principal.motebit_id ||\n      agentPin.public_key === principal.public_key\n    ) {\n",
      "      (false as boolean)\n    ) {\n",
    ),
  ),
  entry(
    "--agent need not be an agent pin",
    `${GUARD} --agent is not an agent pin at the tip`,
    edit(SCRIPT, "      !agents.some(\n", "      (false as boolean) &&\n      !agents.some(\n"),
  ),
  entry(
    "b5b accepts a landed bundle that is not 100644",
    `${GUARD} b5b: the landed bundle is not a regular 100644 file`,
    edit(
      SCRIPT,
      '        if (landed === undefined || landed.mode !== "100644") {\n          refuse(\n',
      '        if ((false as boolean) && (landed === undefined || landed.mode !== "100644")) {\n          refuse(\n',
    ),
  ),
  entry(
    "b3 accepts an out-of-scope path that is in allowed_paths",
    `${GUARD} b3: the out-of-scope path is in allowed_paths`,
    off("      if (scope.allowed_paths.includes(outsidePath)) {\n"),
  ),
  entry(
    "b3 accepts an out-of-scope path the policy refuses",
    `${GUARD} b3: the out-of-scope path fails the tip's path policy`,
    off("      if (!tipState.isPathPermitted(outsidePath)) {\n"),
  ),
  entry(
    "b3 accepts an out-of-scope path tracked at the tip",
    `${GUARD} b3: the out-of-scope path is tracked at the tip`,
    off("      if ((await reader.lookup(outsidePath)) !== null) {\n"),
  ),
  entry(
    "the decrypted key need not be the config's",
    `${GUARD} the decrypted key is not the config's device_public_key: refused, the key erased`,
    off("          if (active.publicKey !== agent.publicKeyHex) {\n"),
  ),
  entry(
    "a scripted run that did not make its edit is recorded anyway",
    `${GUARD} the scripted run did not make its edit: refused, the key erased`,
    edit(
      SCRIPT,
      '          if (run.written_paths.join("\\0") !== editPath) {\n',
      '          if ((false as boolean) && run.written_paths.join("\\0") !== editPath) {\n',
    ),
  ),
  entry(
    "b5a's respelling may be the input itself",
    `${DIRECT} a spelling whose unused bit is already set is not re-spelled to itself`,
    edit(SCRIPT, "  if (respelled === s) return null;\n", ""),
  ),
  entry(
    "b5a's respelling may change the bytes",
    `${DIRECT} a spelling with no unused bits has no second spelling`,
    edit(
      SCRIPT,
      '  if (!Buffer.from(respelled, "base64url").equals(Buffer.from(s, "base64url"))) return null;\n',
      "",
    ),
  ),
  entry(
    "b5b's bundle commit need not be exactly one modify",
    `${DIRECT} refuses the landed bytes again (no change: not exactly one modify)`,
    edit(
      SCRIPT,
      '    throw new Error("the bundle commit would not be exactly one modify of the landed bundle");\n',
      "    void 0;\n",
    ),
  ),
  entry(
    "b5b's bundle commit accepts a landed bundle that is not 100644",
    `${DIRECT} refuses a landed bundle that is not a 100644 file`,
    edit(
      SCRIPT,
      "    throw new Error(`${target} is not a regular file at the change commit`);\n",
      "    void 0;\n",
    ),
  ),
  // ── round 3: each remaining guard, and each term of the compound ones ──
  entry(
    "--agent's key spelling is not checked",
    `${GUARD} --agent's device_public_key not in its one spelling`,
    off("  if (fault !== null) refuse("),
  ),
  entry(
    "scope.json's strict shape is not checked",
    `${GUARD} scope.json with an extra key is not of the strict shape`,
    off("  if (!m.verifier.isRepoTaskScopeShape(scope)) {\n"),
  ),
  entry(
    "grant.json's strict shape is not checked",
    `${GUARD} grant.json with an extra key is not of the strict shape`,
    off("  if (!m.verifier.isRepoChangeGrantShape(grant)) {\n"),
  ),
  entry(
    "tick.json's strict shape is not checked",
    `${GUARD} tick.json with an extra key is not of the strict shape`,
    off("  if (!m.verifier.isRepoChangeTickShape(tick))\n"),
  ),
  entry(
    "the run's authority check before the key is skipped",
    `${REFUSE} b3: a grant also revoked at the tip is a second defect, refused before the key`,
    off("    if (!check.ok) {\n"),
    // Keeps the edit valid code: the narrowing the guard gave is now a cast.
    edit(
      SCRIPT,
      "            signer,\n            check,\n",
      "            signer,\n            check: check as RepoTaskAuthorityCheck & { ok: true },\n",
    ),
  ),
  entry(
    "the edit path need not be a regular file",
    `${GUARD} the scope's first allowed path is not a regular file at the tip`,
    off('    if (atTip !== null && atTip.kind !== "blob") {\n'),
  ),
  entry(
    "b4 calls a tool the tick does not grant",
    `${GUARD} b4: the tick does not grant the scripted read`,
    off("    if (entry === undefined) refuse("),
    edit(SCRIPT, "await entry.handler.invoke(call.args)", "await entry!.handler.invoke(call.args)"),
  ),
  entry(
    "b4 records a call that did not complete",
    `${GUARD} b4: a scripted call that does not complete`,
    off('    if (outcome.status !== "completed") {\n'),
  ),
  entry(
    "is-principal ignores the motebit_id",
    `${GUARD} --agent is the principal by one half: the principal's motebit_id with A's key`,
    edit(
      SCRIPT,
      "      agentPin.motebit_id === principal.motebit_id ||\n",
      "      (false as boolean) ||\n",
    ),
  ),
  entry(
    "is-principal ignores the key",
    `${GUARD} --agent is the principal by one half: A's motebit_id with the principal's key`,
    edit(
      SCRIPT,
      "      agentPin.public_key === principal.public_key\n    ) {\n",
      "      (false as boolean)\n    ) {\n",
    ),
  ),
  entry(
    "the agent-pin match ignores the key",
    `${GUARD} --agent matches an agent pin by one half only: A's motebit_id with another key`,
    edit(SCRIPT, "&& p.public_key === agentPin.public_key,", "&& true,"),
  ),
  entry(
    "the agent-pin match ignores the motebit_id",
    `${GUARD} --agent matches an agent pin by one half only: another motebit_id with A's key`,
    edit(
      SCRIPT,
      "(p) => p.motebit_id === agentPin.motebit_id && p.public_key",
      "(p) => true && p.public_key",
    ),
  ),
  entry(
    "b5b/b6 accept the wrong single rule",
    `${GUARD} b5b: a grant revoked but never landed is not b5b's`,
    edit(
      SCRIPT,
      "      if (got.length !== 1 || got[0] !== want) {\n",
      "      if (got.length !== 1) {\n",
    ),
  ),
  entry(
    "b5b/b6 accept the case's rule beside another",
    `${GUARD} b5b: a grant both landed and revoked is a second defect`,
    edit(
      SCRIPT,
      "      if (got.length !== 1 || got[0] !== want) {\n",
      "      if (got[0] !== want) {\n",
    ),
  ),
  entry(
    "judge ignores an expected failure that is missing",
    `${JUDGE} one change, the expected failure absent from the actual, is not a match`,
    edit(SCRIPT, " && missing.length === 0 && ", " && "),
  ),
  entry(
    "b3's expectation accepts any detail",
    `${JUDGE} b3: entry_path_not_allowed naming another path is not a match`,
    edit(
      SCRIPT,
      "            detail: `${JSON.stringify(ctx.outsidePath)} is not an allowed path`,\n",
      "",
    ),
  ),
  entry(
    "the push command prints with the tick about to expire",
    `${TIME} less than the margin left: refused, no push command`,
    off("  if (left < TICK_MARGIN_MS) {\n"),
  ),
  entry(
    "the runtime version is the unsubstituted build constant",
    `${TIME} the runtime version is the CLI package's, as a real run records it`,
    edit(SCRIPT, "  return `motebit ${pkg.version}`;\n", '  return "motebit 0.0.0-dev";\n'),
  ),
  // ── the "committer" publish condition, in the fixture and in repo-task run ──
  entry(
    "the fixture omits the committer publish condition",
    CASE("b3"),
    edit(SCRIPT, "  log(`  - ${COMMITTER_CONDITION}.`);\n", ""),
  ),
  {
    name: "repo-task run omits the committer publish condition",
    pkg: "motebit",
    test: "src/repo-task/__tests__/run-command.test.ts",
    red: "repo-task run: a governed change, end to end makes the change commit and the bundle commit, verified, moving no ref",
    only: true,
    edits: [
      edit(
        "apps/cli/src/subcommands/repo-task.ts",
        "      `  - the pull request's title and body must not contain the word \"committer\": GitHub's merge queue re-wraps the squash message and corrupts its own signature after any line starting with that word, so the landing would never verify offline.`,\n",
        '      "",\n',
      ),
    ],
  },
];

void runTampers(TAMPERS, { root: ROOT });
