/**
 * Governed repo change — the verifier core (spec/repo-change-v1.md; design of
 * record docs/proposals/governed-repo-change-v1.md § "The verifier").
 *
 * A PURE function: no git, no file I/O, no repository policy. The caller (the
 * `motebit-verify repo-change` kind or the CI script) computes every input that
 * needs git or the filesystem — the entries from two full trees, the tracked
 * paths at the landing parent, the role-typed pins, the path predicate (from
 * data, never repository code), the strictly parsed revocations, the spent
 * status, and the mode's ancestry and shape checks — and this function judges
 * them. Crypto is reused, never re-implemented: `verifyDelegationTokenVerdict`,
 * `verifyStandingDelegation`, `verifySubjectBinding`, `findGrantRevocation`,
 * `verifyDelegationRevocation`, `verifyExecutionReceipt`,
 * `verifyToolInvocationReceipt`.
 *
 * Every failure lands on one of the verdict's four axes with a repo-change
 * repair code, so `isFullyVerified(verdict)` is false whenever any rule
 * failed. The receipt's `status` is reported separately as `outcome`: a
 * truthful `denied` or `failed` run has valid authority.
 */

import {
  canonicalJson,
  canonicalSha256,
  findGrantRevocation,
  hash,
  hexToBytes,
  subjectBindingDigest,
  verifyDelegation,
  verifyDelegationRevocation,
  verifyDelegationTokenVerdict,
  verifyExecutionReceipt,
  verifyStandingDelegation,
  verifySubjectBinding,
  verifyToolInvocationReceipt,
} from "@motebit/crypto";
import type {
  DelegationRevocation,
  EvidenceRef,
  RepairInstruction,
  RevocationFreshness,
  RevocationVerdict,
  VerificationVerdict,
} from "@motebit/crypto";
import {
  ALL_GIT_OBJECT_FORMATS,
  GIT_OBJECT_ID_HEX_LENGTH,
  REPO_CHANGE_BUNDLE_SPEC_ID,
  REPO_CHANGE_MAX_TOOL_RECEIPTS,
  REPO_CHANGE_SPEC_ID,
  REPO_CHANGE_SUBJECT,
  REPO_TASK_SCOPE_SCHEMA,
} from "@motebit/protocol";
import {
  checkRepoChangeGrantShape,
  checkRepoChangeParties,
  checkRepoChangeTickStructure,
  checkRepoChangeWindow,
  hasExactKeys,
  caseCollision,
  caseIndex,
  isCanonicalBase64Url,
  isCanonicalRepoPath as isCanonicalPath,
  isNonEmptyString,
  isNumber,
  isObject,
  isRepoChangeGrantShape as isGrantShape,
  isRepoChangeTickShape as isTickShape,
  isRepoTaskScopeShape as isScopeShape,
  isString,
  parseRepoChangeTools as strictTools,
} from "./repo-change-rules.js";
import type { RepoChangePin, RepoChangePins } from "./repo-change-rules.js";
import type {
  RepoChangeBundle,
  RepoChangeEntry,
  RepoChangeExecutionReceipt,
  RepoChangeRepairCode,
  RepoChangeResult,
  RepoChangeToolInvocationReceipt,
} from "@motebit/protocol";

export type { RepoChangePin, RepoChangePins };

// ===========================================================================
// Inputs and result
// ===========================================================================

/**
 * One path that differs between the parent's tree and the change commit's
 * tree, computed by listing both trees completely. A rename appears as a
 * `delete` plus an `add`.
 */
export interface RepoChangeComputedEntry {
  readonly kind: "add" | "modify" | "delete";
  /** Git's own path bytes. */
  readonly path: Uint8Array;
  /** Mode after the change (for a `delete`, the mode it had), six octal digits. */
  readonly mode: string;
  /** Mode at the parent; present for `modify` and `delete`. */
  readonly previousMode?: string;
  /** Blob id after the change (for a `delete`, the blob it had). */
  readonly blob: string;
  /** The blob's content contains a NUL byte. */
  readonly containsNul: boolean;
}

/**
 * The revocations under `.motebit/revocations/` at the judged commit, parsed
 * strictly by the caller. `failures` names every file that failed the strict
 * parse (file name ≠ `grant_id`, non-canonical key or base64url, bad
 * signature); any failure makes `revocation` `unchecked`, never `fresh`.
 */
export interface RepoChangeRevocationSet {
  readonly set: readonly DelegationRevocation[];
  readonly failures: readonly string[];
  readonly freshness: RevocationFreshness;
  /** The commit the set was read at, echoed into `diagnostics` (`RevocationFreshness.asOf` has no commit field). */
  readonly readAt?: string;
}

/**
 * The mode the change is judged in, with its ancestry and shape check results
 * (each failure folds into `integrity`) and its evaluation time.
 */
export type RepoChangeMode =
  | {
      /** CI on a pull request: the runner's clock (`local_clock`). */
      readonly kind: "pull_request";
      readonly shapeFailures: readonly string[];
      readonly now: number;
    }
  | {
      /**
       * Offline on a landed change: the squash commit's committer time
       * (`operator_recorded`), or `null` when it could not be accepted (the
       * committer is not GitHub, or the signature does not verify under the
       * pinned GitHub keys) — then `authority` is `unknown`.
       */
      readonly kind: "landed";
      readonly shapeFailures: readonly string[];
      readonly landedAt: number | null;
    };

export interface VerifyRepoChangeInput {
  /** The exact bytes of `.motebit/bundles/<grant_id>.json`. */
  readonly bundle: Uint8Array;
  /** Every path the change commit's tree differs from its parent's in. */
  readonly entries: readonly RepoChangeComputedEntry[];
  /** Every path tracked at the parent the change lands on. */
  readonly trackedPaths: readonly Uint8Array[];
  /** The role-typed pins at the judged commit. */
  readonly pins: RepoChangePins;
  /**
   * The repository's path predicate, interpreted from data at the judged
   * commit. Pure; a throw propagates (a caller fault, never a verdict).
   */
  readonly isPathPermitted: (path: string) => boolean;
  /** Absent means no revocation set was supplied: `revocation` is `unchecked`. */
  readonly revocations?: RepoChangeRevocationSet;
  /** The grant's bundle path ever existed on the first-parent history being judged. */
  readonly spent: boolean;
  /** The repository being judged; the scope's `repo` must equal it byte for byte. */
  readonly expectedRepo: string;
  /** The judging mode, its ancestry/shape check results and its evaluation time. */
  readonly mode: RepoChangeMode;
}

/** One failed rule. */
export interface RepoChangeFailure {
  readonly code: RepoChangeRepairCode;
  readonly axis: RepairInstruction["axis"];
  readonly detail: string;
}

export interface RepoChangeDiagnostics {
  /** Every failed rule, axis order (integrity, identityBinding, authority, revocation). */
  readonly failures: readonly RepoChangeFailure[];
  /** The commit the revocation set was read at, when the caller supplied it. */
  readonly revocationsReadAt?: string;
}

export interface RepoChangeVerification {
  /** `type: "repo_change"`. Fully verified only when no rule failed. */
  readonly verdict: VerificationVerdict;
  /** The receipt's `status`; `null` when the bundle could not be parsed. */
  readonly outcome: "completed" | "failed" | "denied" | null;
  readonly diagnostics: RepoChangeDiagnostics;
}

// ===========================================================================
// Repair texts
// ===========================================================================

const SPEC = "spec/repo-change-v1.md";

const REPAIR: Readonly<Record<RepoChangeRepairCode, { summary: string; fix: string }>> = {
  "integrity.repo_change.bundle_malformed": {
    summary: "The bundle is not UTF-8 JSON of the strict bundle shape.",
    fix: "Rebuild the bundle from its artifacts with exactly the keys the spec names.",
  },
  "integrity.repo_change.bundle_not_canonical": {
    summary: "The bundle bytes are not the canonical JSON of the bundle.",
    fix: "Write the bundle as canonical JSON (RFC 8785), with no other bytes.",
  },
  "integrity.repo_change.value_not_canonical": {
    summary:
      "A key, digest, signature, id, object id, mode or path is not in its one canonical spelling.",
    fix: "Re-issue the artifact with every value canonical; never re-spell a signed value.",
  },
  "integrity.repo_change.signature_invalid": {
    summary: "A signature in the bundle does not verify.",
    fix: "The bundle was tampered with or signed by another key; do not trust it.",
  },
  "integrity.repo_change.result_hash_mismatch": {
    summary: "The receipt's result_hash is not hex SHA-256 of its result.",
    fix: "Reject the receipt; the digest does not bind the change record.",
  },
  "integrity.repo_change.result_malformed": {
    summary: "The receipt's result is not JSON of the strict change-record shape.",
    fix: "The run must sign the change record as the receipt's result for every status.",
  },
  "integrity.repo_change.result_not_canonical": {
    summary: "The receipt's result is not the canonical JSON of the change record.",
    fix: "Sign the change record as canonical JSON (RFC 8785).",
  },
  "integrity.repo_change.scope_binding_mismatch": {
    summary: "The bundle's scope does not match the grant's subject_binding.",
    fix: "Bundle the exact scope the principal bound into the grant.",
  },
  "integrity.repo_change.grant_id_mismatch": {
    summary: "The change record names a different grant than the bundle carries.",
    fix: "Bundle the grant the run acted under.",
  },
  "integrity.repo_change.grant_digest_mismatch": {
    summary: "The change record's grant_digest is not the digest of the bundle's grant.",
    fix: "Bundle the grant the run acted under, byte for byte.",
  },
  "integrity.repo_change.tick_digest_mismatch": {
    summary: "The change record's tick_digest is not the digest of the bundle's tick.",
    fix: "Bundle the tick the run acted under, byte for byte.",
  },
  "integrity.repo_change.scope_digest_mismatch": {
    summary: "The change record's scope_digest is not the digest of the bundle's scope.",
    fix: "Bundle the scope the run acted under, byte for byte.",
  },
  "integrity.repo_change.scope_reference_mismatch": {
    summary: "The change record's repo or object_format differs from the scope's.",
    fix: "The record must restate the scope's repo and object_format.",
  },
  "integrity.repo_change.prompt_hash_mismatch": {
    summary: "The receipt's prompt_hash is not hex SHA-256 of the scope's task.",
    fix: "The run must start from the scope's task and record its digest.",
  },
  "integrity.repo_change.tool_receipts_mismatch": {
    summary: "The record's tool_receipt_digests differ, as a set, from the bundle's tool receipts.",
    fix: "Bundle every tool receipt of the run exactly once and record each digest exactly once.",
  },
  "integrity.repo_change.task_id_mismatch": {
    summary: "A tool receipt's task_id differs from the run's.",
    fix: "Bundle only the tool receipts of this run.",
  },
  "integrity.repo_change.shape_check_failed": {
    summary: "The mode's ancestry or shape check failed.",
    fix: "Land the change as the spec's mode table requires (see diagnostics for the failed check).",
  },
  "identity.repo_change.delegator_not_principal": {
    summary: "The grant's delegator is not the pinned principal.",
    fix: "The grant must be signed by the (motebit_id, public_key) in the principal pin at the judged commit.",
  },
  "identity.repo_change.delegate_not_agent": {
    summary: "The grant's delegate is not a pinned agent.",
    fix: "Delegate to a (motebit_id, public_key) pinned under .motebit/principals/agents/ at the judged commit.",
  },
  "identity.repo_change.delegator_is_delegate": {
    summary: "The grant's delegator and delegate are the same identity or key.",
    fix: "The principal delegates to a distinct agent identity.",
  },
  "identity.repo_change.signer_not_delegate": {
    summary: "A receipt's signer, or the tick's delegate, is not the grant's delegate.",
    fix: "Every receipt is signed by the grant's delegate, and the tick names that delegate.",
  },
  "authority.repo_change.tick_expired": {
    summary: "The tick had expired at the evaluation time.",
    fix: "Land the change before the tick expires, under a fresh grant and tick.",
  },
  "authority.repo_change.tick_not_yet_valid": {
    summary: "The tick was not yet valid at the evaluation time.",
    fix: "Do not land the change before the tick's not_before.",
  },
  "authority.repo_change.tick_insufficient": {
    summary: "The tick is not a valid tick of the grant (parties, scope, TTL, grant validity).",
    fix: "Mint the tick under the grant, within its scope and max_token_ttl_ms, while the grant is valid.",
  },
  "authority.repo_change.tick_outlives_grant": {
    summary: "The tick's expires_at is later than the grant's.",
    fix: "Mint the tick with expires_at no later than the grant's.",
  },
  "authority.repo_change.grant_not_yet_valid": {
    summary: "The grant was not yet active (issued_at or not_before) at the evaluation time.",
    fix: "Do not land the change before the grant's issued_at and not_before.",
  },
  "authority.repo_change.window_inverted": {
    summary: "The grant or the tick starts (issued_at / not_before) after it expires.",
    fix: "Issue the grant and tick with a start no later than expires_at.",
  },
  "authority.repo_change.tick_predates_grant": {
    summary: "The tick was issued before the grant it claims to be a tick of.",
    fix: "Issue the tick at or after the grant's issued_at.",
  },
  "authority.repo_change.time_unavailable": {
    summary: "The evaluation time could not be accepted, so the tick's window cannot be judged.",
    fix: "Supply a landing time signed by GitHub under a pinned GitHub signing key.",
  },
  "authority.repo_change.subject_binding_absent": {
    summary: "The grant carries no subject_binding, so no principal-signed scope is bound.",
    fix: "Bind the scope into the grant with subject_binding.",
  },
  "authority.repo_change.subject_binding_wrong_schema": {
    summary: "The grant's subject_binding binds an artifact other than a repo-task scope.",
    fix: `Bind the scope with artifact_schema "${REPO_TASK_SCOPE_SCHEMA}".`,
  },
  "authority.repo_change.subject_wrong": {
    summary: `The grant's subject is not "${REPO_CHANGE_SUBJECT}".`,
    fix: `Issue the grant with subject "${REPO_CHANGE_SUBJECT}".`,
  },
  "authority.repo_change.scope_tools_outside": {
    summary:
      "The grant's or tick's scope names a capability outside repo_read_blob, repo_write_path.",
    fix: "Scope the grant and tick to repo_read_blob and repo_write_path only, comma-separated, no spaces.",
  },
  "authority.repo_change.lifetime_exceeded": {
    summary: "The grant lives longer than 24 hours.",
    fix: "Issue the grant with expires_at - issued_at at most 86400000 ms.",
  },
  "authority.repo_change.spend_ceiling_present": {
    summary: "The grant carries a spend_ceiling; a repo-change grant moves no money.",
    fix: "Issue the grant without a spend_ceiling.",
  },
  "authority.repo_change.cadence_below_lifetime": {
    summary:
      "The grant's cadence_ms is less than its lifetime, so it could back more than one tick.",
    fix: "Issue the grant with cadence_ms equal to its lifetime.",
  },
  "authority.repo_change.repo_mismatch": {
    summary: "The scope names a repository other than the one being judged.",
    fix: "Issue a scope for this repository.",
  },
  "authority.repo_change.grant_spent": {
    summary:
      "The grant's bundle already exists on the judged history: one grant backs one landing.",
    fix: "Issue a new grant for a new change.",
  },
  "authority.repo_change.delegated_scope_outside": {
    summary: "The receipt's delegated_scope is absent or outside the tick's scope.",
    fix: "Record the tick's scope as the receipt's delegated_scope.",
  },
  "authority.repo_change.tools_used_outside": {
    summary: "The receipt's tools_used names a tool outside the tick's scope.",
    fix: "A run may use only the tools its tick authorizes.",
  },
  "authority.repo_change.tool_receipt_outside_scope": {
    summary: "A tool receipt that is not denied names a tool outside the tick's scope.",
    fix: "A run may complete or fail only calls to tools its tick authorizes.",
  },
  "authority.repo_change.tools_used_mismatch": {
    summary: "tools_used differs from the set of tool names in the receipts that are not denied.",
    fix: "Record in tools_used exactly the tools of the calls that were not denied.",
  },
  "authority.repo_change.memories_formed": {
    summary: "The run formed memories; a governed run has no interior.",
    fix: "Run with no interior: memories_formed must be 0.",
  },
  "authority.repo_change.scope_path_not_permitted": {
    summary: "An allowed path in the scope fails the repository's path predicate.",
    fix: "Scope only paths the predicate at the judged commit permits.",
  },
  "authority.repo_change.entry_not_add_or_modify": {
    summary: "The change deletes a path (a rename is a delete plus an add).",
    fix: "A governed change only adds or modifies files.",
  },
  "authority.repo_change.entry_symlink": {
    summary: "The change adds or modifies a symlink.",
    fix: "A governed change only writes regular 100644 files.",
  },
  "authority.repo_change.entry_submodule": {
    summary: "The change adds or modifies a submodule.",
    fix: "A governed change only writes regular 100644 files.",
  },
  "authority.repo_change.entry_mode": {
    summary: "The change writes a mode other than 100644, or changes a path's mode.",
    fix: "A governed change only writes regular 100644 files and never changes a mode.",
  },
  "authority.repo_change.entry_binary": {
    summary: "The change writes content containing a NUL byte.",
    fix: "A governed change only writes text without NUL bytes.",
  },
  "authority.repo_change.entry_case_collision": {
    summary: "A changed path collides by case with another tracked or changed path.",
    fix: "Change only paths that no other path aliases on a case-insensitive filesystem.",
  },
  "authority.repo_change.entry_path_not_allowed": {
    summary: "A changed path is not byte-equal to an allowed path of the scope.",
    fix: "Change only the scope's allowed_paths.",
  },
  "authority.repo_change.entry_path_not_permitted": {
    summary: "A changed path fails the repository's path predicate.",
    fix: "Change only paths the predicate at the judged commit permits.",
  },
  "authority.repo_change.entries_exceed_max": {
    summary: "The change has more entries than the scope's max_changed_files.",
    fix: "Change at most max_changed_files paths.",
  },
  "authority.repo_change.entries_mismatch": {
    summary: "The recorded entries differ from the entries computed from the commits.",
    fix: "Record exactly the paths the change commit adds or modifies, with their mode and blob.",
  },
  "revocation.repo_change.revoked": {
    summary: "A revocation of the grant, signed by its delegator, is present at the judged commit.",
    fix: "The grant is dead authority; do not land the change.",
  },
  "revocation.repo_change.unchecked": {
    summary: "No revocation set was supplied, so revocation was not checked.",
    fix: "Supply the strictly parsed revocations under .motebit/revocations/ at the judged commit.",
  },
  "revocation.repo_change.set_malformed": {
    summary:
      "A file under .motebit/revocations/ failed strict parsing, so revocation cannot read as fresh.",
    fix: "Fix or remove the malformed revocation file through a principal-approved change.",
  },
};

// ===========================================================================
// Small pure helpers
// ===========================================================================

const HEX64 = /^[0-9a-f]{64}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OCTAL_MODE = /^[0-7]{6}$/;
const REGULAR_FILE_MODE = "100644";
const SYMLINK_MODE = "120000";
const GITLINK_MODE = "160000";

const ENCODER = new TextEncoder();

function axisOf(code: RepoChangeRepairCode): RepairInstruction["axis"] {
  if (code.startsWith("integrity.")) return "integrity";
  if (code.startsWith("identity.")) return "identityBinding";
  if (code.startsWith("authority.")) return "authority";
  return "revocation";
}

function isCanonicalHex(s: string, length: number): boolean {
  return s.length === length && /^[0-9a-f]*$/.test(s);
}

function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ===========================================================================
// Strict shapes
// ===========================================================================

function isDigestRef(v: unknown): boolean {
  return (
    isObject(v) &&
    hasExactKeys(v, ["algorithm", "value"]) &&
    v.algorithm === "sha-256" &&
    isString(v.value)
  );
}

const STATUSES: readonly unknown[] = ["completed", "failed", "denied"];
const ORIGINS: readonly unknown[] = ["user-tap", "ai-loop", "scheduled", "agent-to-agent"];

function isToolReceiptShape(v: unknown): v is RepoChangeToolInvocationReceipt {
  return (
    isObject(v) &&
    hasExactKeys(
      v,
      [
        "invocation_id",
        "task_id",
        "motebit_id",
        "public_key",
        "device_id",
        "tool_name",
        "started_at",
        "completed_at",
        "status",
        "args_hash",
        "result_hash",
        "suite",
        "signature",
      ],
      ["invocation_origin"],
    ) &&
    isNonEmptyString(v.invocation_id) &&
    isNonEmptyString(v.task_id) &&
    isNonEmptyString(v.motebit_id) &&
    isString(v.public_key) &&
    isNonEmptyString(v.device_id) &&
    isNonEmptyString(v.tool_name) &&
    isNumber(v.started_at) &&
    isNumber(v.completed_at) &&
    STATUSES.includes(v.status) &&
    isString(v.args_hash) &&
    isString(v.result_hash) &&
    (v.invocation_origin === undefined || ORIGINS.includes(v.invocation_origin)) &&
    v.suite === "motebit-jcs-ed25519-b64-v1" &&
    isNonEmptyString(v.signature)
  );
}

function isReceiptShape(v: unknown): v is RepoChangeExecutionReceipt {
  return (
    isObject(v) &&
    hasExactKeys(
      v,
      [
        "task_id",
        "motebit_id",
        "public_key",
        "device_id",
        "submitted_at",
        "completed_at",
        "status",
        "result",
        "tools_used",
        "memories_formed",
        "prompt_hash",
        "result_hash",
        "suite",
        "signature",
      ],
      ["delegated_scope", "invocation_origin"],
    ) &&
    isNonEmptyString(v.task_id) &&
    isNonEmptyString(v.motebit_id) &&
    isString(v.public_key) &&
    isNonEmptyString(v.device_id) &&
    isNumber(v.submitted_at) &&
    isNumber(v.completed_at) &&
    STATUSES.includes(v.status) &&
    isString(v.result) &&
    Array.isArray(v.tools_used) &&
    v.tools_used.every(isString) &&
    Number.isSafeInteger(v.memories_formed) &&
    (v.memories_formed as number) >= 0 &&
    isString(v.prompt_hash) &&
    isString(v.result_hash) &&
    (v.delegated_scope === undefined || isString(v.delegated_scope)) &&
    (v.invocation_origin === undefined || ORIGINS.includes(v.invocation_origin)) &&
    v.suite === "motebit-jcs-ed25519-b64-v1" &&
    isNonEmptyString(v.signature)
  );
}

function isBundleShape(v: unknown): v is RepoChangeBundle {
  return (
    isObject(v) &&
    hasExactKeys(v, ["spec", "scope", "grant", "tick", "tool_receipts", "receipt"]) &&
    v.spec === REPO_CHANGE_BUNDLE_SPEC_ID &&
    isScopeShape(v.scope) &&
    isGrantShape(v.grant) &&
    isTickShape(v.tick) &&
    Array.isArray(v.tool_receipts) &&
    v.tool_receipts.length <= REPO_CHANGE_MAX_TOOL_RECEIPTS &&
    v.tool_receipts.every(isToolReceiptShape) &&
    isReceiptShape(v.receipt)
  );
}

function isEntryShape(v: unknown): v is RepoChangeEntry {
  return (
    isObject(v) &&
    hasExactKeys(v, ["path", "mode", "blob"]) &&
    isString(v.path) &&
    isString(v.mode) &&
    isString(v.blob)
  );
}

function isResultShape(v: unknown): v is RepoChangeResult {
  return (
    isObject(v) &&
    hasExactKeys(v, [
      "spec",
      "grant_id",
      "grant_digest",
      "tick_digest",
      "scope_digest",
      "repo",
      "object_format",
      "parent_commit",
      "head_commit",
      "entries",
      "tool_receipt_digests",
      "system_prompt_digest",
      "provider",
      "model",
      "runtime_version",
    ]) &&
    v.spec === REPO_CHANGE_SPEC_ID &&
    isNonEmptyString(v.grant_id) &&
    isDigestRef(v.grant_digest) &&
    isDigestRef(v.tick_digest) &&
    isDigestRef(v.scope_digest) &&
    isNonEmptyString(v.repo) &&
    (ALL_GIT_OBJECT_FORMATS as readonly unknown[]).includes(v.object_format) &&
    isString(v.parent_commit) &&
    isString(v.head_commit) &&
    Array.isArray(v.entries) &&
    v.entries.every(isEntryShape) &&
    Array.isArray(v.tool_receipt_digests) &&
    v.tool_receipt_digests.length <= REPO_CHANGE_MAX_TOOL_RECEIPTS &&
    v.tool_receipt_digests.every(isDigestRef) &&
    isDigestRef(v.system_prompt_digest) &&
    isNonEmptyString(v.provider) &&
    isNonEmptyString(v.model) &&
    isNonEmptyString(v.runtime_version)
  );
}

function isRevocationShape(v: unknown): v is DelegationRevocation {
  return (
    isObject(v) &&
    hasExactKeys(v, [
      "grant_id",
      "delegator_id",
      "delegator_public_key",
      "revoked_at",
      "suite",
      "signature",
    ]) &&
    isNonEmptyString(v.grant_id) &&
    isNonEmptyString(v.delegator_id) &&
    isString(v.delegator_public_key) &&
    isNumber(v.revoked_at) &&
    v.suite === "motebit-jcs-ed25519-b64-v1" &&
    isNonEmptyString(v.signature)
  );
}

// ===========================================================================
// The verifier
// ===========================================================================

const AXIS_ORDER: readonly RepairInstruction["axis"][] = [
  "integrity",
  "identityBinding",
  "authority",
  "revocation",
];

/** Authority codes that are about TIME, not structure. */
const TEMPORAL_AUTHORITY_CODES: ReadonlySet<RepoChangeRepairCode> = new Set<RepoChangeRepairCode>([
  "authority.repo_change.tick_expired",
  "authority.repo_change.tick_not_yet_valid",
  "authority.repo_change.time_unavailable",
  "authority.repo_change.grant_not_yet_valid",
]);

/**
 * Verify one governed repo change (spec/repo-change-v1.md §7). Pure and
 * offline; every input that needs git or the filesystem is the caller's.
 *
 * Returns the verdict (`type: "repo_change"`), the receipt's `status` as
 * `outcome`, and every failed rule in `diagnostics`. A change is acceptable
 * only when `isFullyVerified(verdict)` AND `outcome === "completed"`.
 */
export async function verifyRepoChange(
  input: VerifyRepoChangeInput,
): Promise<RepoChangeVerification> {
  const failures: RepoChangeFailure[] = [];
  const fail = (code: RepoChangeRepairCode, detail: string): void => {
    failures.push({ code, axis: axisOf(code), detail });
  };

  const { mode } = input;
  // Only a finite number is a time. NaN, ±Infinity, a missing field (a JS
  // caller) or null all read as "no acceptable time" — never a fallback clock.
  const rawNow: unknown = mode.kind === "pull_request" ? mode.now : mode.landedAt;
  const now = typeof rawNow === "number" && Number.isFinite(rawNow) ? rawNow : null;
  const temporalBasis = mode.kind === "pull_request" ? "local_clock" : "operator_recorded";

  // -- Mode: ancestry and shape checks fold into integrity. CI records every
  // axis even when one fails, so nothing returns early on these.
  for (const shape of mode.shapeFailures) fail("integrity.repo_change.shape_check_failed", shape);

  // -- The bundle: strict shape, then canonical bytes.
  const text = decodeStrict(input.bundle);
  let parsed: unknown;
  try {
    parsed = text === null ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (text === null || !isBundleShape(parsed)) {
    fail(
      "integrity.repo_change.bundle_malformed",
      "the bundle is not UTF-8 JSON of the strict bundle shape",
    );
    return finish(failures, input, {
      bundle: null,
      identityEstablished: false,
      temporalBasis,
      evidenceBasis: [],
      revocation: { status: "unchecked" },
    });
  }
  const bundle = parsed;
  if (canonicalJson(bundle) !== text) {
    fail(
      "integrity.repo_change.bundle_not_canonical",
      "the bundle bytes are not its canonical JSON",
    );
  }
  const { scope, grant, tick, receipt } = bundle;
  const toolReceipts = bundle.tool_receipts;
  const idLength = GIT_OBJECT_ID_HEX_LENGTH[scope.object_format];

  // -- Canonicality (integrity): one spelling per value.
  const notCanonical = (what: string): void =>
    fail("integrity.repo_change.value_not_canonical", what);
  for (const [what, key] of [
    ["grant.delegator_public_key", grant.delegator_public_key],
    ["grant.delegate_public_key", grant.delegate_public_key],
    ["tick.delegator_public_key", tick.delegator_public_key],
    ["tick.delegate_public_key", tick.delegate_public_key],
    ["receipt.public_key", receipt.public_key],
  ] as const) {
    if (!HEX64.test(key)) notCanonical(`${what} is not 64 lowercase hex`);
  }
  for (const [what, sig] of [
    ["grant.signature", grant.signature],
    ["tick.signature", tick.signature],
    ["receipt.signature", receipt.signature],
  ] as const) {
    if (!isCanonicalBase64Url(sig)) notCanonical(`${what} is not canonical base64url`);
  }
  if (!CANONICAL_UUID.test(grant.grant_id)) notCanonical("grant.grant_id is not a lowercase UUID");
  if (grant.subject_binding !== undefined && !HEX64.test(grant.subject_binding.digest)) {
    notCanonical("grant.subject_binding.digest is not 64 lowercase hex");
  }
  if (!HEX64.test(receipt.prompt_hash)) notCanonical("receipt.prompt_hash is not 64 lowercase hex");
  if (!HEX64.test(receipt.result_hash)) notCanonical("receipt.result_hash is not 64 lowercase hex");
  toolReceipts.forEach((tr, i) => {
    if (!HEX64.test(tr.public_key))
      notCanonical(`tool_receipts[${i}].public_key is not 64 lowercase hex`);
    if (!isCanonicalBase64Url(tr.signature)) {
      notCanonical(`tool_receipts[${i}].signature is not canonical base64url`);
    }
    if (!HEX64.test(tr.args_hash))
      notCanonical(`tool_receipts[${i}].args_hash is not 64 lowercase hex`);
    if (!HEX64.test(tr.result_hash))
      notCanonical(`tool_receipts[${i}].result_hash is not 64 lowercase hex`);
  });
  const seenAllowed = new Set<string>();
  for (const p of scope.allowed_paths) {
    if (!isCanonicalPath(p))
      notCanonical(`scope.allowed_paths has a non-canonical path: ${JSON.stringify(p)}`);
    if (seenAllowed.has(p)) notCanonical(`scope.allowed_paths repeats ${JSON.stringify(p)}`);
    seenAllowed.add(p);
  }

  // -- Signatures (integrity), each under its own embedded key.
  const grantSigned = await verifyStandingDelegation(grant, {
    checkExpiry: false,
    now: Number.MAX_SAFE_INTEGER,
  });
  if (!grantSigned)
    fail("integrity.repo_change.signature_invalid", "the grant's signature does not verify");
  // The tick's own signature, clockless (its window is the authority axis).
  const tickSigned = await verifyDelegation(tick, { checkExpiry: false });
  // The wall-clock verdict is computed only at an accepted time, for the window.
  const wallClock =
    now === null
      ? null
      : await verifyDelegationTokenVerdict(tick, grant, { now, temporalMode: "wall_clock" });
  if (!tickSigned) {
    fail("integrity.repo_change.signature_invalid", "the tick's signature does not verify");
  }
  const receiptSigned =
    HEX64.test(receipt.public_key) &&
    (await verifyExecutionReceipt(receipt, hexToBytes(receipt.public_key)));
  if (!receiptSigned) {
    fail(
      "integrity.repo_change.signature_invalid",
      "the execution receipt's signature does not verify",
    );
  }
  for (const [i, tr] of toolReceipts.entries()) {
    const signed =
      HEX64.test(tr.public_key) &&
      (await verifyToolInvocationReceipt(tr, hexToBytes(tr.public_key)));
    if (!signed)
      fail(
        "integrity.repo_change.signature_invalid",
        `tool_receipts[${i}]'s signature does not verify`,
      );
  }
  if ((await hash(ENCODER.encode(receipt.result))) !== receipt.result_hash) {
    fail(
      "integrity.repo_change.result_hash_mismatch",
      "receipt.result_hash != hex(SHA-256(result))",
    );
  }

  // -- The change record (integrity): strict shape, canonical, canonical values.
  let record: RepoChangeResult | null = null;
  let recordValue: unknown;
  try {
    recordValue = JSON.parse(receipt.result);
  } catch {
    recordValue = undefined;
  }
  if (!isResultShape(recordValue)) {
    fail(
      "integrity.repo_change.result_malformed",
      "receipt.result is not the strict change-record shape",
    );
  } else {
    record = recordValue;
    if (canonicalJson(record) !== receipt.result) {
      fail(
        "integrity.repo_change.result_not_canonical",
        "receipt.result is not the record's canonical JSON",
      );
    }
    for (const [what, ref] of [
      ["grant_digest", record.grant_digest],
      ["tick_digest", record.tick_digest],
      ["scope_digest", record.scope_digest],
      ["system_prompt_digest", record.system_prompt_digest],
      ...record.tool_receipt_digests.map((d, i) => [`tool_receipt_digests[${i}]`, d] as const),
    ] as const) {
      if (!HEX64.test(ref.value)) notCanonical(`record.${what} is not 64 lowercase hex`);
    }
    for (const [what, id] of [
      ["parent_commit", record.parent_commit],
      ["head_commit", record.head_commit],
    ] as const) {
      if (!isCanonicalHex(id, idLength))
        notCanonical(`record.${what} is not ${idLength} lowercase hex`);
    }
    record.entries.forEach((e, i) => {
      if (!isCanonicalPath(e.path)) notCanonical(`record.entries[${i}].path is not canonical`);
      if (!OCTAL_MODE.test(e.mode))
        notCanonical(`record.entries[${i}].mode is not six octal digits`);
      if (!isCanonicalHex(e.blob, idLength))
        notCanonical(`record.entries[${i}].blob is not ${idLength} lowercase hex`);
      const prev = record?.entries[i - 1];
      if (prev !== undefined && !(prev.path < e.path)) {
        notCanonical(`record.entries is not sorted by path and unique at ${i}`);
      }
    });
  }

  // -- The scope matches the grant's signed binding (integrity).
  if (grant.subject_binding !== undefined) {
    const match = await verifySubjectBinding(grant.subject_binding, scope);
    if (!match.valid)
      fail("integrity.repo_change.scope_binding_mismatch", match.error ?? "no match");
  }

  // -- The record's references agree with the bundle (integrity).
  if (record !== null) {
    if (record.grant_id !== grant.grant_id) {
      fail("integrity.repo_change.grant_id_mismatch", "record.grant_id != grant.grant_id");
    }
    if (record.grant_digest.value !== (await canonicalSha256(grant))) {
      fail("integrity.repo_change.grant_digest_mismatch", "record.grant_digest != digest(grant)");
    }
    if (record.tick_digest.value !== (await canonicalSha256(tick))) {
      fail("integrity.repo_change.tick_digest_mismatch", "record.tick_digest != digest(tick)");
    }
    if (record.scope_digest.value !== (await subjectBindingDigest(scope))) {
      fail("integrity.repo_change.scope_digest_mismatch", "record.scope_digest != digest(scope)");
    }
    if (record.repo !== scope.repo || record.object_format !== scope.object_format) {
      fail(
        "integrity.repo_change.scope_reference_mismatch",
        "record repo/object_format != the scope's",
      );
    }
    const bundled = await Promise.all(toolReceipts.map((tr) => canonicalSha256(tr)));
    const recorded = record.tool_receipt_digests.map((d) => d.value);
    const bundledSet = new Set(bundled);
    const recordedSet = new Set(recorded);
    if (
      bundledSet.size !== bundled.length ||
      recordedSet.size !== recorded.length ||
      bundledSet.size !== recordedSet.size ||
      [...bundledSet].some((d) => !recordedSet.has(d))
    ) {
      fail(
        "integrity.repo_change.tool_receipts_mismatch",
        "record.tool_receipt_digests differ, as a set, from the bundle's tool receipts",
      );
    }
  }
  if (receipt.prompt_hash !== (await hash(ENCODER.encode(scope.task)))) {
    fail(
      "integrity.repo_change.prompt_hash_mismatch",
      "receipt.prompt_hash != hex(SHA-256(scope.task))",
    );
  }
  toolReceipts.forEach((tr, i) => {
    if (tr.task_id !== receipt.task_id) {
      fail(
        "integrity.repo_change.task_id_mismatch",
        `tool_receipts[${i}].task_id != receipt.task_id`,
      );
    }
  });

  // -- Identity binding: strict pins, matched as (motebit_id, public_key) pairs
  // (repo-change-rules.ts — the same law a repo-task run checks before it starts).
  checkRepoChangeParties(grant, input.pins, fail);
  const isDelegate = (id: string, key: string): boolean =>
    id === grant.delegate_id && key === grant.delegate_public_key;
  if (!isDelegate(tick.delegate_id, tick.delegate_public_key)) {
    fail(
      "identity.repo_change.signer_not_delegate",
      "the tick's delegate is not the grant's delegate",
    );
  }
  if (!isDelegate(receipt.motebit_id, receipt.public_key)) {
    fail(
      "identity.repo_change.signer_not_delegate",
      "the execution receipt's signer is not the grant's delegate",
    );
  }
  toolReceipts.forEach((tr, i) => {
    if (!isDelegate(tr.motebit_id, tr.public_key)) {
      fail(
        "identity.repo_change.signer_not_delegate",
        `tool_receipts[${i}]'s signer is not the grant's delegate`,
      );
    }
  });

  // -- Authority: the tick against the grant, then the repo-change rules
  // (repo-change-rules.ts — one law, shared with the repo-task run).
  checkRepoChangeTickStructure(grant, tick, fail);
  checkRepoChangeWindow({ grant, tick, now, wallClock, failures }, fail);
  const tickTools = checkRepoChangeGrantShape(grant, tick, fail);
  const authorized: ReadonlySet<string> = tickTools ?? new Set<string>();
  if (scope.repo !== input.expectedRepo) {
    fail(
      "authority.repo_change.repo_mismatch",
      `scope.repo ${JSON.stringify(scope.repo)} != the expected repository`,
    );
  }
  if (input.spent)
    fail(
      "authority.repo_change.grant_spent",
      "the grant's bundle already exists on the judged history",
    );
  const delegated =
    receipt.delegated_scope === undefined ? null : strictTools(receipt.delegated_scope);
  if (delegated === null || [...delegated].some((t) => !authorized.has(t))) {
    fail(
      "authority.repo_change.delegated_scope_outside",
      "receipt.delegated_scope is absent or outside the tick's scope",
    );
  }
  for (const t of receipt.tools_used) {
    if (!authorized.has(t))
      fail("authority.repo_change.tools_used_outside", `tools_used names ${JSON.stringify(t)}`);
  }
  const notDeniedNames = new Set<string>();
  toolReceipts.forEach((tr, i) => {
    if (tr.status === "denied") return; // a denial may name anything: C's denial evidence stays valid
    notDeniedNames.add(tr.tool_name);
    if (!authorized.has(tr.tool_name)) {
      fail(
        "authority.repo_change.tool_receipt_outside_scope",
        `tool_receipts[${i}] (${tr.status}) names ${JSON.stringify(tr.tool_name)}`,
      );
    }
  });
  const usedSet = new Set(receipt.tools_used);
  if (usedSet.size !== notDeniedNames.size || [...usedSet].some((t) => !notDeniedNames.has(t))) {
    fail(
      "authority.repo_change.tools_used_mismatch",
      "tools_used != the tools of the receipts not denied",
    );
  }
  if (receipt.memories_formed !== 0) {
    fail("authority.repo_change.memories_formed", `memories_formed is ${receipt.memories_formed}`);
  }
  for (const p of scope.allowed_paths) {
    if (!input.isPathPermitted(p)) {
      fail(
        "authority.repo_change.scope_path_not_permitted",
        `allowed path ${JSON.stringify(p)} fails the predicate`,
      );
    }
  }

  // -- Authority: every change entry inside the scope (executed ⊆ authorized).
  const allowedBytes = scope.allowed_paths.map((p) => ENCODER.encode(p));
  const changed: string[] = [];
  const computed: RepoChangeEntry[] = [];
  let computedDecodable = true;
  for (const e of input.entries) {
    const p = decodeStrict(e.path);
    const label = p === null ? "<undecodable path>" : JSON.stringify(p);
    if (e.kind === "delete") {
      fail("authority.repo_change.entry_not_add_or_modify", `${label} is deleted`);
    } else {
      if (e.mode === SYMLINK_MODE) {
        fail("authority.repo_change.entry_symlink", `${label} is a symlink`);
      } else if (e.mode === GITLINK_MODE) {
        fail("authority.repo_change.entry_submodule", `${label} is a submodule`);
      } else if (e.mode !== REGULAR_FILE_MODE) {
        fail("authority.repo_change.entry_mode", `${label} has mode ${e.mode}`);
      }
      if (e.kind === "modify" && e.previousMode !== e.mode) {
        fail(
          "authority.repo_change.entry_mode",
          `${label} changes mode ${String(e.previousMode)} → ${e.mode}`,
        );
      }
      if (p === null) computedDecodable = false;
      else {
        changed.push(p);
        computed.push({ path: p, mode: e.mode, blob: e.blob });
      }
    }
    if (e.containsNul) fail("authority.repo_change.entry_binary", `${label} contains a NUL byte`);
    if (!allowedBytes.some((a) => bytesEqual(a, e.path))) {
      fail("authority.repo_change.entry_path_not_allowed", `${label} is not an allowed path`);
    }
    if (p === null || !input.isPathPermitted(p)) {
      fail("authority.repo_change.entry_path_not_permitted", `${label} fails the predicate`);
    }
  }
  const tracked: string[] = [];
  for (const t of input.trackedPaths) {
    const s = decodeStrict(t);
    if (s !== null) tracked.push(s);
    else {
      // A tracked path the case index cannot read: no collision can be ruled
      // out, so the rule fails closed rather than silently dropping it.
      fail(
        "authority.repo_change.entry_case_collision",
        "a tracked path is not valid UTF-8, so no case collision can be ruled out",
      );
    }
  }
  const index = caseIndex([...tracked, ...changed]);
  for (const p of changed) {
    const collision = caseCollision(p, index);
    if (collision !== null) fail("authority.repo_change.entry_case_collision", collision);
  }
  if (input.entries.length > scope.max_changed_files) {
    fail(
      "authority.repo_change.entries_exceed_max",
      `${input.entries.length} entries > max_changed_files ${scope.max_changed_files}`,
    );
  }
  computed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    record === null ||
    !computedDecodable ||
    record.entries.length !== computed.length ||
    record.entries.some(
      (r, i) =>
        r.path !== computed[i]!.path ||
        r.mode !== computed[i]!.mode ||
        r.blob !== computed[i]!.blob,
    )
  ) {
    fail(
      "authority.repo_change.entries_mismatch",
      "the recorded entries differ from the computed ones",
    );
  }

  // -- Revocation: strictly parsed, bound per grant by findGrantRevocation.
  let revocation: RevocationVerdict;
  const evidenceBasis: EvidenceRef[] = [
    { kind: "grant", ref: grant.grant_id },
    { kind: "delegation_token", ref: tick.signature },
    { kind: "receipt", ref: receipt.result_hash },
    { kind: "public_key", ref: grant.delegate_public_key },
  ];
  const revs = input.revocations;
  if (revs === undefined) {
    fail("revocation.repo_change.unchecked", "no revocation set was supplied");
    revocation = { status: "unchecked" };
  } else {
    let malformed = revs.failures.length > 0;
    for (const f of revs.failures) fail("revocation.repo_change.set_malformed", f);
    const wellFormed: DelegationRevocation[] = [];
    for (const [i, r] of revs.set.entries()) {
      const ok =
        isRevocationShape(r) &&
        CANONICAL_UUID.test(r.grant_id) &&
        isCanonicalBase64Url(r.signature) &&
        (await verifyDelegationRevocation(r));
      if (ok) wellFormed.push(r);
      else {
        malformed = true;
        fail("revocation.repo_change.set_malformed", `revocations[${i}] fails strict parsing`);
      }
    }
    const binding = await findGrantRevocation(grant, wellFormed);
    if (binding !== null) {
      fail("revocation.repo_change.revoked", `grant ${grant.grant_id} is revoked`);
      evidenceBasis.push({ kind: "revocation", ref: binding.signature });
      revocation = { status: "revoked", freshness: revs.freshness };
    } else if (malformed) {
      revocation = { status: "unchecked", freshness: revs.freshness };
    } else {
      revocation = { status: "fresh", freshness: revs.freshness };
    }
  }

  return finish(failures, input, {
    bundle,
    identityEstablished: true,
    temporalBasis,
    evidenceBasis,
    revocation,
  });
}

function finish(
  failures: RepoChangeFailure[],
  input: VerifyRepoChangeInput,
  state: {
    bundle: RepoChangeBundle | null;
    identityEstablished: boolean;
    temporalBasis: "local_clock" | "operator_recorded";
    evidenceBasis: EvidenceRef[];
    revocation: RevocationVerdict;
  },
): RepoChangeVerification {
  const ordered = AXIS_ORDER.flatMap((axis) => failures.filter((f) => f.axis === axis));
  const on = (axis: RepairInstruction["axis"]): RepoChangeFailure[] =>
    ordered.filter((f) => f.axis === axis);

  const authorityFailures = on("authority");
  const codes = new Set(authorityFailures.map((f) => f.code));
  let authority: VerificationVerdict["authority"];
  if (state.bundle === null) authority = "unknown";
  else if (authorityFailures.some((f) => !TEMPORAL_AUTHORITY_CODES.has(f.code)))
    authority = "insufficient";
  else if (codes.has("authority.repo_change.time_unavailable")) authority = "unknown";
  else if (codes.has("authority.repo_change.tick_expired")) authority = "expired";
  else if (
    codes.has("authority.repo_change.grant_not_yet_valid") ||
    codes.has("authority.repo_change.tick_not_yet_valid")
  )
    authority = "not_yet_valid";
  else authority = "valid";

  const first = ordered[0];
  const repair: RepairInstruction | undefined =
    first === undefined
      ? undefined
      : {
          code: first.code,
          axis: first.axis,
          summary: REPAIR[first.code].summary,
          canonical: SPEC,
          fix: REPAIR[first.code].fix,
        };

  const verdict: VerificationVerdict = {
    type: "repo_change",
    integrity: on("integrity").length > 0 ? "invalid" : "verified",
    identityBinding: !state.identityEstablished
      ? "unverified"
      : on("identityBinding").length > 0
        ? "invalid"
        : "pinned",
    authority,
    revocation: state.revocation,
    temporalBasis: state.temporalBasis,
    evidenceBasis: state.evidenceBasis,
    ...(repair ? { repair } : {}),
  };

  const revocationsReadAt = input.revocations?.readAt;
  return {
    verdict,
    outcome: state.bundle === null ? null : state.bundle.receipt.status,
    diagnostics: {
      failures: ordered,
      ...(revocationsReadAt !== undefined ? { revocationsReadAt } : {}),
    },
  };
}
