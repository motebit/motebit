/**
 * Tamper checks for signed revocation evidence (standing-delegation@1.3
 * §5.2–§5.3; packages/crypto/src/delegation-revocation-head.ts). Every
 * verification check, producer refusal and detector condition, removed
 * alone, must turn its named test red.
 *
 *   node --import tsx scripts/tampers/revocation-head-evidence.ts
 *   (or: npx tsx scripts/tampers/revocation-head-evidence.ts)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = "packages/crypto/src/delegation-revocation-head.ts";
const PKG = "@motebit/crypto";
const TEST = "src/__tests__/delegation-revocation-head.test.ts";

const HEAD = "verifyRevocationHead";
const RECEIPT = "verifyRevocationInclusionReceipt";
const OMIT = "detectRevocationOmission";
const EQUIV = "detectRevocationEquivocation";

function entry(name: string, from: string, to: string, red: string): TamperEntry {
  return { name, edits: [{ file: SRC, from, to }], pkg: PKG, test: TEST, red, only: true };
}

const NEVER = "(false as boolean)";

const TAMPERS: TamperEntry[] = [
  // ── verifyRevocationHead, in spec order ──
  entry(
    "head: required-challenge expectation dropped from the guard",
    "    !isNonEmptyString(exp.challenge) ||\n",
    "",
    `${HEAD} refuses when any required expectation is missing`,
  ),
  entry(
    "head: suite check removed",
    `if (head.suite !== DELEGATION_REVOCATION_HEAD_SUITE) return invalid("unsupported_suite");`,
    `if ${NEVER} return invalid("unsupported_suite");`,
    `${HEAD} refuses an unknown suite or spec`,
  ),
  entry(
    "head: spec check removed",
    `if (head.spec !== DELEGATION_REVOCATION_HEAD_SPEC_MIRROR) return invalid("unsupported_spec");`,
    `if ${NEVER} return invalid("unsupported_spec");`,
    `${HEAD} refuses an unknown suite or spec`,
  ),
  entry(
    "head: pinned-key check removed",
    "if (exp.pinnedRelayPublicKey.toLowerCase() !== head.relay_public_key) {",
    `if ${NEVER} {`,
    `${HEAD} refuses a head signed by a key other than the pinned one (wrong key)`,
  ),
  entry(
    "head: signature check removed",
    `  if (sig !== "ok") return invalid(sig);`,
    "  void sig;",
    `${HEAD} refuses a head whose signature does not verify (bad signature)`,
  ),
  entry(
    "head: challenge check removed",
    `if (head.challenge !== exp.challenge) return invalid("challenge_mismatch");`,
    `if ${NEVER} return invalid("challenge_mismatch");`,
    `${HEAD} refuses a head answering another challenge (challenge mismatch)`,
  ),
  entry(
    "head: delegator check removed",
    `if (head.delegator_id !== exp.delegatorId) return invalid("delegator_mismatch");`,
    `if ${NEVER} return invalid("delegator_mismatch");`,
    `${HEAD} refuses a head for another delegator (delegator mismatch)`,
  ),
  entry(
    "head: per-entry delegator check removed",
    "if (!head.entries.every((e) => e.record.delegator_id === head.delegator_id)) {",
    `if ${NEVER} {`,
    `${HEAD} refuses a head carrying an entry for another delegator`,
  ),
  entry(
    "head: ascending-seq check removed",
    `if (e.seq <= prev) return invalid("entries_out_of_order");`,
    `if ${NEVER} return invalid("entries_out_of_order");`,
    `${HEAD} refuses out-of-order entries`,
  ),
  entry(
    "head: seq <= high-water check removed",
    `if (e.seq > head.seq_high_water) return invalid("entry_seq_exceeds_high_water");`,
    `if ${NEVER} return invalid("entry_seq_exceeds_high_water");`,
    `${HEAD} refuses an entry seq above seq_high_water`,
  ),
  entry(
    "head: count check removed",
    `if (head.count !== head.entries.length) return invalid("count_mismatch");`,
    `if ${NEVER} return invalid("count_mismatch");`,
    `${HEAD} refuses a count that disagrees with the entries`,
  ),
  entry(
    "head: records-digest check removed",
    "if ((await computeRevocationRecordsDigest(head.entries)) !== head.records_digest) {",
    `if ${NEVER} {`,
    `${HEAD} refuses a records_digest that disagrees with the entries`,
  ),
  entry(
    "head: staleness check removed",
    "if (now - head.as_of > maxAgeMs + skewMs) {",
    `if ${NEVER} {`,
    `${HEAD} refuses a stale head (older than window plus skew)`,
  ),
  entry(
    "head: staleness window drops the skew allowance",
    "if (now - head.as_of > maxAgeMs + skewMs) {",
    "if (now - head.as_of > maxAgeMs) {",
    `${HEAD} accepts a head exactly at window plus skew`,
  ),
  entry(
    "head: future-skew check removed",
    "if (head.as_of - now > skewMs) {",
    `if ${NEVER} {`,
    `${HEAD} refuses a head dated in the future beyond skew`,
  ),
  entry(
    "head: rollback check removed",
    "if (head.seq_high_water < exp.lastSeenSeq) {",
    `if ${NEVER} {`,
    `${HEAD} refuses a rollback below the last accepted seq_high_water`,
  ),
  entry(
    "head: verification order (challenge before signature)",
    `  const sig = await verifyRelaySignature(head);\n  if (sig !== "ok") return invalid(sig);\n\n  // 4. Challenge + delegator (head and every entry).\n  if (head.challenge !== exp.challenge) return invalid("challenge_mismatch");`,
    `  if (head.challenge !== exp.challenge) return invalid("challenge_mismatch");\n  const sig = await verifyRelaySignature(head);\n  if (sig !== "ok") return invalid(sig);`,
    `${HEAD} checks the signature before the challenge (verification order)`,
  ),

  // ── producer ──
  entry(
    "signRevocationHead: ordering/high-water refusal removed",
    "if (!isPositiveSeq(e.seq) || e.seq <= prev || e.seq > body.seq_high_water) {",
    `if ${NEVER} {`,
    "signRevocationHead (producer refusals) refuses out-of-order entries, a seq above high-water, and a foreign delegator",
  ),
  entry(
    "signRevocationHead: foreign-delegator refusal removed",
    "if (e.record.delegator_id !== body.delegator_id) {",
    `if ${NEVER} {`,
    "signRevocationHead (producer refusals) refuses out-of-order entries, a seq above high-water, and a foreign delegator",
  ),
  entry(
    "signRevocationHead: count no longer derived from entries",
    "    count: body.entries.length,",
    "    count: 0,",
    `${HEAD} accepts a head the pinned relay signed (happy path round-trip)`,
  ),

  // ── verifyRevocationInclusionReceipt ──
  entry(
    "receipt: spec check removed",
    "if (receipt.spec !== DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR) {\n    return",
    `if ${NEVER} {\n    return`,
    `${RECEIPT} refuses a head presented as a receipt (spec domain separation)`,
  ),
  entry(
    "receipt: pinned-key check removed",
    "if (exp.pinnedRelayPublicKey.toLowerCase() !== receipt.relay_public_key) {",
    `if ${NEVER} {`,
    `${RECEIPT} refuses a receipt signed by another relay key`,
  ),
  entry(
    "receipt: signature check removed",
    `  if (sig !== "ok") return { valid: false, reason: sig };`,
    "  void sig;",
    `${RECEIPT} refuses a receipt whose signature does not verify`,
  ),
  entry(
    "receipt: names-the-submitted-revocation check removed",
    "    receipt.grant_id !== rev.grant_id ||\n    receipt.delegator_id !== rev.delegator_id ||\n    receipt.revocation_signature !== rev.signature\n",
    "    false as boolean\n",
    `${RECEIPT} refuses a receipt naming a different revocation`,
  ),
  entry(
    "receipt: revocation_signature clause removed (grant_id alone)",
    " ||\n    receipt.revocation_signature !== rev.signature\n",
    "\n",
    `${RECEIPT} refuses a receipt naming another revocation of the same grant`,
  ),
  entry(
    "receipt: empty pinned key accepted as an expectation",
    "  if (!isNonEmptyString(exp.pinnedRelayPublicKey) || !isRevocationShape(exp.revocation)) {",
    '  if (typeof exp.pinnedRelayPublicKey !== "string" || !isRevocationShape(exp.revocation)) {',
    `${RECEIPT} refuses when an expectation is missing`,
  ),

  // ── detectRevocationOmission ──
  entry(
    "omission: high-water coverage check removed",
    "  if (head.seq_high_water < receipt.seq) return false;",
    "",
    `${OMIT} is false when the head's high-water does not cover the receipted seq`,
  ),
  entry(
    "omission: same-relay-key check removed",
    "  if (receipt.relay_public_key !== head.relay_public_key) return false;",
    "",
    `${OMIT} is false across different relay keys`,
  ),
  entry(
    "omission: same-delegator check removed",
    "  if (receipt.delegator_id !== head.delegator_id) return false;",
    "",
    `${OMIT} is false across different delegators`,
  ),
  entry(
    "omission: signature checks removed",
    "  if (!(await selfSigned(receipt)) || !(await selfSigned(head))) return false;",
    "",
    `${OMIT} is false when the receipt signature is forged`,
  ),
  entry(
    "omission: carried-at-seq match drops the seq",
    "      e.seq === receipt.seq &&\n",
    "",
    `${OMIT} is true when the head carries the record at a different seq than receipted`,
  ),
  entry(
    "omission: carried record ignored",
    "  return !carried;",
    "  return carried || true;",
    `${OMIT} is false when the head carries the receipted record`,
  ),

  // ── detectRevocationEquivocation ──
  entry(
    "equivocation: same-high-water check removed",
    "  if (headA.seq_high_water !== headB.seq_high_water) return false;",
    "",
    `${EQUIV} is false at different seq_high_water`,
  ),
  entry(
    "equivocation: different-digest check removed",
    "  if (headA.records_digest === headB.records_digest) return false;",
    "",
    `${EQUIV} is false for two heads over the same entries (challenge and as_of differ)`,
  ),
  entry(
    "equivocation: same-relay-key check removed",
    "  if (headA.relay_public_key !== headB.relay_public_key) return false;",
    "",
    `${EQUIV} is false across different relay keys`,
  ),
  entry(
    "equivocation: signature checks removed",
    "  if (!(await selfSigned(headA)) || !(await selfSigned(headB))) return false;",
    "",
    `${EQUIV} is false when either head's signature is forged`,
  ),
];

void runTampers(TAMPERS, { root: ROOT });
