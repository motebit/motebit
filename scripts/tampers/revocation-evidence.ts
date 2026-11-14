/**
 * Tamper checks for signed revocation evidence (standing-delegation@1.3
 * §5.2–§5.3; packages/crypto/src/delegation-revocation-set-attestation.ts).
 * Every verification check, producer refusal and proof condition, removed
 * alone, must turn its named test red.
 *
 *   node --import tsx scripts/tampers/revocation-evidence.ts
 *   (or: npx tsx scripts/tampers/revocation-evidence.ts)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = "packages/crypto/src/delegation-revocation-set-attestation.ts";
const PKG = "@motebit/crypto";
const TEST = "src/__tests__/delegation-revocation-set-attestation.test.ts";

const ATT = "verifyRevocationSetAttestation";
const RECEIPT = "verifyRevocationInclusionReceipt";
const OMIT = "verifyRevocationOmissionProof";
const EQUIV = "verifyRevocationEquivocationProof";
const PRODUCER =
  "signRevocationSetAttestation (producer refusals) refuses out-of-order entries, a seq above high-water, and a foreign delegator";

function entry(name: string, from: string, to: string, red: string): TamperEntry {
  return { name, edits: [{ file: SRC, from, to }], pkg: PKG, test: TEST, red, only: true };
}

const NEVER = "(false as boolean)";

const TAMPERS: TamperEntry[] = [
  // ── verifyRevocationSetAttestation, in spec order ──
  entry(
    "attestation: required-challenge expectation dropped from the guard",
    "    !isNonEmptyString(exp.challenge) ||\n",
    "",
    `${ATT} refuses when any required expectation is missing`,
  ),
  entry(
    "attestation: suite check removed",
    `if (a.suite !== DELEGATION_REVOCATION_EVIDENCE_SUITE) return invalid("unsupported_suite");`,
    `if ${NEVER} return invalid("unsupported_suite");`,
    `${ATT} refuses an unknown suite or spec`,
  ),
  entry(
    "attestation: spec check removed",
    "if (a.spec !== DELEGATION_REVOCATION_SET_ATTESTATION_SPEC_MIRROR) {",
    `if ${NEVER} {`,
    `${ATT} refuses an unknown suite or spec`,
  ),
  entry(
    "attestation: pinned-key check removed",
    "if (exp.pinnedRelayPublicKey.toLowerCase() !== a.relay_public_key) {",
    `if ${NEVER} {`,
    `${ATT} refuses an attestation signed by a key other than the pinned one (wrong key)`,
  ),
  entry(
    "attestation: signature check removed",
    `  if (sig !== "ok") return invalid(sig);`,
    "  void sig;",
    `${ATT} refuses an attestation whose signature does not verify (bad signature)`,
  ),
  entry(
    "attestation: challenge check removed",
    `if (a.challenge !== exp.challenge) return invalid("challenge_mismatch");`,
    `if ${NEVER} return invalid("challenge_mismatch");`,
    `${ATT} refuses an attestation answering another challenge (challenge mismatch)`,
  ),
  entry(
    "attestation: delegator check removed",
    `if (a.delegator_motebit_id !== exp.delegatorMotebitId) return invalid("delegator_mismatch");`,
    `if ${NEVER} return invalid("delegator_mismatch");`,
    `${ATT} refuses an attestation for another delegator (delegator mismatch)`,
  ),
  entry(
    "attestation: per-entry record.delegator_id check removed",
    "if (!a.entries.every((e) => e.record.delegator_id === a.delegator_motebit_id)) {",
    `if ${NEVER} {`,
    `${ATT} refuses an attestation carrying an entry for another delegator`,
  ),
  entry(
    "attestation: ascending-seq check removed",
    `if (e.seq <= prev) return invalid("entries_out_of_order");`,
    `if ${NEVER} return invalid("entries_out_of_order");`,
    `${ATT} refuses out-of-order entries`,
  ),
  entry(
    "attestation: seq <= high-water check removed",
    `if (e.seq > a.seq_high_water) return invalid("entry_seq_exceeds_high_water");`,
    `if ${NEVER} return invalid("entry_seq_exceeds_high_water");`,
    `${ATT} refuses an entry seq above seq_high_water`,
  ),
  entry(
    "attestation: count check removed",
    `if (a.count !== a.entries.length) return invalid("count_mismatch");`,
    `if ${NEVER} return invalid("count_mismatch");`,
    `${ATT} refuses a count that disagrees with the entries`,
  ),
  entry(
    "attestation: records-digest check removed",
    "if ((await computeRevocationRecordsDigest(a.entries)) !== a.records_digest) {",
    `if ${NEVER} {`,
    `${ATT} refuses a records_digest that disagrees with the entries`,
  ),
  entry(
    "attestation: staleness check removed",
    "if (now - a.as_of > maxAgeMs + skewMs) {",
    `if ${NEVER} {`,
    `${ATT} refuses a stale attestation (older than window plus skew)`,
  ),
  entry(
    "attestation: staleness window drops the skew allowance",
    "if (now - a.as_of > maxAgeMs + skewMs) {",
    "if (now - a.as_of > maxAgeMs) {",
    `${ATT} accepts an attestation exactly at window plus skew`,
  ),
  entry(
    "attestation: future-skew check removed",
    "if (a.as_of - now > skewMs) {",
    `if ${NEVER} {`,
    `${ATT} refuses an attestation dated in the future beyond skew`,
  ),
  entry(
    "attestation: rollback check removed",
    "if (a.seq_high_water < exp.lastSeenSeq) {",
    `if ${NEVER} {`,
    `${ATT} refuses a rollback below the last accepted seq_high_water`,
  ),
  entry(
    "attestation: verification order (challenge before signature)",
    `  const sig = await verifyRelaySignature(a);\n  if (sig !== "ok") return invalid(sig);\n\n  // 4. Challenge + delegator (the attestation, and every entry's record).\n  if (a.challenge !== exp.challenge) return invalid("challenge_mismatch");`,
    `  if (a.challenge !== exp.challenge) return invalid("challenge_mismatch");\n  const sig = await verifyRelaySignature(a);\n  if (sig !== "ok") return invalid(sig);`,
    `${ATT} checks the signature before the challenge (verification order)`,
  ),

  // ── producer ──
  entry(
    "signRevocationSetAttestation: ordering/high-water refusal removed",
    "if (!isPositiveSeq(e.seq) || e.seq <= prev || e.seq > body.seq_high_water) {",
    `if ${NEVER} {`,
    PRODUCER,
  ),
  entry(
    "signRevocationSetAttestation: foreign-delegator refusal removed",
    "if (e.record.delegator_id !== body.delegator_motebit_id) {",
    `if ${NEVER} {`,
    PRODUCER,
  ),
  entry(
    "signRevocationSetAttestation: count no longer derived from entries",
    "    count: body.entries.length,",
    "    count: 0,",
    `${ATT} accepts an attestation the pinned relay signed (happy path round-trip)`,
  ),

  // ── verifyRevocationInclusionReceipt ──
  entry(
    "receipt: spec check removed",
    'if (receipt.spec !== DELEGATION_REVOCATION_INCLUSION_RECEIPT_SPEC_MIRROR) {\n    return { valid: false, reason: "unsupported_spec" };\n  }\n  if (\n    !isNonEmptyString(receipt.relay_motebit_id)',
    `if ${NEVER} {\n    return { valid: false, reason: "unsupported_spec" };\n  }\n  if (\n    !isNonEmptyString(receipt.relay_motebit_id)`,
    `${RECEIPT} refuses an attestation presented as a receipt (spec domain separation)`,
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
    "    receipt.grant_id !== rev.grant_id ||\n    receipt.delegator_motebit_id !== rev.delegator_id ||\n    receipt.revocation_signature !== rev.signature\n",
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

  // ── verifyRevocationOmissionProof ──
  entry(
    "omission: high-water coverage check removed",
    "  if (attestation.seq_high_water < receipt.seq) {",
    `  if ${NEVER} {`,
    `${OMIT} does not hold when the attestation's high-water does not cover the receipted seq`,
  ),
  entry(
    "omission: same-relay-key check removed",
    "  if (receipt.relay_public_key !== attestation.relay_public_key) {",
    `  if ${NEVER} {`,
    `${OMIT} does not hold across different relay keys`,
  ),
  entry(
    "omission: same-delegator check removed",
    "  if (receipt.delegator_motebit_id !== attestation.delegator_motebit_id) {",
    `  if ${NEVER} {`,
    `${OMIT} does not hold across different delegators`,
  ),
  entry(
    "omission: signature checks removed",
    "  if (!(await selfSigned(receipt)) || !(await selfSigned(attestation))) {",
    `  if ${NEVER} {`,
    `${OMIT} does not hold when the receipt signature is forged`,
  ),
  entry(
    "omission: carried-at-seq match drops the seq",
    "      e.seq === receipt.seq &&\n",
    "",
    `${OMIT} holds when the attestation carries the record at a different seq than receipted`,
  ),
  entry(
    "omission: carried record ignored",
    `  if (carried) return { valid: false, reason: "record_carried" };`,
    `  if ${NEVER} return { valid: false, reason: "record_carried" };`,
    `${OMIT} does not hold when the attestation carries the receipted record`,
  ),

  // ── verifyRevocationEquivocationProof ──
  entry(
    "equivocation: same-high-water check removed",
    "  if (a.seq_high_water !== b.seq_high_water) {",
    `  if ${NEVER} {`,
    `${EQUIV} does not hold at different seq_high_water`,
  ),
  entry(
    "equivocation: different-digest check removed",
    "  if (a.records_digest === b.records_digest) {",
    `  if ${NEVER} {`,
    `${EQUIV} does not hold for two attestations over the same entries (challenge and as_of differ)`,
  ),
  entry(
    "equivocation: same-relay-key check removed",
    "  if (a.relay_public_key !== b.relay_public_key) {",
    `  if ${NEVER} {`,
    `${EQUIV} does not hold across different relay keys`,
  ),
  entry(
    "equivocation: same-delegator check removed",
    "  if (a.delegator_motebit_id !== b.delegator_motebit_id) {",
    `  if ${NEVER} {`,
    `${EQUIV} does not hold across different delegators`,
  ),
  entry(
    "equivocation: signature checks removed",
    "  if (!(await selfSigned(a)) || !(await selfSigned(b))) {",
    `  if ${NEVER} {`,
    `${EQUIV} does not hold when either attestation's signature is forged`,
  ),
];

void runTampers(TAMPERS, { root: ROOT });
