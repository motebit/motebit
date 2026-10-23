/**
 * Tamper check for the receipt.computer overclaim mitigation (cold review F-1,
 * F-2, F-3; round 2: B served-chain binding, D truthful copy, G unauthenticated
 * revocation; round 3: F1 any memo is reported, F2 canonical ids only, F3 the
 * claimed time is a claim; round 4: K1 every identity-bearing field in exact
 * canonical form + the memo scan on the decoded key, N1 an undated memo is a
 * memo, N2 the ✓'s scope, N3 an undisplayable claimed time is still shown).
 * Each entry reverts ONE fix point and names the tests that must go
 * red. The script applies the tamper, runs those tests, demands a non-zero exit,
 * and restores the file. An entry whose `find` text is not present exactly once
 * is a hard error — a tamper that silently fails to apply would be a false green.
 *
 *   node apps/verify/scripts/tamper-overclaim.mjs
 *   TAMPER_ONLY="F2:" node apps/verify/scripts/tamper-overclaim.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

const TAMPERS = [
  {
    name: "F-3: typing no longer clears the previous verdict at once",
    file: "src/main.ts",
    find: "  runSeq++; // and any in-flight run for the previous text may no longer render\n  clearResult();\n",
    replace: "",
    tests: ["src/__tests__/page.test.ts", "-t", "typing"],
  },
  {
    name: "F-3: a verifier exception is no longer rendered as Not verified",
    file: "src/main.ts",
    find: "    if (seq === runSeq) resultContainer.replaceChildren(renderUnverifiable(err));",
    replace: "    throw err;",
    tests: ["src/__tests__/page.test.ts", "-t", "F-3"],
  },
  {
    name: "F-3: a run (share-link hashchange) no longer clears before verifying",
    file: "src/main.ts",
    find: "  clearResult();\n  verifyBtn.disabled = true;",
    replace: "  verifyBtn.disabled = true;",
    tests: ["src/__tests__/page.test.ts", "-t", "hashchange"],
  },
  {
    name: "F-1: the verifier's sovereign passes through to the page",
    file: "src/assess.ts",
    find: '  if (v.binding === "unverified") {\n    shown = "unverified";',
    replace:
      '  if (v.binding === "unverified" || v.binding === "sovereign") {\n    shown = v.binding as never;',
    tests: ["src/__tests__/page.test.ts", "-t", "SOVEREIGN"],
  },
  {
    name: "B: a served chain that binds the key no longer lifts the page to PINNED",
    file: "src/assess.ts",
    find: '  } else if (chain?.kind === "bound" && verifierBound) {',
    replace: "  } else if (false) {",
    tests: ["src/__tests__/page.test.ts", "-t", "PINNED, not KEY COMMITMENT"],
  },
  {
    name: "B: the page stops checking the served chain itself",
    file: "src/main.ts",
    find: "        servedChain: await checkServedChain(receipt, resolved.identity),\n",
    replace: "",
    tests: ["src/__tests__/page.test.ts", "-t", "PINNED, not KEY COMMITMENT"],
  },
  {
    name: "B: the page check hands the file-named guardian to the verifier",
    file: "src/served-chain.ts",
    find: "verifyKeyBindingAtTime(withoutGuardian, key, at)",
    replace: "verifyKeyBindingAtTime(identity, key, at)",
    tests: ["src/__tests__/page.test.ts", "-t", "guardian named only"],
  },
  {
    name: "B: a self-certifying id no longer has to root the served chain at its own key",
    file: "src/served-chain.ts",
    find: "        return r.sovereign === true\n",
    replace: "        return true\n",
    tests: ["src/__tests__/page.test.ts", "-t", "genesis is not the key"],
  },
  {
    name: "B: the verifier's pinned/anchored passes through without the page's chain check",
    file: "src/assess.ts",
    find: '  } else if (chain?.kind === "bound" && verifierBound) {',
    replace:
      '  } else if ((chain?.kind === "bound" || v.binding === "pinned" || v.binding === "anchored") && verifierBound) {',
    tests: ["src/__tests__/page.test.ts", "-t", "same forged guardian on a legacy id"],
  },
  {
    name: "B/D: KEY COMMITMENT shown without the id committing to the signing key",
    file: "src/assess.ts",
    find: '  } else if (keyEvidence.keyCommitsToId && v.binding === "sovereign") {',
    replace: '  } else if (v.binding === "sovereign") {',
    tests: ["src/__tests__/page.test.ts", "-t", "guardian named only"],
  },
  {
    name: "D: the served-chain outcome is dropped, so the copy says no succession check ran",
    file: "src/assess.ts",
    find: '  if (chain !== undefined && chain.kind !== "bound" && v.integrity) out.chainCheck = chain.kind;\n',
    replace: "",
    tests: [
      "src/__tests__/page.test.ts",
      "-t",
      "retired genesis key signing after rotation → KEY COMMITMENT",
    ],
  },
  {
    name: "D: the binding rung claims 'no succession check ran' after one ran",
    file: "src/ladder.ts",
    find: "          v.chainCheck !== undefined\n            ? `not bound",
    replace: "          false\n            ? `not bound",
    tests: [
      "src/__tests__/page.test.ts",
      "-t",
      "retired genesis key signing after rotation → KEY COMMITMENT",
    ],
  },
  {
    name: "D: the PINNED copy calls the served chain non-equivocable",
    file: "src/labels.ts",
    find: "The chain is not shown to be committed in the operator's transparency log (the anchored rung).",
    replace:
      "It does not yet prove the chain is the operator's current, non-equivocable record (the anchored rung).",
    tests: ["src/__tests__/page.test.ts", "-t", "PINNED, not KEY COMMITMENT"],
  },
  {
    name: "G: an unauthenticated revocation memo is graded REVOKED",
    file: "src/labels.ts",
    find: '      grade: "REVOCATION REPORTED",',
    replace: '      grade: "REVOKED",',
    tests: ["src/__tests__/page.test.ts", "-t", "third-party memo"],
  },
  {
    name: "G: the verdict headline says 'Key revoked'",
    file: "src/labels.ts",
    find: '      headline: "REVOCATION REPORTED (unauthenticated) — do not rely on this receipt",',
    replace: '      headline: "Key revoked — do not trust",',
    tests: ["src/__tests__/page.test.ts", "-t", "third-party memo"],
  },
  {
    name: "G: the revocation rung states 'revoked on-chain at' as fact",
    file: "src/ladder.ts",
    find: "      summary: `REVOCATION REPORTED (unauthenticated) — ${when}, reported whatever this receipt's claimed time; who posted it was not checked — read ${sourceLabel(v.chainSource)}`,",
    replace: "      summary: `revoked on-chain at ${when}`,",
    tests: ["src/__tests__/page.test.ts", "-t", "third-party memo"],
  },
  {
    name: "G: the claim chip says REVOKED",
    file: "src/render.ts",
    find: '      ? "REVOCATION REPORTED"\n      : "valid signature";',
    replace: '      ? "REVOKED"\n      : "valid signature";',
    tests: ["src/__tests__/page.test.ts", "-t", "third-party memo"],
  },
  {
    name: "F-1: a truncated revocation scan is no longer refused",
    file: "src/assess.ts",
    find: "  if (!evidence.revocationScanComplete) {",
    replace: "  if (false) {",
    tests: ["src/__tests__/page.test.ts", "-t", "truncated"],
  },
  {
    name: "F-1: the page stops measuring scan completeness (always 'complete')",
    file: "src/main.ts",
    find: "revocationScanComplete: scansComplete(revocationScan.scans),",
    replace: "revocationScanComplete: true,",
    tests: ["src/__tests__/page.test.ts", "-t", "truncated"],
  },
  {
    name: "F-1: a scan that returned exactly the page limit counts as complete",
    file: "src/assess.ts",
    find: "s.returned < s.limit",
    replace: "s.returned <= s.limit",
    tests: ["src/__tests__/page.test.ts", "-t", "page limit hit"],
  },
  {
    name: "F-2: a proxy-read revocation scan is no longer refused",
    file: "src/assess.ts",
    find: '  if (evidence.source === "operator-proxy") {',
    replace: "  if (false) {",
    tests: ["src/__tests__/page.test.ts", "-t", "proxy reporting no revocation"],
  },
  {
    name: "F-2: a proxy-read anchor renders ANCHORED",
    file: "src/assess.ts",
    find: '    if (v.binding === "anchored" && evidence?.source === "independent") {',
    replace: '    if (v.binding === "anchored") {',
    tests: ["src/__tests__/page.test.ts", "-t", "operator proxy: an anchor"],
  },
  {
    name: "F-2: the page treats its own RPC proxy as independent",
    file: "src/main.ts",
    find: "const SOLANA_RPC_SOURCE = classifyRpc(SOLANA_RPC);",
    replace: 'const SOLANA_RPC_SOURCE = "independent" as const;',
    tests: ["src/__tests__/page.test.ts", "-t", "F-2"],
  },
  {
    name: "F-2: the copy claims the browser queries Solana with the receipt's key",
    file: "index.html",
    find: "and read Solana\n              through Motebit's RPC proxy (api.motebit.com) at the relay's anchor address.",
    replace: "and Solana, with its public key.",
    tests: ["src/__tests__/page.test.ts", "-t", "page copy"],
  },
  // ── Round 3 ──
  {
    name: "F1: a memo dated after the claimed completed_at clears the key again",
    file: "src/assess.ts",
    find: '    v.revocation === "revoked_after_signing" ||\n',
    replace: "",
    // The page's own decoded-key scan also finds such a memo (round 4), so the
    // page-level matrix stays green; the unit test pins this fix point alone.
    tests: ["src/__tests__/assess.test.ts", "-t", "a memo dated AFTER the claimed completed_at"],
  },
  {
    name: "F1: the reported memo's date is again said to be at or before this receipt",
    file: "src/ladder.ts",
    find: ", reported whatever this receipt's claimed time;",
    replace: ", at or before this receipt;",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "memo dated before the claimed time"],
  },
  {
    name: "F1: the REPORTED card stops saying the claimed time cannot clear a memo",
    file: "src/labels.ts",
    find: "Its date is not weighed against this receipt's: ${CLAIMED_TIME}, and a receipt dated before the memo may have been signed after it. ",
    replace: "",
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "memo dated exactly at the claimed time",
    ],
  },
  {
    name: "F1 nit: the binding rung is ✗ where the text says not established",
    file: "src/ladder.ts",
    find: '        state: "skipped",\n        summary: "not established — a revocation memo (unauthenticated) was reported for this key",',
    replace:
      '        state: "failed",\n        summary: "not established — a revocation memo (unauthenticated) was reported for this key",',
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "fabricated junk memo"],
  },
  {
    name: "F2: a non-canonical id is no longer refused by the served-chain check",
    file: "src/served-chain.ts",
    find: '  if (form === "noncanonical") return { kind: "noncanonical_id" };\n',
    replace: "",
    // Rule 7 (round 4) also refuses a non-canonical id at the page level.
    tests: ["src/__tests__/served-chain.test.ts", "-t", "only an exactly canonical id"],
  },
  {
    name: "F2: any non-v8, non-did:key id falls back to the relay-record root",
    file: "src/served-chain.ts",
    find: "const UUID_LEGACY = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;",
    replace: "const UUID_LEGACY = /^[\\s\\S]*$/;",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "zero-width space"],
  },
  {
    name: "F2: the UUIDv8 match is case-insensitive again",
    file: "src/served-chain.ts",
    find: "const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;",
    replace:
      "const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;",
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "uppercase UUIDv8 signed by the key it commits to",
    ],
  },
  {
    name: "F2: the did:key match accepts any case and any characters",
    file: "src/served-chain.ts",
    find: "const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;",
    replace: "const DID_KEY = /^did:key:/i;",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "DID:KEY uppercase prefix"],
  },
  {
    name: "F2: a key commitment is computed for a non-canonical id",
    file: "src/served-chain.ts",
    find: "  if (!isSelfCertifyingId(motebitId)) return false;\n",
    replace: "",
    tests: ["src/__tests__/served-chain.test.ts", "-t", "only an exactly canonical id"],
  },
  {
    name: "F2: the page stops classifying the id, so a did:key commitment is no longer described as encoding the key",
    file: "src/main.ts",
    find: "        idForm: classifyId(receipt.motebit_id),\n",
    replace: "",
    // Since round 4 the not-canonical copy comes from rule 7's field list;
    // idForm still decides how a did:key commitment is described.
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "says the id encodes the key"],
  },
  {
    name: "F3: the PINNED card drops what it does not prove",
    file: "src/labels.ts",
    find: " This does not prove when the receipt was issued, that the relay served the complete history (a later rotation the relay did not serve would not show here), or that the key was uncompromised.",
    replace: " A later rotation the relay did not serve would not show here.",
    tests: ["src/__tests__/page.test.ts", "-t", "PINNED is conditional ON THE CARD"],
  },
  {
    name: "F3: the PINNED card treats the claimed time as the receipt's time",
    file: "src/labels.ts",
    find: "at the time this receipt claims — ${CLAIMED_TIME}.",
    replace: "at this receipt's time.",
    tests: ["src/__tests__/page.test.ts", "-t", "PINNED is conditional ON THE CARD"],
  },
  {
    name: "F3: the pinned rung says time-valid at the receipt's time",
    file: "src/ladder.ts",
    find: "          : `pinned — the key fits the time window at the time this receipt claims (completed_at, the signer's own claim) in this motebit's identity chain, as served by the relay${root}; when the receipt was issued is not proven`,",
    replace:
      "          : `pinned — the key was time-valid at the receipt's time in this motebit's identity chain, as served by the relay${root}`,",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "canonical legacy UUIDv7"],
  },
  {
    name: "F3: the KEY COMMITMENT card stops saying completed_at is a claim",
    file: "src/labels.ts",
    find: "${succession} This receipt's ${CLAIMED_TIME}. A key minted",
    replace: "${succession} A key minted",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "a record served for another motebit"],
  },
  {
    name: "F3: the honesty block says 'when it signed' for a key commitment",
    file: "src/honesty.ts",
    find: "        : \"That this key was still the motebit's key when the receipt was issued — completed_at is the signer's own claim, and rotation and revocation were not established.\",",
    replace:
      '        : "That this key was still the motebit\'s key when it signed — rotation and revocation not established.",',
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "relay down → KEY COMMITMENT that says",
    ],
  },
  {
    name: "F3: the honesty block says 'dated before signing' after a complete scan",
    file: "src/honesty.ts",
    find: "only that no revocation memo naming it, at any date, is at the anchor address the relay declares (a complete scan of that one address through an independent RPC); memos anywhere else were not looked for.",
    replace: "only that no revocation memo dated before signing was found on-chain.",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "a memo for another key"],
  },
  {
    name: "F3: did:key KEY COMMITMENT copy calls the id a hash of the key",
    file: "src/labels.ts",
    find: '    ? "the motebit_id encodes this signing key (a did:key)"',
    replace: '    ? "the motebit_id is a hash of this signing key"',
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "relay down → KEY COMMITMENT that says",
    ],
  },
  {
    name: "F3: the claim field no longer marks completed_at as the signer's claim",
    file: "src/render.ts",
    find: "dl.append(field(`${label} (signer's claim)`, value));",
    replace: "dl.append(field(label, value));",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "canonical legacy UUIDv4"],
  },
  {
    name: "F3: llms.txt again says a memo is compared with the receipt's time",
    file: "public/llms.txt",
    find: ", whatever its date relative to the receipt's `completed_at`: that time is the signer's own claim, so a memo dated after it clears nothing.",
    replace: ", when it is dated at or before the receipt.",
    tests: ["src/__tests__/page.test.ts", "-t", "llms.txt"],
  },
  // ── Round 4 ──
  {
    name: "K1/rule 7: a field not in canonical form no longer drops the binding",
    file: "src/assess.ts",
    find: '  } else if (noncanonical.length > 0) {\n    shown = "integrity-only";',
    replace: '  } else if (false) {\n    shown = "integrity-only";',
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "suite: an unknown suite →"],
  },
  {
    name: "K1/rule 7: a field not in canonical form may earn a revocation ✓",
    file: "src/assess.ts",
    find: "  } else if (noncanonical.length > 0 && v.integrity) {",
    replace: "  } else if (false) {",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "signature: = padding →"],
  },
  {
    name: "K1: public_key is no longer checked for canonical form",
    file: "src/canonical.ts",
    find: '  if (!isCanonicalKeyHex(r["public_key"])) out.push("public_key");\n',
    replace: "",
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "Y1 genesis key with a trailing space, no memo",
    ],
  },
  {
    name: "K1: the canonical key form accepts upper case",
    file: "src/canonical.ts",
    find: "const KEY_HEX = /^[0-9a-f]{64}$/;",
    replace: "const KEY_HEX = /^[0-9a-f]{64}$/i;",
    tests: ["src/__tests__/canonical.test.ts", "-t", "public_key"],
  },
  {
    name: "K1: signature is no longer checked for canonical form",
    file: "src/canonical.ts",
    find: '  if (!isCanonicalSignature(r["signature"])) out.push("signature");\n',
    replace: "",
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "signature: the standard base64 alphabet →",
    ],
  },
  {
    name: "K1: the canonical signature form ignores stray trailing bits",
    file: "src/canonical.ts",
    find: "const SIG_B64URL = /^[A-Za-z0-9_-]{85}[AQgw]$/;",
    replace: "const SIG_B64URL = /^[A-Za-z0-9_-]{86}$/;",
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "non-zero trailing bits in the last character →",
    ],
  },
  {
    name: "K1: suite is no longer checked",
    file: "src/canonical.ts",
    find: '  if (!isRecognizedSuite(r["suite"])) out.push("suite");\n',
    replace: "",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "suite: the hex suite"],
  },
  {
    name: "K1: the served-chain check binds a re-spelled key",
    file: "src/served-chain.ts",
    find: '  if (!KEY_HEX.test(key)) return { kind: "noncanonical_key" };\n',
    replace: "",
    tests: ["src/__tests__/served-chain.test.ts", "-t", "a signing key not in canonical form"],
  },
  {
    name: "K1: a re-spelled key still commits to the id",
    file: "src/served-chain.ts",
    find: "  if (!KEY_HEX.test(publicKeyHex)) return false;\n",
    replace: "",
    tests: ["src/__tests__/served-chain.test.ts", "-t", "a signing key not in canonical form"],
  },
  {
    name: "K1 defence in depth: the page's memo scan is keyed on the key TEXT again",
    file: "src/main.ts",
    find: "      const decodedKey = canonicalKeyHexOfDid(view.signerDid);",
    replace:
      '      const decodedKey = typeof receipt.public_key === "string" ? receipt.public_key : undefined;',
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "key: -1 for 0xff .decodes to the same bytes., owner's memo",
    ],
  },
  {
    name: "K1 defence in depth: the page's own scan no longer counts as finding a memo",
    file: "src/assess.ts",
    find: '    v.binding === "revoked" ||\n    scanFound;',
    replace: '    v.binding === "revoked";',
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "key: a plus sign .decodes to the same bytes., owner's memo",
    ],
  },
  {
    name: "K1 defence in depth: the page stops running its own scan",
    file: "src/main.ts",
    find: "        ...(memoScan !== undefined ? { memoScan } : {}),\n",
    replace: "",
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "Y1 genesis key with a trailing tab, owner's memo",
    ],
  },
  {
    name: "rule 8: a ✓ no longer needs the page's own scan to have run",
    file: "src/assess.ts",
    find: '  if (evidence.memoScan?.status !== "none") {',
    replace: "  if (false) {",
    tests: ["src/__tests__/assess.test.ts", "-t", "own decoded-key scan"],
  },
  {
    name: "rule 8: a failed page scan no longer holds revocation at not established",
    file: "src/assess.ts",
    find: '  if (evidence.memoScan?.status === "unknown") {',
    replace: "  if (false) {",
    tests: ["src/__tests__/assess.test.ts", "-t", "own decoded-key scan"],
  },
  {
    name: "N1: a memo naming the key with no usable date is dropped again",
    file: "src/memo-scan.ts",
    find: '  if (!found) return { status: "none" };',
    replace: '  if (earliest === undefined) return { status: "none" };',
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "a memo with a word for a timestamp"],
  },
  {
    name: "N1: a memo with no timestamp separator is not matched",
    file: "src/memo-scan.ts",
    find: "  const needle = `${REVOCATION_MEMO_PREFIX}${keyHex.toLowerCase()}`;",
    replace: "  const needle = `${REVOCATION_MEMO_PREFIX}${keyHex.toLowerCase()}:`;",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "a memo with no timestamp separator"],
  },
  {
    name: "N1: a memo date outside the Date range is formatted (and throws)",
    file: "src/labels.ts",
    find: " || Math.abs(ms) > 8.64e15",
    replace: "",
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "a timestamp past the last representable date",
    ],
  },
  {
    name: "N2: the revocation ✓ again reads as a scan of the whole chain",
    file: "src/ladder.ts",
    find: '          "no revocation memo naming the signing key at the anchor address the relay declares (its transparency declaration, fetched on this visit) — a complete scan of that one address through an independent RPC; memos anywhere else were not looked for",',
    replace:
      '          "no revocation memo found for the signing key — a complete scan through an independent RPC",',
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "a memo for another key .control."],
  },
  {
    name: "N3: a claimed time outside the displayable range is dropped from the claim",
    file: "src/claim.ts",
    find: "      return `${String(value)} — outside the range of dates this page can display`;",
    replace: "      return undefined;",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "completed_at 1e20"],
  },
  {
    name: "N3: a fractional claimed time is shown rounded, with no value as written",
    file: "src/claim.ts",
    find: "    return Number.isSafeInteger(value) ? undefined : `${String(value)} as written`;",
    replace: "    return undefined;",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "completed_at a fraction"],
  },
  {
    name: "N4: an unverifiable re-spelled key is called altered or forged",
    file: "src/labels.ts",
    find: "        why.length > 0\n",
    replace: "        false\n",
    tests: ["src/__tests__/claimed-vs-proven.test.ts", "-t", "key: a leading zero"],
  },
  {
    name: "N4: the page stops passing field forms when integrity fails",
    file: "src/main.ts",
    find: "    : { ...NO_BINDING_EVIDENCE, noncanonical };",
    replace: "    : NO_BINDING_EVIDENCE;",
    tests: [
      "src/__tests__/claimed-vs-proven.test.ts",
      "-t",
      "signature: the same signature hex-encoded",
    ],
  },
  {
    name: "N4: the INTEGRITY ONLY card stops naming the non-canonical field",
    file: "src/labels.ts",
    find: "    formSentences(v) ??\n",
    replace: "",
    tests: ["src/__tests__/labels.test.ts", "-t", "integrity-only names each field"],
  },
  {
    name: "N4: the binding rung stops naming the non-canonical field",
    file: "src/ladder.ts",
    find: "      if (v.noncanonical !== undefined && v.noncanonical.length > 0) {",
    replace: "      if (false) {",
    tests: ["src/__tests__/ladder.test.ts", "-t", "the binding rung names each field"],
  },
  {
    name: "round 4: llms.txt drops the canonical-form rule",
    file: "public/llms.txt",
    find: "`public_key` exactly 64 lowercase hex characters",
    replace: "`public_key` in hex",
    tests: ["src/__tests__/page.test.ts", "-t", "round 4"],
  },
];

function vitest(args) {
  return spawnSync("pnpm", ["exec", "vitest", "run", ...args], {
    cwd: APP,
    encoding: "utf8",
  });
}

// TAMPER_ONLY=<substring> runs only the entries whose name contains it (iteration aid;
// the full run is the gate).
const only = process.env.TAMPER_ONLY;
let failures = 0;
for (const t of only ? TAMPERS.filter((x) => x.name.includes(only)) : TAMPERS) {
  const path = join(APP, t.file);
  const original = readFileSync(path, "utf8");
  const count = original.split(t.find).length - 1;
  if (count !== 1) {
    console.error(`✗ ${t.name}: tamper text found ${count}× in ${t.file} — re-target this entry`);
    failures++;
    continue;
  }
  writeFileSync(path, original.replace(t.find, t.replace));
  try {
    const r = vitest(t.tests);
    const summary = /Tests\s+([^\n]+)/.exec(r.stdout)?.[1]?.trim() ?? "(no summary)";
    if (r.status === 0) {
      console.error(`✗ ${t.name}: tests stayed GREEN with the fix removed — ${summary}`);
      failures++;
    } else {
      console.log(`✓ red as expected: ${t.name} — ${summary}`);
    }
  } finally {
    writeFileSync(path, original);
  }
}

const restored = vitest(["src/__tests__/page.test.ts", "src/__tests__/claimed-vs-proven.test.ts"]);
if (restored.status !== 0) {
  console.error("✗ page / claimed-vs-proven tests are not green after restoring every file");
  failures++;
} else {
  console.log("✓ all fixes restored: page and claimed-vs-proven tests green");
}
process.exit(failures === 0 ? 0 : 1);
