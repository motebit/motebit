/**
 * Tamper checks for milestone B build step 4c-ii — `motebit-verify
 * repo-change --landed`, offline on a landed change (spec/repo-change-v1.md
 * §7, §9): the inputs `@motebit/verify/git` computes for `verifyRepoChange`
 * from raw, re-hashed objects, and the landing time accepted only from
 * GitHub under a pinned OpenPGP key.
 *
 * Each entry removes one rule — of the landing time (committer, signature,
 * algorithms, creation time, armor, packets, subpackets, the pinned-keys
 * file), of the offline shape checks, of the inputs read at the squash
 * commit's parent, of spent, of the untrusted object store (re-hashing, type,
 * canonical trees, strict commits, first-parent walks from raw bytes, shallow
 * refusal), or of the command's mutual exclusion — and names the test that
 * must go red.
 *
 *   npx tsx scripts/tampers/verify-repo-change-landed.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const LANDED = "packages/verify/src/git/landed.ts";
const OBJECTS = "packages/verify/src/git/objects.ts";
const PGP = "packages/crypto-openpgp/src/openpgp.ts";
const CLI = "packages/verify/src/repo-change-cli.ts";
const TEST = "src/__tests__/repo-change-landed.test.ts";
const UNIT = "src/__tests__/openpgp.test.ts";
const KEYS_FILE = "packages/verify/src/git/operator-keys.ts";
const KEYS_UNIT = "src/__tests__/operator-keys.test.ts";
const PIN_SET = "the pinned set file";

const OK =
  "motebit-verify repo-change --landed: a landed governed change is fully verified, pinned, fresh, with outcome completed, at the operator-recorded time";
const TIME =
  "motebit-verify repo-change --landed: the landing time is GitHub's, under a pinned key";
const SHAPE = "motebit-verify repo-change --landed: every offline shape check folds into integrity";
const PARENT = "motebit-verify repo-change --landed: inputs are read at the squash commit's parent";
const STORE = "motebit-verify repo-change --landed: the object store is not trusted";
const COMMAND = "motebit-verify repo-change --landed: the command";
const KEYS = "the pinned signing keys file";
const SIGNATURE = "the signature packet, refusal by refusal";
const HEADER = "the commit's signature header";
const GITHUB_FORM =
  "GitHub's own form is accepted at the committer time: signed seconds later, a full-width MPI, a blank last header line";
const GITHUB_HEADER =
  "reads GitHub's form (full-width MPI, one blank last header line) and gpg's (minimal, none)";
const POP = '      if (s.length > 1 && s[s.length - 1] === "") s.pop();\n';
const LAX_MPI = 'mpi(b, unhashedEnd + 2, "the RSA signature", false)';
const STRICT_MPI = 'mpi(b, unhashedEnd + 2, "the RSA signature", true)';
const NAME_GUARD =
  'if (name.length === 0 || name.includes(0x2f) || nameKey === "." || nameKey === "..") {';

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });
/** An end-to-end entry; verify loads the leaf from its build, so a leaf edit rebuilds it. */
const entry = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  pkg: "@motebit/verify",
  test: TEST,
  red,
  only: true,
  edits,
  ...(edits.some((e) => e.file === PGP) ? { rebuild: ["@motebit/crypto-openpgp"] } : {}),
});
/** A unit entry in the leaf, whose tests import its source. */
const unit = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  pkg: "@motebit/crypto-openpgp",
  test: UNIT,
  red,
  only: true,
  edits,
});
/** A unit entry for verify's pinned-set parser. */
const pinSet = (name: string, red: string, ...edits: TamperEdit[]): TamperEntry => ({
  name,
  pkg: "@motebit/verify",
  test: KEYS_UNIT,
  red,
  only: true,
  edits,
});
/** Disable an `if (<guard>` whose condition is one `&&` chain (no top-level `||`). */
const off = (file: string, guard: string): TamperEdit =>
  edit(file, `if (${guard}`, `if ((false as boolean) && ${guard}`);
const TREE_RULES = "a tree out of canonical order, or with a malformed entry, is rejected";
const ACCEPT = "{ landedAt: seconds * 1000, committer, signer: null, problem: null }";

const TAMPERS: TamperEntry[] = [
  // ── the landing time ───────────────────────────────────────────────────
  entry(
    "time: the committer not checked",
    `${TIME} the committer is not GitHub`,
    edit(
      LANDED,
      "  if (m[1] !== LANDING_COMMITTER.name || m[2] !== LANDING_COMMITTER.email) {\n",
      "  if ((false as boolean) && (m[1] !== LANDING_COMMITTER.name || m[2] !== LANDING_COMMITTER.email)) {\n",
    ),
  ),
  entry(
    "time: the committer's email not checked",
    `${TIME} the committer is not GitHub`,
    edit(LANDED, " || m[2] !== LANDING_COMMITTER.email) {\n", ") {\n"),
  ),
  entry(
    "time: accepted when the signature does not verify",
    `${TIME} a flipped byte in the commit body`,
    edit(LANDED, "  if (!sig.ok) return no(sig.reason);\n", `  if (!sig.ok) return ${ACCEPT};\n`),
  ),
  entry(
    "time: accepted with no gpgsig",
    `${TIME} the gpgsig is missing`,
    edit(
      LANDED,
      "  if (!sig.ok) return no(sig.reason);\n",
      `  if (!sig.ok) return sig.reason.includes("has no gpgsig") ? ${ACCEPT} : no(sig.reason);\n`,
    ),
  ),
  entry(
    "time: a signature made long after the committer time accepted",
    `${TIME} the signature was made more than five minutes after the committer time`,
    off(LANDED, "sig.createdAt - seconds > LANDING_SIGNATURE_WINDOW_S) {"),
  ),
  entry(
    "time: a key's trusted_until ignored",
    `${TIME} the committer time is at or after the pinned key's trusted_until`,
    off(LANDED, 'until !== null && !(typeof until === "number" && seconds < until)) {'),
  ),
  entry(
    "time: a landing at exactly trusted_until accepted",
    `${TIME} the committer time is at or after the pinned key's trusted_until`,
    edit(LANDED, "&& seconds < until)) {", "&& seconds <= until)) {"),
  ),
  entry(
    "time: a retired key refused for its earlier landings",
    `${TIME} a retired key still vouches for a landing made before its trusted_until`,
    edit(LANDED, '!(typeof until === "number" && seconds < until)', "true"),
  ),
  entry(
    "time: the window read from another pinned key than the signer",
    `${TIME} the window is the verifying key's, never another pinned key's`,
    edit(
      LANDED,
      "const key = keys.find((k) => k.fingerprint === sig.fingerprint);",
      "const key = keys.find((k) => k.trustedUntil === null) ?? keys.find((k) => k.fingerprint === sig.fingerprint);",
    ),
  ),
  entry(
    "time: a key with no usable creation time left open",
    `${TIME} a pinned key with no usable creation time is refused, never open`,
    edit(
      LANDED,
      "key === undefined || !Number.isSafeInteger(key.createdAt) || ",
      "key === undefined || ",
    ),
  ),
  entry(
    "command: the pinned set decoded leniently",
    `${COMMAND} exits 2 when the pinned keys do not parse, or the file is missing`,
    edit(CLI, "{ fatal: true, ignoreBOM: true }", "{ fatal: false, ignoreBOM: true }"),
  ),
  entry(
    "time: a key with no window field left open",
    `${TIME} a pinned key with no window field is refused, never open`,
    edit(LANDED, "if (until !== null && !(", "if (until != null && !("),
  ),
  pinSet(
    "pinned set: the armored key not matched to its fingerprint",
    `${PIN_SET} refuses armored holding another key than the fingerprint`,
    off(KEYS_FILE, "key.fingerprint !== fp) {"),
  ),
  pinSet(
    "pinned set: more than one key per entry accepted",
    `${PIN_SET} refuses armored holding two keys`,
    off(KEYS_FILE, "keys.length !== 1) fail"),
  ),
  pinSet(
    "pinned set: a repeated member name accepted",
    `${PIN_SET} refuses a member name repeated in an entry`,
    off(KEYS_FILE, "repeated !== null) fail"),
  ),
  pinSet(
    "pinned set: a key pinned twice accepted",
    `${PIN_SET} refuses a key pinned twice`,
    off(KEYS_FILE, "seen.has(fp)) fail"),
  ),
  pinSet(
    "pinned set: a malformed trusted_until accepted",
    `${PIN_SET} refuses an unsafe trusted_until`,
    off(KEYS_FILE, "until !== null && !Number.isSafeInteger(until)) {"),
  ),
  pinSet(
    "pinned set: a trusted_until read from its value, not its text",
    `${PIN_SET} refuses a trusted_until written 1800000000.0000001`,
    off(KEYS_FILE, "number !== null) fail"),
  ),
  pinSet(
    "pinned set: another spec accepted",
    `${PIN_SET} refuses another spec`,
    off(KEYS_FILE, "file.spec !== OPERATOR_SIGNING_KEYS_SPEC) {"),
  ),
  pinSet(
    "pinned set: an empty keys accepted",
    `${PIN_SET} refuses no keys`,
    edit(KEYS_FILE, " || file.keys.length === 0) fail", ") fail"),
  ),
  pinSet(
    "pinned set: a malformed fingerprint accepted",
    `${PIN_SET} refuses an uppercase fingerprint`,
    edit(
      KEYS_FILE,
      'if (typeof fp !== "string" || !FINGERPRINT.test(fp)) {',
      "if ((false as boolean) && !FINGERPRINT.test(fp as string)) {",
    ),
  ),
  pinSet(
    "pinned set: a non-object accepted as an entry",
    `${PIN_SET} refuses an entry not an object`,
    edit(
      KEYS_FILE,
      'if (typeof o !== "object" || o === null || Array.isArray(o))',
      'if ((false as boolean) && (typeof o !== "object" || o === null || Array.isArray(o)))',
    ),
  ),
  pinSet(
    "pinned set: a missing key accepted",
    `${PIN_SET} refuses a missing key`,
    edit(
      KEYS_FILE,
      "    if (!Object.prototype.hasOwnProperty.call(r, k)) fail(",
      "    if ((false as boolean) && !Object.prototype.hasOwnProperty.call(r, k)) fail(",
    ),
  ),
  pinSet(
    "pinned set: keys not an array accepted",
    `${PIN_SET} refuses keys not an array`,
    edit(
      KEYS_FILE,
      "if (!Array.isArray(file.keys) || file.keys.length",
      "if ((file.keys as unknown[]).length",
    ),
  ),
  pinSet(
    "pinned set: armored not a string accepted",
    `${PIN_SET} refuses armored not a string`,
    off(KEYS_FILE, 'typeof e.armored !== "string") fail'),
  ),
  pinSet(
    "pinned set: an unknown entry key accepted",
    `${PIN_SET} refuses an unknown entry key`,
    edit(
      KEYS_FILE,
      "    if (!keys.includes(k)) fail(",
      "    if ((false as boolean) && !keys.includes(k)) fail(",
    ),
  ),
  entry(
    "time: a committer time before the pinned key existed accepted",
    `${TIME} the committer time is before the pinned key was created`,
    edit(
      LANDED,
      "if (key === undefined || !Number.isSafeInteger(key.createdAt) || seconds < key.createdAt) {",
      "if (key === undefined || !Number.isSafeInteger(key.createdAt) || ((false as boolean) && seconds < key.createdAt)) {",
    ),
  ),
  unit(
    "signature: a signature made before its key accepted",
    `${SIGNATURE} refuses a signature made before its key was created`,
    off(PGP, "sig.createdAt < key.createdAt) {"),
  ),
  {
    ...unit(
      "armor: the CRC-24 polynomial changed",
      "the armor checksum CRC-24 gives the RFC 4880 check value",
      edit(PGP, "if (crc & 0x1000000) crc ^= 0x1864cfb;", "if (crc & 0x1000000) crc ^= 0x1864cfa;"),
    ),
    test: "src/__tests__/crc24.test.ts",
  },
  unit(
    "armor: a body line longer than 76 characters accepted",
    `${HEADER} refuses broken armor: no END line, a malformed armor header, a wrong CRC-24`,
    edit(
      PGP,
      "l.length === 0 || l.length > 76 || !B64_LINE.test(l)",
      "l.length === 0 || !B64_LINE.test(l)",
    ),
  ),
  entry(
    "time: a signature made before the committer time accepted",
    `${TIME} the signature was created before the committer time`,
    off(LANDED, "sig.createdAt < seconds) {"),
  ),
  entry(
    "time: GitHub's blank last header line kept in the armor",
    `${TIME} ${GITHUB_FORM}`,
    edit(PGP, POP, "      void 0;\n"),
  ),
  unit(
    "header: GitHub's blank last header line kept in the armor",
    `${HEADER} ${GITHUB_HEADER}`,
    edit(PGP, POP, "      void 0;\n"),
  ),
  unit(
    "header: more than one blank last header line dropped",
    `${HEADER} ${GITHUB_HEADER}`,
    edit(PGP, POP, '      while (s.length > 1 && s[s.length - 1] === "") s.pop();\n'),
  ),
  unit(
    "packets: GitHub's full-width signature MPI refused",
    `${HEADER} ${GITHUB_HEADER}`,
    edit(PGP, LAX_MPI, STRICT_MPI),
  ),
  unit(
    "keys: a key MPI's inexact bit count allowed",
    `${KEYS} refuses a modulus whose bit count is not exact`,
    edit(PGP, "if (exact && (top === 0", "if ((false as boolean) && exact && (top === 0"),
  ),
  unit(
    "subpackets: the issuer fingerprint's length not checked",
    `${SIGNATURE} refuses an issuer fingerprint of the wrong length`,
    edit(PGP, "data.length !== 21 || data[0] !== 4", "data[0] !== 4"),
  ),
  entry(
    "signature: RSA not verified",
    `${TIME} a flipped byte in the signature`,
    off(PGP, '!ok) return { ok: false, reason: "the RSA signature does not verify'),
  ),
  entry(
    "signature: the left 16 bits not checked",
    `${TIME} the left 16 bits do not match`,
    off(PGP, "!digest.subarray(0, 2).equals(sig.left16)) {"),
  ),
  entry(
    "signature: an unpinned signer falls back to the first pinned key",
    `${TIME} the key is not pinned`,
    edit(
      PGP,
      "    sig.fingerprint !== null ? k.fingerprint === sig.fingerprint : k.keyId === sig.keyId,\n  );\n",
      "    sig.fingerprint !== null ? k.fingerprint === sig.fingerprint : k.keyId === sig.keyId,\n  ) ?? pinned[0];\n",
    ),
  ),
  entry(
    "signature: the public-key algorithm not checked",
    `${TIME} a wrong public-key algorithm, hash algorithm or signature type`,
    off(PGP, "b[2] !== 1) throw"),
  ),
  entry(
    "signature: the hash algorithm not checked",
    `${TIME} a wrong public-key algorithm, hash algorithm or signature type`,
    off(PGP, "b[3] !== 8) throw"),
  ),
  entry(
    "signature: the signature type not checked",
    `${TIME} a wrong public-key algorithm, hash algorithm or signature type`,
    off(PGP, "b[1] !== 0x00)\n    throw"),
  ),
  entry(
    "signature: the packet version not checked",
    `${TIME} a v3 or v5 signature packet`,
    off(PGP, "b[0] !== 4) throw new PgpError(`a version"),
  ),
  entry(
    "signature: more than one gpgsig allowed (the last wins)",
    `${TIME} two signatures`,
    off(PGP, "count > 1) return"),
  ),
  entry(
    "signature: other signature and encoding headers kept in the payload",
    `${TIME} a commit with another signature or encoding header`,
    off(PGP, "/^(?:gpgsig|gpgsig-sha256|mergetag|encoding) /.test(l)) {"),
  ),
  entry(
    "armor: the CRC-24 not checked",
    `${TIME} a malformed armor or CRC`,
    edit(
      PGP,
      "  if (crc.length !== 3 || crc.readUIntBE(0, 3) !== crc24(data)) {\n",
      "  if ((false as boolean) && (crc.length !== 3 || crc.readUIntBE(0, 3) !== crc24(data))) {\n",
    ),
  ),
  entry(
    "packets: data after the signature packet allowed",
    `${TIME} trailing data after the signature packet`,
    off(PGP, "ps.length !== 1) throw"),
  ),
  entry(
    "subpackets: a creation time in the unhashed area accepted",
    `${TIME} subpackets: none of the creation time, issuer or critical rules may be bent`,
    off(PGP, "!hashed) throw"),
  ),
  entry(
    "subpackets: an unknown critical subpacket ignored",
    `${TIME} subpackets: none of the creation time, issuer or critical rules may be bent`,
    edit(PGP, "    } else if (critical) {\n", "    } else if ((false as boolean) && critical) {\n"),
  ),
  entry(
    "subpackets: a signature-expiration subpacket ignored",
    `${TIME} subpackets: none of the creation time, issuer or critical rules may be bent`,
    edit(PGP, '      throw new PgpError("a signature-expiration subpacket");\n', "      void 0;\n"),
  ),
  unit(
    "keys: subkeys made candidates",
    `${KEYS} armor headers, an old-format packet, a five-octet length and subkeys are read`,
    edit(
      PGP,
      "        if (p.tag === 6) keys.push(",
      "        if (p.tag === 6 || p.tag === 14) keys.push(",
    ),
  ),
  unit(
    "keys: a non-RSA primary key read as RSA",
    `${KEYS} refuses a non-RSA primary key`,
    off(PGP, "body[5] !== 1)\n    throw"),
  ),
  // ── shape checks ───────────────────────────────────────────────────────
  entry(
    "shape: a bundle added as an executable file accepted",
    `${SHAPE} a bundle added as an executable file`,
    edit(LANDED, 'added.length === 1 && added[0]!.mode === "100644"', "added.length === 1"),
  ),
  entry(
    "shape: more than one parent allowed",
    `${SHAPE} two parents`,
    off(LANDED, "squash.parents.length !== 1) {"),
  ),
  entry(
    "shape: entries not compared with the record's",
    `${SHAPE} an extra entry`,
    off(LANDED, "!entriesMatch(entries, record.entries)) {"),
  ),
  entry(
    "shape: entries compared by count only",
    `${SHAPE} entries that are not the recorded entries`,
    edit(
      LANDED,
      "    if (want.get(pathKey(e.path)) !== `${e.mode} ${e.blob}`) return false;\n",
      "",
    ),
  ),
  entry(
    "shape: a squash commit that adds no bundle not named",
    `${SHAPE} a squash commit that adds no bundle`,
    edit(
      LANDED,
      "    shapes.push(\n      `the squash commit does not add exactly one regular file",
      "    ([] as string[]).push(\n      `the squash commit does not add exactly one regular file",
    ),
  ),
  entry(
    "shape: the bundle's path not compared with its grant's",
    `${SHAPE} a bundle at a path that is not its grant's`,
    off(LANDED, "bundleEntry !== null && pathKey(bundleEntry.path) !== target) {"),
  ),
  entry(
    "shape: other edits under .motebit/bundles/ allowed",
    `${SHAPE} an edit under .motebit/bundles/ besides the bundle`,
    off(
      LANDED,
      "pathKey(e.path).startsWith(BUNDLES_DIR)) {\n      shapes.push(\n        `the squash commit touches",
    ),
  ),
  entry(
    "shape: parent_commit not required to be a first-parent ancestor",
    `${SHAPE} parent_commit is not a first-parent ancestor of the squash commit's parent`,
    off(LANDED, "!parentSeen) {"),
  ),
  entry(
    "shape: parent_commit required to be the parent itself (too strict)",
    `${SHAPE} parent_commit an older first-parent ancestor (main moved on before the landing)`,
    edit(
      LANDED,
      "    if (commit === record.parentCommit) parentSeen = true;\n",
      "    if (commit === record.parentCommit && commit === parent) parentSeen = true;\n",
    ),
  ),
  entry(
    "shape: the squash commit not required on the trusted tip's chain",
    `${SHAPE} the squash commit is not on the trusted tip's first-parent chain (only on a side branch)`,
    off(LANDED, "!onTip) shapes.push("),
  ),
  entry(
    "shape: the chain walked through the last parent, not the first",
    `${SHAPE} the squash commit is not on the trusted tip's first-parent chain (only on a side branch)`,
    edit(
      LANDED,
      "    cur = (await raw.commit(cur)).parents[0];\n",
      "    cur = (await raw.commit(cur)).parents.at(-1);\n",
    ),
  ),
  entry(
    "every axis: the bundle dropped when a shape check fails",
    `${SHAPE} a failing shape check still reports every axis`,
    edit(
      LANDED,
      "  const input: VerifyRepoChangeInput = {\n",
      "  if (shapes.length > 0) bundle = new Uint8Array();\n  const input: VerifyRepoChangeInput = {\n",
    ),
  ),
  // ── inputs at the parent ───────────────────────────────────────────────
  entry(
    "parent: pins and policy read at the squash commit",
    `${PARENT} a policy the squash commit widens is ignored`,
    edit(
      LANDED,
      "  const state = await readRepoState(c.git, parent, parentTree, raw.blob);\n",
      "  const state = await readRepoState(c.git, c.landed, await raw.listTree(squash.tree), raw.blob);\n",
    ),
  ),
  entry(
    "parent: a principal pin read at the squash commit",
    `${PARENT} a principal pin the squash commit adds is ignored`,
    edit(
      LANDED,
      "  const state = await readRepoState(c.git, parent, parentTree, raw.blob);\n",
      "  const state = await readRepoState(c.git, c.landed, await raw.listTree(squash.tree), raw.blob);\n",
    ),
  ),
  entry(
    "parent: the revocations not supplied",
    `${PARENT} a revocation at the parent`,
    edit(LANDED, "      set: state.revocations.set,\n", "      set: [],\n"),
  ),
  entry(
    "spent: judged at a non-canonical grant id's path",
    `${PARENT} spent is never judged at a non-canonical grant id's path`,
    edit(
      LANDED,
      "record.grantId !== null && isCanonicalGrantId(record.grantId) ? target : null",
      "record.grantId !== null ? target : null",
    ),
  ),
  entry(
    "parent: a malformed revocation file read as none",
    `${PARENT} a revocation file at the parent that fails strict parsing is unchecked, never fresh`,
    edit(LANDED, "      failures: state.revocations.failures,\n", "      failures: [],\n"),
  ),
  entry(
    "parent: the tracked paths taken from the squash commit",
    `${PARENT} the tracked paths are the parent's, never the squash commit's`,
    edit(LANDED, "trackedPaths: parentTree.map", "trackedPaths: squashTree.map"),
  ),
  entry(
    "spent: never computed",
    `${PARENT} spent: the bundle path once existed on the parent's first-parent history`,
    edit(
      LANDED,
      "      spent = (await raw.lookup(",
      "      spent = (false as boolean) && (await raw.lookup(",
    ),
  ),
  entry(
    "spent: read on the squash commit's history (which adds the bundle)",
    OK,
    edit(
      LANDED,
      "  for await (const commit of firstParentChain(raw, parent)) {\n",
      "  for await (const commit of firstParentChain(raw, c.landed)) {\n",
    ),
  ),
  // ── the object store ───────────────────────────────────────────────────
  entry(
    "store: spent walked by git rev-list, which honours a forged commit-graph",
    `${STORE} a forged commit-graph cannot un-spend a grant`,
    edit(
      LANDED,
      "  for await (const commit of firstParentChain(raw, parent)) {\n",
      '  for await (const commit of (async function* () { yield* (await c.git.run(["rev-list", "--first-parent", parent])).toString("latin1").trim().split("\\n"); })()) {\n',
    ),
  ),
  entry(
    "store: objects not re-hashed",
    `${STORE} an object whose bytes do not hash to its id fails closed`,
    off(OBJECTS, "gitObjectId(type, got.content, objectFormat) !== oid) {"),
  ),
  entry(
    "store: the object's type not checked",
    `${STORE} a commit the store does not hold, or an object of the wrong type, fails closed`,
    off(OBJECTS, "got.type !== type) {"),
  ),
  entry(
    "store: a duplicate name in a tree allowed",
    `${STORE} a duplicate-name tree is rejected`,
    off(OBJECTS, "names.has(nameKey)) {"),
  ),
  entry(
    "store: a tree entry's name not checked",
    `${STORE} ${TREE_RULES}`,
    edit(
      OBJECTS,
      NAME_GUARD,
      NAME_GUARD.replace("if (", "if ((false as boolean) && (").replace(") {", ")) {"),
    ),
  ),
  entry(
    "store: an empty tree entry name allowed",
    `${STORE} ${TREE_RULES}`,
    edit(OBJECTS, NAME_GUARD, NAME_GUARD.replace("name.length === 0 || ", "")),
  ),
  entry(
    "store: a tree entry name with a slash allowed",
    `${STORE} ${TREE_RULES}`,
    edit(OBJECTS, NAME_GUARD, NAME_GUARD.replace(" || name.includes(0x2f)", "")),
  ),
  entry(
    "store: a tree entry named . allowed",
    `${STORE} ${TREE_RULES}`,
    edit(OBJECTS, NAME_GUARD, NAME_GUARD.replace(' || nameKey === "."', "")),
  ),
  entry(
    "store: a tree's canonical order not checked",
    `${STORE} a tree out of canonical order, or with a malformed entry, is rejected`,
    off(OBJECTS, "prev !== undefined && compareBytes(sortKey(prev), sortKey(e)) >= 0) {"),
  ),
  entry(
    "store: a tree's mode not checked",
    `${STORE} a tree out of canonical order, or with a malformed entry, is rejected`,
    off(OBJECTS, "!Object.hasOwn(TREE_MODES, mode)) {"),
  ),
  entry(
    "store: a commit header out of place allowed",
    `${STORE} a malformed commit fails closed`,
    off(OBJECTS, "/^(?:tree|parent|author|committer) /.test(l)) {"),
  ),
  entry(
    "store: a shallow clone judged",
    `${STORE} a shallow clone is refused`,
    off(LANDED, 'fs.existsSync(path.join(c.commonDir, "shallow"))) {'),
  ),
  // ── the command ────────────────────────────────────────────────────────
  entry(
    "command: --base allowed with --landed",
    `${COMMAND} exits 2 on a usage error 0`,
    edit(
      CLI,
      '      if (has(flag)) {\n        return { kind: "usage", message: `repo-change: ${flag} is not used with --landed` };',
      '      if ((false as boolean) && has(flag)) {\n        return { kind: "usage", message: `repo-change: ${flag} is not used with --landed` };',
    ),
  ),
  entry(
    "command: --trusted-tip allowed without --landed",
    `${COMMAND} exits 2 on a usage error 2`,
    off(
      CLI,
      'has(flag)) return { kind: "usage", message: `repo-change: ${flag} requires --landed` };',
    ),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
