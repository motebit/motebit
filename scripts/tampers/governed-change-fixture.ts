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
    edit(SCRIPT, "BASE64URL.indexOf(sig.at(-1)!) | 1]", "BASE64URL.indexOf(sig.at(-1)!)]"),
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
];

void runTampers(TAMPERS, { root: ROOT });
