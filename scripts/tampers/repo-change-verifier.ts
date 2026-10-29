/**
 * Tamper checks for the governed repo change verifier core
 * (`verifyRepoChange`, packages/verifier/src/repo-change.ts;
 * spec/repo-change-v1.md §7). Milestone B build step 1's acceptance
 * criterion: every condition in every axis is load-bearing — each entry
 * removes ONE check (or one disjunct of a multi-condition check, or one row
 * of a checked list) and the test named for that condition must go red.
 *
 * Entries are `command` entries (the delegation-key-canonical.ts shape): on
 * this tree the runner's vitest mode reads no JSON report, because
 * `vitest.shared.ts` pins the json reporter's `outputFile` and the CLI
 * `--outputFile.json` the runner passes does not override it (fixed by #1201,
 * not merged on this base). Each command runs ONE test (`-t` on its exact
 * full name) and is RED only when that file reports a failure.
 *
 *   npx tsx scripts/tampers/repo-change-verifier.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = "packages/verifier/src/repo-change.ts";
/** The shared rules `verifyRepoChange` calls (and the repo-task run calls too). */
const RULES = "packages/verifier/src/repo-change-rules.ts";
const TEST = "src/__tests__/repo-change.test.ts";

const POS = "verifyRepoChange positive controls";
const INT = "verifyRepoChange integrity";
const IDB = "verifyRepoChange identityBinding";
const AUT = "verifyRepoChange authority";
const ENT = `${AUT} a change entry outside the scope`;
const REV = "verifyRepoChange revocation";

/**
 * One edit to the verifier source: in `repo-change.ts`, or in the shared
 * rules module when the text lives there (the rules moved out of the core so
 * the runtime runs the same implementation). The runner still requires the
 * text to occur exactly once in the file chosen.
 */
function edit(from: string, to: string): TamperEdit {
  const inRules = readFileSync(path.join(ROOT, RULES), "utf8").includes(from);
  return { file: inRules ? RULES : SRC, from, to };
}

/** Prefix a check's condition with `false &&`, so the check never fires. */
function off(condition: string): TamperEdit {
  return edit(condition, condition.replace(/^(\s*(?:\} else )?if \()/, "$1(false as boolean) && "));
}

function entry(name: string, red: string, ...edits: TamperEdit[]): TamperEntry {
  return {
    name,
    edits,
    command: [
      "pnpm",
      "--filter",
      "@motebit/verifier",
      "exec",
      "vitest",
      "run",
      TEST,
      "-t",
      `^${escapeRegExp(red)}$`,
    ],
    redMarker: "Test Files  1 failed",
  };
}

const TAMPERS: TamperEntry[] = [
  // ── integrity ──────────────────────────────────────────────────────────
  entry(
    "integrity: bundle decoding is lenient UTF-8",
    `${INT} bundle bytes with an invalid UTF-8 byte inside a string are malformed`,
    edit(
      'new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })',
      'new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })',
    ),
  ),
  entry(
    "integrity: bundle decoding strips a BOM",
    `${INT} a byte-order mark before the bundle is malformed`,
    edit(
      'new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })',
      'new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })',
    ),
  ),
  entry(
    "integrity: tick grant_id made optional",
    `${INT} a tick without grant_id is malformed`,
    edit(
      '        "grant_id",\n        "suite",\n        "signature",\n      ],\n      ["not_before"],',
      '        "suite",\n        "signature",\n      ],\n      ["not_before", "grant_id"],',
    ),
    edit(
      "    isString(v.grant_id) &&\n    v.suite",
      "    (v.grant_id === undefined || isString(v.grant_id)) &&\n    v.suite",
    ),
  ),
  entry(
    "integrity: bundle shape accepts unnamed keys",
    `${INT} a bundle with a key the spec does not name is malformed`,
    edit(
      '    hasExactKeys(v, ["spec", "scope", "grant", "tick", "tool_receipts", "receipt"]) &&\n',
      "",
    ),
  ),
  entry(
    "integrity: receipt profile admits relay_task_id",
    `${INT} a receipt carrying a field outside the repo-change profile is malformed`,
    edit(
      '      ["delegated_scope", "invocation_origin"],',
      '      ["delegated_scope", "invocation_origin", "relay_task_id"],',
    ),
  ),
  entry(
    "integrity: bundle canonical-bytes check removed",
    `${INT} bundle bytes that are not the canonical JSON are rejected`,
    off("  if (canonicalJson(bundle) !== text) {"),
  ),
  ...(
    [
      [
        "grant.delegator_public_key",
        '    ["grant.delegator_public_key", grant.delegator_public_key],\n',
      ],
      [
        "grant.delegate_public_key",
        '    ["grant.delegate_public_key", grant.delegate_public_key],\n',
      ],
      [
        "tick.delegator_public_key",
        '    ["tick.delegator_public_key", tick.delegator_public_key],\n',
      ],
      ["tick.delegate_public_key", '    ["tick.delegate_public_key", tick.delegate_public_key],\n'],
      ["receipt.public_key", '    ["receipt.public_key", receipt.public_key],\n'],
    ] as const
  ).map(([site, row]) =>
    entry(
      `integrity: canonical-key row removed (${site})`,
      `${INT} a non-canonical key is rejected: ${site}`,
      edit(row, ""),
    ),
  ),
  entry(
    "integrity: canonical tick signature row removed (B5a)",
    `${INT} B5a: a tick signature re-spelled in non-canonical base64url, with the record re-signed over it, fails on canonicality alone`,
    edit('    ["tick.signature", tick.signature],\n', ""),
  ),
  entry(
    "integrity: canonical grant signature row removed",
    `${INT} a non-canonical grant signature is rejected`,
    edit('    ["grant.signature", grant.signature],\n', ""),
  ),
  entry(
    "integrity: canonical receipt signature row removed",
    `${INT} a non-canonical receipt signature is rejected`,
    edit('    ["receipt.signature", receipt.signature],\n', ""),
  ),
  entry(
    "integrity: canonical base64url round trip removed",
    `${INT} a non-canonical receipt signature is rejected`,
    edit(
      "    return toBase64Url(fromBase64Url(s)) === s;",
      "    return fromBase64Url(s).length > 0;",
    ),
  ),
  entry(
    "integrity: grant_id UUID check removed",
    `${INT} a grant_id that is not a lowercase UUID is rejected`,
    off("  if (!CANONICAL_UUID.test(grant.grant_id)) notCanonical("),
  ),
  entry(
    "integrity: subject_binding digest canonical check removed",
    `${INT} a non-canonical subject_binding digest is rejected`,
    off(
      "  if (grant.subject_binding !== undefined && !HEX64.test(grant.subject_binding.digest)) {",
    ),
  ),
  entry(
    "integrity: prompt_hash canonical check removed",
    `${INT} a non-canonical prompt_hash is rejected`,
    off("  if (!HEX64.test(receipt.prompt_hash)) notCanonical("),
  ),
  entry(
    "integrity: result_hash canonical check removed",
    `${INT} a non-canonical result_hash is rejected`,
    off("  if (!HEX64.test(receipt.result_hash)) notCanonical("),
  ),
  entry(
    "integrity: tool receipt public_key canonical check removed",
    `${INT} a tool receipt with a non-canonical public_key is rejected`,
    off("    if (!HEX64.test(tr.public_key))\n      notCanonical("),
  ),
  entry(
    "integrity: tool receipt signature canonical check removed",
    `${INT} a tool receipt with a non-canonical signature is rejected`,
    off("    if (!isCanonicalBase64Url(tr.signature)) {"),
  ),
  entry(
    "integrity: tool receipt args_hash canonical check removed",
    `${INT} a tool receipt with a non-canonical args_hash is rejected`,
    off("    if (!HEX64.test(tr.args_hash))"),
  ),
  entry(
    "integrity: tool receipt result_hash canonical check removed",
    `${INT} a tool receipt with a non-canonical result_hash is rejected`,
    off("    if (!HEX64.test(tr.result_hash))"),
  ),
  entry(
    "integrity: path segment charset rule removed",
    `${INT} a non-canonical allowed path is rejected: ${JSON.stringify("docs/Aſ.md")}`,
    edit("    if (!PATH_SEGMENT.test(seg)) return false;\n", ""),
  ),
  entry(
    "integrity: empty path segment rule removed",
    `${INT} a non-canonical allowed path is rejected: ${JSON.stringify("docs//a.md")}`,
    edit("    if (!PATH_SEGMENT.test(seg)) return false;\n", ""),
  ),
  entry(
    "integrity: leading-slash path rule removed",
    `${INT} a non-canonical allowed path is rejected: ${JSON.stringify("/docs/a.md")}`,
    edit("    if (!PATH_SEGMENT.test(seg)) return false;\n", ""),
  ),
  ...(["docs/./a.md", "docs/../a.md", "docs/a.", ".git./config"] as const).map((bad) =>
    entry(
      `integrity: trailing-dot segment rule removed (${bad})`,
      `${INT} a non-canonical allowed path is rejected: ${JSON.stringify(bad)}`,
      edit(
        '    if (seg.endsWith(".") || seg.toLowerCase() === ".git") return false;',
        '    if (seg.toLowerCase() === ".git") return false;',
      ),
    ),
  ),
  entry(
    "integrity: '.git' segment rule made case-sensitive",
    `${INT} a non-canonical allowed path is rejected: ${JSON.stringify(".GIT/config")}`,
    edit(
      'seg.endsWith(".") || seg.toLowerCase() === ".git"',
      'seg.endsWith(".") || seg === ".git"',
    ),
  ),
  entry(
    "integrity: allowed_paths canonical check removed",
    `${INT} a non-canonical allowed path is rejected: ${JSON.stringify("docs/../a.md")}`,
    off("    if (!isCanonicalPath(p))\n      notCanonical(`scope.allowed_paths"),
  ),
  entry(
    "integrity: allowed_paths repeat check removed",
    `${INT} a repeated allowed path is rejected`,
    off("    if (seenAllowed.has(p)) notCanonical("),
  ),
  entry(
    "integrity: record digest row removed (system_prompt_digest)",
    `${INT} a non-canonical record digest is rejected`,
    edit('      ["system_prompt_digest", record.system_prompt_digest],\n', ""),
  ),
  entry(
    "integrity: record tool receipt digest rows removed",
    `${INT} a non-canonical recorded tool receipt digest is rejected`,
    edit(
      "      ...record.tool_receipt_digests.map((d, i) => [`tool_receipt_digests[${i}]`, d] as const),\n",
      "",
    ),
  ),
  entry(
    "integrity: parent_commit canonical row removed",
    `${INT} a parent_commit of the wrong length for the object format is rejected`,
    edit('      ["parent_commit", record.parent_commit],\n', ""),
  ),
  entry(
    "integrity: head_commit canonical row removed",
    `${INT} an uppercase head_commit is rejected`,
    edit('      ["head_commit", record.head_commit],\n', ""),
  ),
  entry(
    "integrity: object id length check made length-blind",
    `${INT} a parent_commit of the wrong length for the object format is rejected`,
    edit(
      "  return s.length === length && /^[0-9a-f]*$/.test(s);",
      "  return length > 0 && /^[0-9a-f]*$/.test(s);",
    ),
  ),
  entry(
    "integrity: recorded entry path canonical check removed",
    `${INT} a recorded entry with a non-canonical path is rejected`,
    off("      if (!isCanonicalPath(e.path)) notCanonical("),
  ),
  entry(
    "integrity: recorded entry mode canonical check removed",
    `${INT} a recorded entry with a mode that is not six octal digits is rejected`,
    off("      if (!OCTAL_MODE.test(e.mode))"),
  ),
  entry(
    "integrity: recorded entry blob canonical check removed",
    `${INT} a recorded entry with a blob of the wrong length is rejected`,
    off("      if (!isCanonicalHex(e.blob, idLength))"),
  ),
  entry(
    "integrity: recorded entries order check removed",
    `${INT} recorded entries that are not sorted by path are rejected`,
    off("      if (prev !== undefined && !(prev.path < e.path)) {"),
  ),
  entry(
    "integrity: grant signature check removed",
    `${INT} a grant whose signature does not verify is rejected`,
    off("  if (!grantSigned)"),
  ),
  entry(
    "integrity: tick signature check removed",
    `${INT} a tick whose signature does not verify is rejected`,
    off("  if (!tickSigned) {"),
  ),
  entry(
    "integrity: execution receipt signature check removed",
    `${INT} an execution receipt whose signature does not verify is rejected`,
    off("  if (!receiptSigned) {"),
  ),
  entry(
    "integrity: tool receipt signature check removed",
    `${INT} a tool receipt whose signature does not verify is rejected`,
    off("    if (!signed)"),
  ),
  entry(
    "integrity: result_hash binding check removed",
    `${INT} a result_hash that does not bind the result is rejected`,
    off("  if ((await hash(ENCODER.encode(receipt.result))) !== receipt.result_hash) {"),
  ),
  entry(
    "integrity: change-record shape accepts unnamed keys",
    `${INT} a record with a key the spec does not name is malformed`,
    edit('      "runtime_version",\n    ]) &&', '      "runtime_version",\n    ], ["note"]) &&'),
  ),
  entry(
    "integrity: change-record canonical check removed",
    `${INT} a result that is not the record's canonical JSON is rejected`,
    off("    if (canonicalJson(record) !== receipt.result) {"),
  ),
  entry(
    "integrity: subject_binding match check removed",
    `${INT} a scope that does not match the grant's subject_binding is rejected`,
    off("    if (!match.valid)"),
  ),
  entry(
    "integrity: record grant_id check removed",
    `${INT} a record naming another grant is rejected`,
    off("    if (record.grant_id !== grant.grant_id) {"),
  ),
  entry(
    "integrity: record grant_digest check removed",
    `${INT} a record whose grant_digest is not the bundle grant's is rejected`,
    off("    if (record.grant_digest.value !== (await canonicalSha256(grant))) {"),
  ),
  entry(
    "integrity: record tick_digest check removed",
    `${INT} a record whose tick_digest is not the bundle tick's is rejected`,
    off("    if (record.tick_digest.value !== (await canonicalSha256(tick))) {"),
  ),
  entry(
    "integrity: record scope_digest check removed",
    `${INT} a record whose scope_digest is not the bundle scope's is rejected`,
    off("    if (record.scope_digest.value !== (await subjectBindingDigest(scope))) {"),
  ),
  entry(
    "integrity: record repo reference disjunct removed",
    `${INT} a record whose repo differs from the scope's is rejected`,
    edit(
      "    if (record.repo !== scope.repo || record.object_format !== scope.object_format) {",
      "    if (record.object_format !== scope.object_format) {",
    ),
  ),
  entry(
    "integrity: record object_format reference disjunct removed",
    `${INT} a record whose object_format differs from the scope's is rejected`,
    edit(
      "    if (record.repo !== scope.repo || record.object_format !== scope.object_format) {",
      "    if (record.repo !== scope.repo) {",
    ),
  ),
  entry(
    "integrity: prompt_hash binding check removed",
    `${INT} a prompt_hash that is not the digest of the scope's task is rejected`,
    off("  if (receipt.prompt_hash !== (await hash(ENCODER.encode(scope.task)))) {"),
  ),
  entry(
    "integrity: tool receipt digests — size disjunct removed",
    `${INT} a record listing a digest beside every bundled one is rejected`,
    edit("      bundledSet.size !== recordedSet.size ||\n", ""),
  ),
  entry(
    "integrity: tool receipt digests — membership disjunct removed",
    `${INT} a record naming another receipt in place of a bundled one is rejected`,
    edit(
      "      bundledSet.size !== recordedSet.size ||\n      [...bundledSet].some((d) => !recordedSet.has(d))\n",
      "      bundledSet.size !== recordedSet.size\n",
    ),
  ),
  entry(
    "integrity: tool receipt digests — size and membership disjuncts removed",
    `${INT} a record that omits a bundled tool receipt's digest is rejected`,
    edit(
      "      recordedSet.size !== recorded.length ||\n      bundledSet.size !== recordedSet.size ||\n      [...bundledSet].some((d) => !recordedSet.has(d))\n",
      "      recordedSet.size !== recorded.length\n",
    ),
  ),
  entry(
    "integrity: tool receipt digests — bundled repeat disjunct removed",
    `${INT} a bundle carrying one tool receipt twice is rejected`,
    edit("      bundledSet.size !== bundled.length ||\n", ""),
  ),
  entry(
    "integrity: tool receipt digests — recorded repeat disjunct removed",
    `${INT} a record listing one tool receipt digest twice is rejected`,
    edit("      recordedSet.size !== recorded.length ||\n", ""),
  ),
  entry(
    "integrity: task_id check removed",
    `${INT} a tool receipt from another run is rejected`,
    off("    if (tr.task_id !== receipt.task_id) {"),
  ),
  entry(
    "integrity: mode shape failures ignored",
    `${INT} a failed ancestry or shape check lands on integrity and every other axis is still computed`,
    edit(
      "  for (const shape of mode.shapeFailures) fail(",
      "  for (const shape of [] as string[]) fail(",
    ),
  ),
  entry(
    "integrity: verdict integrity axis ignores failures",
    `${INT} B5a: a tick signature re-spelled in non-canonical base64url, with the record re-signed over it, fails on canonicality alone`,
    edit(
      '    integrity: on("integrity").length > 0 ? "invalid" : "verified",',
      '    integrity: "verified",',
    ),
  ),

  // ── identityBinding ────────────────────────────────────────────────────
  entry(
    "identity: absent principal pin passes",
    `${IDB} no principal pin: the delegator is not the principal`,
    edit(
      "    principal === null ||\n    grant.delegator_id !== principal.motebit_id ||\n    grant.delegator_public_key !== principal.public_key\n",
      "    principal !== null &&\n    (grant.delegator_id !== principal.motebit_id ||\n      grant.delegator_public_key !== principal.public_key)\n",
    ),
  ),
  entry(
    "identity: principal pin key not compared",
    `${IDB} a principal pin with the same id but another key does not pin the delegator`,
    edit(
      "    grant.delegator_id !== principal.motebit_id ||\n    grant.delegator_public_key !== principal.public_key\n",
      "    grant.delegator_id !== principal.motebit_id\n",
    ),
  ),
  entry(
    "identity: principal pin id not compared",
    `${IDB} a principal pin with the same key but another id does not pin the delegator`,
    edit("    grant.delegator_id !== principal.motebit_id ||\n", ""),
  ),
  entry(
    "identity: agent pin key not compared",
    `${IDB} an agent pin with the same id but another key does not pin the delegate`,
    edit(
      "a.motebit_id === grant.delegate_id && a.public_key === grant.delegate_public_key",
      "a.motebit_id === grant.delegate_id",
    ),
  ),
  entry(
    "identity: agent pin id not compared",
    `${IDB} an agent pin with the same key but another id does not pin the delegate`,
    edit(
      "a.motebit_id === grant.delegate_id && a.public_key === grant.delegate_public_key",
      "a.public_key === grant.delegate_public_key",
    ),
  ),
  entry(
    "identity: delegator = delegate by id not checked",
    `${IDB} a grant whose delegate id is the delegator's is rejected`,
    edit("    grant.delegator_id === grant.delegate_id ||\n", ""),
  ),
  entry(
    "identity: delegator = delegate by key not checked",
    `${IDB} a grant whose delegate key is the delegator's is rejected`,
    edit(
      "    grant.delegator_id === grant.delegate_id ||\n    grant.delegator_public_key === grant.delegate_public_key\n",
      "    grant.delegator_id === grant.delegate_id\n",
    ),
  ),
  entry(
    "identity: tick delegate check removed",
    `${IDB} a tick naming another delegate is rejected`,
    off("  if (!isDelegate(tick.delegate_id, tick.delegate_public_key)) {"),
  ),
  entry(
    "identity: execution receipt signer check removed (B4)",
    `${IDB} B4: an execution receipt signed by a key other than the grant's delegate is rejected`,
    off("  if (!isDelegate(receipt.motebit_id, receipt.public_key)) {"),
  ),
  entry(
    "identity: signer key not compared",
    `${IDB} B4: an execution receipt signed by a key other than the grant's delegate is rejected`,
    edit(
      "    id === grant.delegate_id && key === grant.delegate_public_key;",
      "    id === grant.delegate_id && key.length > 0;",
    ),
  ),
  entry(
    "identity: signer id not compared",
    `${IDB} an execution receipt naming another motebit_id is rejected`,
    edit(
      "    id === grant.delegate_id && key === grant.delegate_public_key;",
      "    id.length > 0 && key === grant.delegate_public_key;",
    ),
  ),
  entry(
    "identity: tool receipt signer check removed",
    `${IDB} a tool receipt signed by a key other than the grant's delegate is rejected`,
    off("    if (!isDelegate(tr.motebit_id, tr.public_key)) {"),
  ),
  entry(
    "identity: verdict identityBinding axis ignores failures",
    `${IDB} no principal pin: the delegator is not the principal`,
    edit('      : on("identityBinding").length > 0', "      : (false as boolean)"),
  ),

  // ── authority ──────────────────────────────────────────────────────────
  entry(
    "authority: tick expiry not mapped",
    `${AUT} a tick past its expiry reads expired`,
    off('  } else if (wallClock.authority === "expired" || now > grant.expires_at) {'),
  ),
  entry(
    "authority: grant expiry not read as the tick's expiry",
    `${AUT} a time after the grant expired reads the tick as expired`,
    edit(
      '  } else if (wallClock.authority === "expired" || now > grant.expires_at) {',
      '  } else if (wallClock.authority === "expired") {',
    ),
  ),
  entry(
    "authority: tick activation not mapped",
    `${AUT} a tick before its not_before reads not_yet_valid`,
    off("  } else if (now < tickStart) {"),
  ),
  entry(
    "authority: tick insufficiency not mapped",
    `${AUT} a tick whose TTL exceeds the grant's max_token_ttl_ms is insufficient`,
    off("  if (tick.expires_at - tick.issued_at > grant.max_token_ttl_ms) {"),
  ),
  entry(
    "authority: unavailable time not reported",
    `${AUT} a landed change whose time could not be accepted reads unknown`,
    edit(
      '    fail("authority.repo_change.time_unavailable", "the evaluation time could not be accepted");\n',
      "",
    ),
  ),
  entry(
    "authority: tick not judged structurally when time is unavailable",
    `${AUT} with no acceptable time, a structurally invalid tick still reads insufficient`,
    off("  if (tick.expires_at - tick.issued_at > grant.max_token_ttl_ms) {"),
  ),
  ...(
    [
      [
        "a TTL over max_token_ttl_ms",
        off("  if (tick.expires_at - tick.issued_at > grant.max_token_ttl_ms) {"),
      ],
      ["a grant_id of another grant", off("  if (tick.grant_id !== grant.grant_id) {")],
      [
        "a delegator other than the grant's",
        edit(
          "    tick.delegator_id !== grant.delegator_id ||\n    tick.delegator_public_key !== grant.delegator_public_key\n",
          "    (false as boolean)\n",
        ),
      ],
      ["a scope wider than the grant's", off("  if (!isScopeNarrowed(grant.scope, tick.scope)) {")],
    ] as const
  ).flatMap(([breach, cut]) =>
    ["before the grant starts", "before the tick starts"].map((timing) =>
      entry(
        `authority: structural tick sub-check removed (${breach}, ${timing})`,
        `${AUT} a structural tick failure outranks a time before the window ${breach}, evaluated ${timing}, reads insufficient`,
        cut,
      ),
    ),
  ),
  entry(
    "authority: tick delegator id not compared with the grant's",
    `${AUT} a structural tick failure outranks a time before the window a delegator other than the grant's, evaluated before the grant starts, reads insufficient`,
    edit(
      "    tick.delegator_id !== grant.delegator_id ||\n    tick.delegator_public_key !== grant.delegator_public_key\n",
      "    tick.delegator_public_key !== grant.delegator_public_key\n",
    ),
  ),
  entry(
    "authority: tick delegator key not compared with the grant's",
    `${AUT} a tick under another delegator key (signed by that key) is not a tick of the grant`,
    edit(
      "    tick.delegator_id !== grant.delegator_id ||\n    tick.delegator_public_key !== grant.delegator_public_key\n",
      "    tick.delegator_id !== grant.delegator_id\n",
    ),
  ),
  entry(
    "authority: tick delegate id not compared with the grant's",
    `${IDB} a tick naming another delegate is not a tick of the grant`,
    edit(
      "    tick.delegate_id !== grant.delegate_id ||\n    tick.delegate_public_key !== grant.delegate_public_key\n",
      "    tick.delegate_public_key !== grant.delegate_public_key\n",
    ),
  ),
  entry(
    "authority: tick delegate key not compared with the grant's",
    `${AUT} a tick naming another delegate key is not a tick of the grant`,
    edit(
      "    tick.delegate_id !== grant.delegate_id ||\n    tick.delegate_public_key !== grant.delegate_public_key\n",
      "    tick.delegate_id !== grant.delegate_id\n",
    ),
  ),
  entry(
    "authority: in-window fallback for a grant that does not verify removed",
    `${INT} a grant whose signature does not verify confers no authority either`,
    edit(
      '    wallClock.authority !== "valid" &&\n',
      '    (false as boolean) &&\n    wallClock.authority !== "valid" &&\n',
    ),
  ),
  entry(
    "authority: in-window fallback reports a structural fault twice",
    `${IDB} a tick naming another delegate is not a tick of the grant`,
    edit(
      '    !failures.some((f) => f.code === "authority.repo_change.tick_insufficient")\n',
      "    (true as boolean)\n",
    ),
  ),
  entry(
    "authority: tick outliving its grant not checked",
    `${AUT} a tick that outlives its grant is insufficient`,
    off("  if (tick.expires_at > grant.expires_at) {"),
  ),
  entry(
    "authority: absent subject_binding not reported",
    `${AUT} a grant with no subject_binding is insufficient`,
    edit(
      '    fail("authority.repo_change.subject_binding_absent", "the grant has no subject_binding");\n',
      "",
    ),
  ),
  entry(
    "authority: subject_binding schema not checked",
    `${AUT} a subject_binding of another artifact schema is insufficient`,
    off("  } else if (grant.subject_binding.artifact_schema !== REPO_TASK_SCOPE_SCHEMA) {"),
  ),
  entry(
    "authority: grant subject not checked",
    `${AUT} a grant with another subject is insufficient`,
    off("  if (grant.subject !== REPO_CHANGE_SUBJECT) {"),
  ),
  entry(
    "authority: grant scope tools not checked",
    `${AUT} a grant scope naming a tool outside the two is insufficient`,
    off("  if (strictTools(grant.scope) === null) {"),
  ),
  entry(
    "authority: wildcard grant scope accepted",
    `${AUT} a wildcard grant scope is insufficient`,
    off("  if (strictTools(grant.scope) === null) {"),
  ),
  entry(
    "authority: a repeated tool accepted in a capability list",
    `${AUT} a grant scope naming a tool twice is insufficient`,
    edit(
      "    if (tool === undefined || out.has(tool)) return null;",
      "    if (tool === undefined) return null;",
    ),
  ),
  entry(
    "authority: tick scope spelling not checked",
    `${AUT} a tick scope not in its one spelling is insufficient`,
    off("  if (tickTools === null) {"),
  ),
  entry(
    "authority: grant lifetime not checked",
    `${AUT} a grant living longer than 24 hours is insufficient`,
    off("  if (lifetime > REPO_CHANGE_MAX_GRANT_LIFETIME_MS) {"),
  ),
  entry(
    "authority: spend_ceiling not checked",
    `${AUT} a grant with a spend_ceiling is insufficient`,
    off("  if (grant.spend_ceiling !== undefined) {"),
  ),
  entry(
    "authority: cadence not checked",
    `${AUT} a grant whose cadence_ms is below its lifetime is insufficient`,
    off("  if (grant.cadence_ms < lifetime) {"),
  ),
  entry(
    "authority: expected repository not checked",
    `${AUT} a scope for another repository is insufficient`,
    off("  if (scope.repo !== input.expectedRepo) {"),
  ),
  entry(
    "authority: spent grant not checked (B5b)",
    `${AUT} B5b: a grant whose bundle already landed is spent`,
    off("  if (spent) {"),
  ),
  entry(
    "authority: absent delegated_scope accepted",
    `${AUT} a receipt with no delegated_scope is insufficient`,
    edit(
      "  if (delegated === null || [...delegated].some((t) => !authorized.has(t))) {",
      "  if (delegated !== null && [...delegated].some((t) => !authorized.has(t))) {",
    ),
  ),
  entry(
    "authority: delegated_scope wider than the tick accepted",
    `${AUT} a delegated_scope wider than the tick's is insufficient`,
    edit(
      "  if (delegated === null || [...delegated].some((t) => !authorized.has(t))) {",
      "  if (delegated === null) {",
    ),
  ),
  entry(
    "authority: tools_used scope not checked",
    `${AUT} tools_used naming a tool outside the tick's scope is insufficient`,
    off("    if (!authorized.has(t))\n      fail("),
  ),
  entry(
    "authority: tool receipt scope not checked",
    `${AUT} a completed tool receipt naming a tool outside the tick's scope is insufficient`,
    off("    if (!authorized.has(tr.tool_name)) {"),
  ),
  entry(
    "authority: denied receipts judged like the rest",
    `${POS} a truthful denied run keeps valid authority: a denied receipt may name any tool`,
    edit(
      '    if (tr.status === "denied") return;',
      '    if ((false as boolean) && tr.status === "denied") return;',
    ),
  ),
  entry(
    "authority: tools_used size disjunct removed",
    `${AUT} tools_used missing a tool a receipt that is not denied names is insufficient`,
    edit(
      "  if (usedSet.size !== notDeniedNames.size || [...usedSet].some((t) => !notDeniedNames.has(t))) {",
      "  if ([...usedSet].some((t) => !notDeniedNames.has(t))) {",
    ),
  ),
  entry(
    "authority: tools_used membership disjunct removed",
    `${AUT} tools_used naming a tool only a denied receipt names is insufficient`,
    edit(
      "  if (usedSet.size !== notDeniedNames.size || [...usedSet].some((t) => !notDeniedNames.has(t))) {",
      "  if (usedSet.size !== notDeniedNames.size) {",
    ),
  ),
  entry(
    "authority: memories_formed not checked",
    `${AUT} a run that formed a memory is insufficient`,
    off("  if (receipt.memories_formed !== 0) {"),
  ),
  entry(
    "authority: allowed paths not checked against the predicate",
    `${AUT} an allowed path the predicate refuses is insufficient`,
    off("    if (!input.isPathPermitted(p)) {"),
  ),
  entry(
    "authority: deletion accepted",
    `${ENT} a deletion is outside the scope`,
    edit(
      '      fail("authority.repo_change.entry_not_add_or_modify", `${label} is deleted`);\n',
      "",
    ),
  ),
  entry(
    "authority: symlink not distinguished",
    `${ENT} a symlink is outside the scope`,
    off("      if (e.mode === SYMLINK_MODE) {"),
  ),
  entry(
    "authority: submodule not distinguished",
    `${ENT} a submodule is outside the scope`,
    off("      } else if (e.mode === GITLINK_MODE) {"),
  ),
  entry(
    "authority: non-100644 mode accepted",
    `${ENT} an executable file is outside the scope`,
    off("      } else if (e.mode !== REGULAR_FILE_MODE) {"),
  ),
  entry(
    "authority: mode change accepted",
    `${ENT} a mode change is outside the scope`,
    off('      if (e.kind === "modify" && e.previousMode !== e.mode) {'),
  ),
  entry(
    "authority: NUL content accepted",
    `${ENT} content with a NUL byte is outside the scope`,
    off("    if (e.containsNul)"),
  ),
  entry(
    "authority: case collision not reported",
    `${ENT} a path that collides by case with a tracked directory is outside the scope`,
    off("    if (collision !== null)"),
  ),
  entry(
    "authority: case collision ignores directory prefixes",
    `${ENT} a path that collides by case with a tracked directory is outside the scope`,
    edit(
      '  for (let k = 1; k <= parts.length; k++) {\n    const q = parts.slice(0, k).join("/");\n    for (const other',
      '  for (let k = parts.length; k <= parts.length; k++) {\n    const q = parts.slice(0, k).join("/");\n    for (const other',
    ),
  ),
  entry(
    "authority: case fold is plain lowercasing (long s)",
    `${ENT} a path a Unicode case fold aliases (long s, U+017F) is outside the scope`,
    edit(
      '  return s.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");',
      "  return s.toLowerCase();",
    ),
  ),
  entry(
    "authority: path not compared with allowed_paths",
    `${ENT} a path not byte-equal to an allowed path is outside the scope`,
    off("    if (!allowedBytes.some((a) => bytesEqual(a, e.path))) {"),
  ),
  entry(
    "authority: predicate not applied to entries",
    `${ENT} an allowed path the predicate refuses is outside the scope`,
    edit("    if (p === null || !input.isPathPermitted(p)) {", "    if (p === null) {"),
  ),
  entry(
    "authority: undecodable path passes the predicate",
    `${ENT} a path whose bytes are not UTF-8 is outside the scope`,
    edit(
      "    if (p === null || !input.isPathPermitted(p)) {",
      "    if (p !== null && !input.isPathPermitted(p)) {",
    ),
  ),
  entry(
    "authority: max_changed_files not checked",
    `${ENT} more entries than max_changed_files is outside the scope`,
    off("  if (input.entries.length > scope.max_changed_files) {"),
  ),
  entry(
    "authority: recorded blob not compared",
    `${ENT} recorded entries that differ from the computed ones are insufficient`,
    edit(
      "        r.mode !== computed[i]!.mode ||\n        r.blob !== computed[i]!.blob,",
      "        r.mode !== computed[i]!.mode,",
    ),
  ),
  entry(
    "authority: recorded entry count not compared",
    `${ENT} a computed entry the record omits is insufficient`,
    edit("    record.entries.length !== computed.length ||\n", ""),
  ),
  entry(
    "authority: undecodable computed entries ignored in the comparison",
    `${ENT} a path whose bytes are not UTF-8 is outside the scope`,
    edit("    !computedDecodable ||\n", ""),
  ),
  entry(
    "authority: missing record treated as matching entries",
    `${INT} with no parseable record, the recorded entries cannot match the computed ones`,
    edit(
      "    record === null ||\n    !computedDecodable ||",
      "    record === null ? false : !computedDecodable ||",
    ),
  ),
  entry(
    "authority: verdict authority ignores structural failures",
    `${AUT} B5b: a grant whose bundle already landed is spent`,
    edit(
      '  else if (authorityFailures.some((f) => !TEMPORAL_AUTHORITY_CODES.has(f.code)))\n    authority = "insufficient";\n',
      "",
    ),
  ),
  entry(
    "authority: verdict authority ignores unavailable time",
    `${AUT} a landed change whose time could not be accepted reads unknown`,
    edit(
      '  else if (codes.has("authority.repo_change.time_unavailable")) authority = "unknown";\n',
      "",
    ),
  ),
  entry(
    "authority: verdict authority ignores expiry",
    `${AUT} a tick past its expiry reads expired`,
    edit(
      '  else if (codes.has("authority.repo_change.tick_expired")) authority = "expired";\n',
      "",
    ),
  ),
  entry(
    "authority: verdict authority ignores activation",
    `${AUT} a tick before its not_before reads not_yet_valid`,
    edit(
      '    codes.has("authority.repo_change.grant_not_yet_valid") ||\n    codes.has("authority.repo_change.tick_not_yet_valid")\n',
      '    codes.has("authority.repo_change.grant_not_yet_valid")\n',
    ),
  ),

  ...(
    [
      ["pull_request now = NaN reads unknown"],
      ["pull_request now = Infinity reads unknown"],
      ["pull_request now = -Infinity reads unknown"],
      ["landed landedAt = NaN reads unknown"],
      ["landed landedAt = Infinity reads unknown"],
      ["landed landedAt = -Infinity reads unknown"],
      ["a landed mode with no landedAt (a JS caller) reads unknown, never the local clock"],
    ] as const
  ).map(([title]) =>
    entry(
      `authority: non-finite evaluation time accepted (${title})`,
      `${AUT} an evaluation time that is not a finite number is no time at all ${title}`,
      edit(
        '  const now = typeof rawNow === "number" && Number.isFinite(rawNow) ? rawNow : null;',
        "  const now = rawNow === null ? null : (rawNow as number);",
      ),
    ),
  ),
  entry(
    "authority: grant activation not checked against the evaluation time",
    `${AUT} a grant issued in the future reads not_yet_valid at the evaluation time`,
    off("  } else if (now < grantStart) {"),
  ),
  entry(
    "authority: verdict authority ignores grant activation",
    `${AUT} a grant issued in the future reads not_yet_valid at the evaluation time`,
    edit(
      '    codes.has("authority.repo_change.grant_not_yet_valid") ||\n    codes.has("authority.repo_change.tick_not_yet_valid")\n',
      '    codes.has("authority.repo_change.tick_not_yet_valid")\n',
    ),
  ),
  entry(
    "authority: tick issued_at not checked against the evaluation time",
    `${AUT} a tick issued in the future (no not_before) reads not_yet_valid`,
    edit(
      "  const tickStart = Math.max(tick.issued_at, tick.not_before ?? tick.issued_at);",
      "  const tickStart = tick.not_before ?? Number.NEGATIVE_INFINITY;",
    ),
  ),
  entry(
    "authority: grant issued_at not checked against the evaluation time",
    `${AUT} a grant issued in the future reads not_yet_valid at the evaluation time`,
    edit(
      "  const grantStart = Math.max(grant.issued_at, grant.not_before ?? grant.issued_at);",
      "  const grantStart = grant.not_before ?? Number.NEGATIVE_INFINITY;",
    ),
  ),
  entry(
    "authority: back-dated tick accepted",
    `${AUT} a tick back-dated before its grant is insufficient`,
    off("  if (tick.issued_at < grant.issued_at) {"),
  ),
  entry(
    "authority: inverted grant window accepted",
    `${AUT} a grant that starts after it expires is insufficient`,
    off("  if (grantStart > grant.expires_at) {"),
  ),
  entry(
    "authority: inverted tick window accepted",
    `${AUT} a tick that starts after it expires is insufficient`,
    off("  if (tickStart > tick.expires_at) {"),
  ),
  entry(
    "authority: lifetime counted from issued_at, not activation",
    `${AUT} the grant lifetime counts from its activation (not_before)`,
    edit(
      "  const lifetime = grant.expires_at - grantStart;",
      "  const lifetime = grant.expires_at - grant.issued_at;",
    ),
  ),
  entry(
    "authority: undecodable tracked path dropped silently",
    `${ENT} a tracked path that is not UTF-8 fails the case-collision rule closed`,
    edit(
      '      fail(\n        "authority.repo_change.entry_case_collision",\n        "a tracked path is not valid UTF-8, so no case collision can be ruled out",\n      );\n',
      "",
    ),
  ),

  // ── revocation ─────────────────────────────────────────────────────────
  entry(
    "revocation: absent set not reported",
    `${REV} no revocation set reads unchecked, never fresh`,
    edit('    fail("revocation.repo_change.unchecked", "no revocation set was supplied");\n', ""),
  ),
  entry(
    "revocation: caller's parse failures ignored",
    `${REV} a file that failed the caller's strict parse makes revocation unchecked`,
    edit("  let malformed = revs.failures.length > 0;", "  let malformed = false as boolean;"),
  ),
  entry(
    "revocation: caller's parse failures not reported",
    `${REV} a file that failed the caller's strict parse makes revocation unchecked`,
    edit("  for (const f of revs.failures) fail(", "  for (const f of [] as string[]) fail("),
  ),
  entry(
    "revocation: strict shape not re-checked",
    `${REV} a revocation with a key the spec does not name makes revocation unchecked`,
    edit("      isRevocationShape(r) &&\n", ""),
  ),
  entry(
    "revocation: grant_id UUID not re-checked",
    `${REV} a revocation whose grant_id is not a lowercase UUID makes revocation unchecked`,
    edit("      CANONICAL_UUID.test(r.grant_id) &&\n", ""),
  ),
  entry(
    "revocation: canonical signature not re-checked",
    `${REV} a revocation with a re-spelled signature makes revocation unchecked`,
    edit("      isCanonicalBase64Url(r.signature) &&\n", ""),
  ),
  entry(
    "revocation: signature not re-checked",
    `${REV} a revocation whose signature does not verify makes revocation unchecked`,
    edit(
      "      isCanonicalBase64Url(r.signature) &&\n      (await verifyDelegationRevocation(r));",
      "      isCanonicalBase64Url(r.signature);",
    ),
  ),
  entry(
    "revocation: binding revocation not reported (B6)",
    `${REV} B6: a revocation of the grant by its delegator reads revoked`,
    off("    if (binding !== null) {"),
  ),
  entry(
    "revocation: malformed outranks revoked",
    `${REV} revoked wins over a malformed file`,
    edit("    if (binding !== null) {", "    if (binding !== null && !malformed) {"),
  ),
];

void runTampers(TAMPERS, { root: ROOT });
