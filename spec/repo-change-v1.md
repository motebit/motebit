# motebit/repo-change@1.0

## Governed Repo Change Specification

**Status:** Draft
**Version:** 1.0
**Date:** 2026-10-28

Design of record: [`docs/proposals/governed-repo-change-v1.md`](../docs/proposals/governed-repo-change-v1.md). JSON Schemas: [`schemas/repo-task-scope-v1.json`](schemas/repo-task-scope-v1.json), [`schemas/repo-change-v1.json`](schemas/repo-change-v1.json), [`schemas/repo-change-bundle-v1.json`](schemas/repo-change-bundle-v1.json). Reference verifier: `verifyRepoChange` in `@motebit/verifier`.

## 1. Scope

This spec lets a party holding a clone of a repository and an offline verifier establish, for one repository change made by an agent, **which agent acted, under whose authority, within what limits, with what outcome**, and that the commit that landed on the protected branch is that outcome.

It defines three artifacts and the law that judges them:

- the **scope** `motebit/repo-task-scope@1.0` (`RepoTaskScope`) — the principal's detached statement of what one task may change;
- the **change record** `motebit/repo-change@1.0` (`RepoChangeResult`) — what the run changed, carried as the `result` of the agent's signed `ExecutionReceipt`;
- the **bundle** `motebit/repo-change-bundle@1.0` (`RepoChangeBundle`) — every artifact a verifier needs, landed in the repository with the change.

None of the three carries a signature of its own. The principal's `StandingDelegation` reaches the scope through `subject_binding` ([`standing-delegation-v1.md`](standing-delegation-v1.md) §3.2); the agent's `ExecutionReceipt` signature reaches the change record; the bundle is a container whose every member is signed or digest-bound.

### What it is not

- **Not merge authority.** A verified change confers nothing by itself; whatever merges a change does so under its own rules.
- **Not proof of correctness.** The verifier proves who signed what, within which limits, which entries changed, and that the landed commit carries exactly that change. It does not prove that the change is correct, or that the model did what the task text asked.
- **Not repository policy.** The verifier interprets an injected path predicate (§7.2); it never executes repository code to obtain one.

## 2. Roles and pins

| Role      | Holds                     | Signs                                                       |
| --------- | ------------------------- | ----------------------------------------------------------- |
| Principal | the principal's key       | the grant (and through it the scope), the tick, revocations |
| Agent     | the agent's key, no other | every `ToolInvocationReceipt`, the `ExecutionReceipt`       |
| Verifier  | nothing                   | nothing                                                     |

**Pins are typed by role.** The repository holds one principal pin and any number of agent pins, each an identity file whose current `(motebit_id, public_key)` pair is the pin. A verifier MUST reject (`identityBinding: "invalid"`) unless ALL hold:

1. the grant's `(delegator_id, delegator_public_key)` equals the principal pin's `(motebit_id, public_key)`, both members compared together, byte-exact;
2. the grant's `(delegate_id, delegate_public_key)` equals some agent pin's pair;
3. the delegator is not the delegate: `delegator_id ≠ delegate_id` and `delegator_public_key ≠ delegate_public_key`;
4. the tick's `(delegate_id, delegate_public_key)`, the `ExecutionReceipt`'s `(motebit_id, public_key)` and every `ToolInvocationReceipt`'s `(motebit_id, public_key)` equal the grant's delegate pair.

**Pinned is strict.** A pin is judged against the role file **at the commit being judged**, as byte-equality of the current pair. A verifier MUST NOT use a time-windowed key check (a key valid "as of" a time taken from an artifact). A rotated-out key therefore stops authorizing new changes at once, and so do live grants it signed: authority flows forward across rotation, never back. This is narrower than `pinned` in [`terminology-v1.md`](terminology-v1.md) §10.1 (deviation 3, §8).

**Revocation authority is per grant.** A revocation is authoritative over a grant only by the binding of [`standing-delegation-v1.md`](standing-delegation-v1.md) §5 — same `grant_id`, and `delegator_public_key` equal to **that grant's** `delegator_public_key` (`findGrantRevocation`) — never by the current principal pin. A revocation signed before the principal rotates stays valid evidence against the grants that key signed, and a well-formed revocation under any other key cannot revoke a principal's grant.

## 3. Wire types

### 3.1 — RepoTaskScope

#### Wire format (foundation law)

Unsigned; bound into a `StandingDelegation` by `subject_binding` with `artifact_schema: "motebit.repo-task-scope.v1"` and `digest` = hex SHA-256 of its canonical JSON. Conformant validators reject unknown fields.

```
RepoTaskScope {
  schema:             string    // "motebit.repo-task-scope.v1" — the type tag verifySubjectBinding reads
  spec:               string    // "motebit/repo-task-scope@1.0"
  repo:               string    // the repository the change lands in; compared byte-exact with the verifier's expected repository
  base_ref:           string    // "main" — the protected branch
  object_format:      string    // "sha1" | "sha256" — the repository's git object format (GitObjectFormat)
  allowed_paths:      string[]  // non-empty, unique; each canonical under §4
  max_changed_files:  number    // integer in [1, 2^53 − 1]
  task:               string    // non-empty; the task text the run starts from
}
```

### 3.2 — RepoChangeEntry

#### Wire format (foundation law)

One path the change adds or modifies.

```
RepoChangeEntry {
  path:  string   // canonical under §4
  mode:  string   // git file mode, six octal digits
  blob:  string   // blob object id, lowercase hex of the object_format's length
}
```

### 3.3 — RepoChangeResult

#### Wire format (foundation law)

The change record. It is the `ExecutionReceipt`'s `result`, as canonical JSON (RFC 8785), **for every receipt status** (deviation 1, §8). Conformant validators reject unknown fields.

```
RepoChangeResult {
  spec:                  string             // "motebit/repo-change@1.0"
  grant_id:              string             // the grant the run acted under; a lowercase UUID (§4)
  grant_digest:          DigestRef          // SHA-256 of the canonical JSON of the whole signed grant, signature included
  tick_digest:           DigestRef          // SHA-256 of the canonical JSON of the whole signed tick, signature included
  scope_digest:          DigestRef          // SHA-256 of the canonical JSON of the scope (= the grant's subject_binding.digest)
  repo:                  string             // the scope's repo
  object_format:         string             // the scope's object_format
  parent_commit:         string             // the commit the change commit sits on
  head_commit:           string             // the change commit
  entries:               RepoChangeEntry[]  // every path the change adds or modifies, sorted by path bytes, unique
  tool_receipt_digests:  DigestRef[]        // SHA-256 of the canonical JSON of each signed tool receipt; unique; at most 256
  system_prompt_digest:  DigestRef          // SHA-256 of the UTF-8 bytes of the system prompt the run used
  provider:              string             // informational
  model:                 string             // informational
  runtime_version:       string             // informational
}
```

Every digest is a `DigestRef` (`{algorithm: "sha-256", value}`, [`evidence-provenance-v1.md`](evidence-provenance-v1.md)); no field name carries a hash algorithm.

### 3.4 — RepoChangeExecutionReceipt

#### Wire format (foundation law)

The profile of `ExecutionReceipt` ([`execution-ledger-v1.md`](execution-ledger-v1.md) §11.1) a bundle carries. Signed by the agent (suite `motebit-jcs-ed25519-b64-v1`).

```
RepoChangeExecutionReceipt {
  task_id:          string    // the run's fresh task id
  motebit_id:       string    // the agent
  public_key:       string    // REQUIRED; 64 lowercase hex — the agent's key
  device_id:        string
  submitted_at:     number
  completed_at:     number
  status:           string    // "completed" | "failed" | "denied" — reported as the verification's outcome
  result:           string    // canonical JSON of the RepoChangeResult, for every status
  tools_used:       string[]
  memories_formed:  number    // a verifier requires 0
  prompt_hash:      string    // hex SHA-256 of the UTF-8 bytes of the scope's task (deviation 2, §8)
  result_hash:      string    // hex SHA-256 of the UTF-8 bytes of result
  delegated_scope?: string    // a verifier requires it, within the tick's scope
  invocation_origin?: string
  suite:            string    // "motebit-jcs-ed25519-b64-v1"
  signature:        string    // canonical base64url
}
```

`delegation_receipts`, `relay_task_id`, `service_result_hash`, `source_digest`, `source_projection` and `source_projection_class` MUST be absent: they carry meaning a repo-change verifier does not judge.

### 3.5 — RepoChangeToolInvocationReceipt

#### Wire format (foundation law)

The profile of `ToolInvocationReceipt` a bundle carries, one per tool call of the run, signed by the agent.

```
RepoChangeToolInvocationReceipt {
  invocation_id:  string
  task_id:        string    // the run's task_id
  motebit_id:     string    // the agent
  public_key:     string    // REQUIRED; 64 lowercase hex
  device_id:      string
  tool_name:      string
  started_at:     number
  completed_at:   number
  status:         string    // "completed" | "failed" (the handler erred) | "denied" (the scope-built handler refused)
  args_hash:      string    // 64 lowercase hex
  result_hash:    string    // 64 lowercase hex
  invocation_origin?: string
  suite:          string    // "motebit-jcs-ed25519-b64-v1"
  signature:      string    // canonical base64url
}
```

### 3.6 — RepoChangeBundle

#### Wire format (foundation law)

Landed at `.motebit/bundles/<grant_id>.json`. Its bytes MUST be exactly the canonical JSON of this shape, with no other keys.

```
RepoChangeBundle {
  spec:           string                             // "motebit/repo-change-bundle@1.0"
  scope:          RepoTaskScope
  grant:          StandingDelegation                 // standing-delegation-v1 §3.1
  tick:           DelegationToken                    // standing-delegation-v1 §4; grant_id REQUIRED here
  tool_receipts:  RepoChangeToolInvocationReceipt[]  // at most 256
  receipt:        RepoChangeExecutionReceipt
}
```

The protocol types are `RepoTaskScope`, `RepoChangeEntry`, `RepoChangeResult`, `RepoChangeExecutionReceipt`, `RepoChangeToolInvocationReceipt` and `RepoChangeBundle` in `@motebit/protocol`; the zod schemas of the same names (suffixed `Schema`) in `@motebit/wire-schemas` derive the committed JSON Schemas. Two rules are cross-field and stated here rather than in the schemas: an object id's length is fixed by `object_format`, and `entries` are sorted by path.

## 4. Canonicality

Every value has one spelling, so one artifact cannot be spelled several ways. A verifier MUST treat any of the following as `integrity: "invalid"`:

- **base64url** — a signature `s` is canonical iff it is unpadded base64url and `toBase64Url(fromBase64Url(s)) === s`;
- **keys** — 64 lowercase hex;
- **digests** — lowercase hex of the declared length (64 for SHA-256), carried as `DigestRef` in the change record;
- **object ids** — `parent_commit`, `head_commit` and every entry's `blob` are lowercase hex of the scope's `object_format` length (40 for `sha1`, 64 for `sha256`);
- **modes** — six octal digits;
- **grant_id** — a lowercase UUID (`8-4-4-4-12` lowercase hex), so it is safe as the bundle's and a revocation's file name;
- **paths** — every `allowed_paths` entry and every recorded entry path is repository-relative, its segments joined by `/`, and every segment matches `[A-Za-z0-9._-]+` (ASCII only). No segment is empty, ends in `.` (so no `.`, `..`, `a.` or `.git.` — NTFS drops a trailing dot, which would make `a.` an alias of `a`), or is `.git` in any case; there is no backslash and no leading or trailing `/`. ASCII-only segments mean no Unicode case-fold or normalization alias (for example `ſ`, U+017F) can stand for another path on any filesystem;
- **lists** — `allowed_paths` and `tool_receipt_digests` have no repeats (`uniqueItems` in the committed schemas); recorded `entries` are strictly ascending by path bytes;
- **JSON** — the bundle bytes are exactly the canonical JSON of the bundle, and the receipt's `result` is exactly the canonical JSON of the change record.

Every path comparison anywhere is **byte-exact on git's own path bytes**, decoded strictly as UTF-8, with no other normalization.

## 5. The grant and the tick

The grant is a `StandingDelegation` from the principal to the agent with:

- `scope` ⊆ {`repo_read_blob`, `repo_write_path`}, written as those names comma-separated, each at most once, with no whitespace (a `RepoChangeTool` list);
- `subject = "repo-change"`;
- `subject_binding` to the scope's digest with `artifact_schema: "motebit.repo-task-scope.v1"`;
- no `spend_ceiling` — a repo-change grant moves no money;
- a lifetime `expires_at − start` of at most 24 hours (86 400 000 ms), where the grant's `start` is `max(issued_at, not_before ?? issued_at)`;
- `cadence_ms` ≥ the lifetime, so the grant can back one tick and no second.

**The authority window.** `verifyStandingDelegation` and `verifyDelegation` judge `not_before` and expiry; they do not bound a window from `issued_at`. A repo-change verifier therefore also requires, in every mode: the grant's `start` ≤ its `expires_at`, the tick's `start` (`max(issued_at, not_before ?? issued_at)`) ≤ its `expires_at`, and `grant.issued_at ≤ tick.issued_at`; and, whenever an evaluation time is accepted, `now ≥` the grant's `start` and `now ≥` the tick's `start`. So a future-dated grant or tick reads `not_yet_valid`, and a back-dated or inverted one reads `insufficient`, whatever its `max_token_ttl_ms`. An evaluation time that is not a finite number (absent, `NaN`, `±Infinity`) is no time: `authority` is `unknown`, never judged against a fallback clock.

**One grant backs at most one landing**, enforced by the spent rule (§7). The tick is one `DelegationToken` with `grant_id` (standing-delegation-v1 §4), signed by the principal, whose `scope` is a `RepoChangeTool` list and whose `expires_at ≤ grant.expires_at`.

## 6. Production (informative)

A run verifies the tick and grant at its local clock before its first model call and on every tool call; it offers the model exactly the tools the verified scope builds (`repo_read_blob` reads only blobs tracked at the tip; `repo_write_path` writes only the exact `allowed_paths` byte strings); it has no interior (no memory, skills, trust context or sync), so its receipt carries `memories_formed: 0`. Every tool call yields a `ToolInvocationReceipt` with its real status. The change is one non-merge commit on the tip; the bundle is one more commit adding exactly `.motebit/bundles/<grant_id>.json`.

## 7. Verification (foundation law)

The verifier core is a **pure function**: no git, no file I/O, no repository policy. Its caller supplies:

- the bundle bytes;
- the computed entries — for every path the change commit's tree differs from its parent's in, computed by listing both trees completely (never from `git diff`): kind (`add`, `modify`, `delete`; a rename is a `delete` plus an `add`), path bytes, mode, previous mode, blob, and whether the content contains a NUL byte;
- the paths tracked at the parent the change lands on;
- the pins, as `(motebit_id, public_key)` pairs by role;
- the path predicate, interpreted from data at the judged commit (§7.2);
- the strictly parsed revocations (file name = `grant_id`, canonical key and base64url, verifying signature) with their freshness and the files that failed;
- the spent status (the grant's bundle path ever existed on the judged first-parent history);
- the expected repository;
- the results of the mode's ancestry and shape checks (§9);
- the evaluation time (§9).

It returns `{verdict, outcome, diagnostics}`: a `VerificationVerdict` with `type: "repo_change"`; `outcome` = the receipt's `status`; and `diagnostics`, every failed rule with its repair code (and, when supplied, the commit the revocations were read at, because `RevocationFreshness.asOf` has no commit field). **Every failure lands on one of the verdict's four axes with a repo-change repair code**, so `isFullyVerified(verdict)` is false whenever any rule failed. The verdict's `repair` names the first failure in axis order (integrity, identityBinding, authority, revocation). A verifier records every axis even when an earlier one fails.

| Axis              | Fails (value) when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrity`       | `invalid` when any of these hold: any signature fails (grant, tick, receipt, any tool receipt); `result_hash` is not the digest of `result`; the scope does not match `subject_binding`; any value is non-canonical (§4); the bundle bytes are not the canonical JSON of its strict shape; the record is not the canonical JSON of its strict shape; the record's `grant_id`, grant, tick or scope digest, `repo` or `object_format` differ from the bundle's; `prompt_hash` is not the digest of the scope's `task`; the record's `tool_receipt_digests` **differ as a set** from the bundle's tool receipts, or either repeats one; a tool receipt's `task_id` differs from the receipt's; the mode's ancestry or shape check failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `identityBinding` | `invalid` when any rule of §2 fails; `pinned` (strict, §2) when all hold                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `authority`       | from `verifyDelegationTokenVerdict` over the tick and grant at the evaluation time (`expired`, `not_yet_valid`, `insufficient`); `not_yet_valid` also when the evaluation time precedes the grant's or the tick's start (§5); `unknown` when the evaluation time could not be accepted or is not a finite number (the tick is then still judged structurally); and **`insufficient`** when any of these hold: the tick outlives the grant, starts after it expires, or was issued before the grant; the grant starts after it expires; `subject_binding` is absent, or binds another `artifact_schema`; `subject` is not `"repo-change"`; the grant's or tick's scope is not a `RepoChangeTool` list; the lifetime exceeds 24 hours; a `spend_ceiling` is present; `cadence_ms` is less than the lifetime; the scope's `repo` ≠ the expected repository; the grant is spent; `delegated_scope` is absent or outside the tick's scope; `tools_used` names a tool outside the tick's scope; a tool receipt whose `status` is not `denied` names a `tool_name` outside the tick's scope; the set of `tools_used` differs from the set of `tool_name`s of the receipts that are not `denied`; `memories_formed` ≠ 0; an `allowed_paths` entry fails the predicate; **any change entry is outside the scope** (below); the recorded `entries` differ from the computed ones. A structural `insufficient` outranks a temporal value |
| `revocation`      | `revoked` when a strictly parsed revocation binds the grant (§2); `unchecked` when no revocation set was supplied, or any revocation file failed strict parsing (unless one binds the grant: `revoked` wins); otherwise `fresh`, with the caller's freshness. A malformed revocation never reads as "not revoked"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

A denied receipt may name any tool, so denial evidence stays valid. **The outcome is not authority:** a truthful `denied` or `failed` run has valid authority. A change is accepted only when the verdict is fully verified **and** `outcome == "completed"`.

A change entry is **outside the scope** (`executed ⊄ authorized`, standing-delegation-v1 §3.2) when any of these hold:

- it is not an add or modify (a deletion; a rename appears as a deletion plus an add);
- it is a symlink (`120000`), a submodule (`160000`), any other mode than `100644`, or a mode change;
- its content contains a NUL byte;
- it collides by case with another path in the case index of (tracked ∪ changed paths), comparing the path and every directory prefix under a Unicode case fold at least as strong as NFKC plus case mapping; a tracked path that is not valid UTF-8 fails this rule closed, since no collision with it can be ruled out;
- its path bytes are not byte-equal to an `allowed_paths` entry, or its path is not valid UTF-8 or fails the predicate;
- there are more entries than `max_changed_files`.

### 7.1 Repair codes

Each failed rule carries exactly one code from the closed list `ALL_REPO_CHANGE_REPAIR_CODES` (`RepoChangeRepairCode` in `@motebit/protocol`). The prefix names the axis (`identity` for `identityBinding`, as in the existing verdict codes); a code's meaning never changes, and new codes are appended.

| Axis              | Codes (`<prefix>.repo_change.<rule>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrity`       | `bundle_malformed`, `bundle_not_canonical`, `value_not_canonical`, `signature_invalid`, `result_hash_mismatch`, `result_malformed`, `result_not_canonical`, `scope_binding_mismatch`, `grant_id_mismatch`, `grant_digest_mismatch`, `tick_digest_mismatch`, `scope_digest_mismatch`, `scope_reference_mismatch`, `prompt_hash_mismatch`, `tool_receipts_mismatch`, `task_id_mismatch`, `shape_check_failed`                                                                                                                                                                                                                                                                                                                                               |
| `identityBinding` | `delegator_not_principal`, `delegate_not_agent`, `delegator_is_delegate`, `signer_not_delegate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `authority`       | `tick_expired`, `tick_not_yet_valid`, `tick_insufficient`, `tick_outlives_grant`, `time_unavailable`, `subject_binding_absent`, `subject_binding_wrong_schema`, `subject_wrong`, `scope_tools_outside`, `lifetime_exceeded`, `spend_ceiling_present`, `cadence_below_lifetime`, `repo_mismatch`, `grant_spent`, `delegated_scope_outside`, `tools_used_outside`, `tool_receipt_outside_scope`, `tools_used_mismatch`, `memories_formed`, `scope_path_not_permitted`, `entry_not_add_or_modify`, `entry_symlink`, `entry_submodule`, `entry_mode`, `entry_binary`, `entry_case_collision`, `entry_path_not_allowed`, `entry_path_not_permitted`, `entries_exceed_max`, `entries_mismatch`, `grant_not_yet_valid`, `window_inverted`, `tick_predates_grant` |
| `revocation`      | `revoked`, `unchecked`, `set_malformed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 7.2 The path predicate (foundation law)

The path predicate is data: the file `.motebit/repo-path-policy.json` at the judged commit, `motebit/repo-path-policy@1.0`. A caller MUST parse it strictly, and a caller that cannot parse it MUST NOT supply a predicate, so the change is not judged (the reference interpreter throws).

**File.** UTF-8 JSON, exactly the object `{"spec": "motebit/repo-path-policy@1.0", "include": [...], "exclude": [...]}`: all three keys and no other, `spec` exactly that string, and each list an array of strings, with no repeats, each one a pattern in the grammar below. Anything else is a parse error.

**Grammar.**

```
pattern = segment *( "/" segment )
segment = "**" / glob
glob    = 1*( char / "*" )
char    = "A"-"Z" / "a"-"z" / "0"-"9" / "." / "_" / "-"
```

A glob has no two `*` in a row and is not `.` or `..`. No two `**` segments are adjacent, and a pattern is not `**` alone. A pattern matches from the repository root; a leading `**` segment is how it matches at any depth.

**Matching.** A path is split at every `/` into segments (an empty segment is a segment like any other). A pattern matches a path when its segments match the path's segments in order:

- a glob matches one segment: `*` matches any run of characters, possibly empty, and every other character matches itself;
- a `**` segment that is not the last matches zero or more segments; a last `**` matches one or more.

An **include** matches exactly the paths its pattern matches, in their own case, and never a path beneath one: an include names files. An **exclude** matches the paths its pattern matches and every path that is one of them followed by `/` and at least one more character, comparing with the ASCII letters `A`–`Z` and `a`–`z` folded to one case (no other folding or normalization). A path that an exclude matches only once case is folded differs only by case from an excluded path, and a consumer MAY treat it as a case collision. A path is **permitted** iff it contains no LF, CR, U+2028 or U+2029, some include matches it, and no exclude matches it.

Reference interpreter: `parseRepoPathPolicy`, `isRepoPathPermitted` and `repoPathExclusion` in `@motebit/verifier`.

## 8. Declared deviations

1. **The change record is the `result` for every status.** [`execution-ledger-v1.md`](execution-ledger-v1.md) §11.1 gives `result` as the task output when `completed` and an error message when `failed` or `denied`. A repo-change receipt carries the canonical-JSON change record for every status, so a denial or failure still names the grant, tick, scope and entries it concerns.
2. **`prompt_hash` is defined.** It is hex SHA-256 of the UTF-8 bytes of the scope's `task` string — the prompt the run starts from — not of a runtime-assembled prompt.
3. **`pinned` is strict.** Here `pinned` means byte-equality with the current `(motebit_id, public_key)` pair in the role file at the judged commit (§2), never a key that was valid in a succession chain at a time an artifact names. It is narrower than [`terminology-v1.md`](terminology-v1.md) §10.1 and never wider.

## 9. Modes and time

| Mode                       | Ancestry and shape checks (into `integrity`)                                                                                                                                                                                                                                                                                                                                                                                                             | Pins, revocations, spent                                                                                                                                                                          | Time                                                                                                                                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CI on a pull request       | `parent_commit` is the current tip of `main`; the pull request is exactly the change commit and the bundle commit, linear; `head_commit..pr_head` is exactly one `A 100644` entry at `.motebit/bundles/<grant_id>.json`; base ref is `main`; the publisher is the expected account; the expected repository is the CI repository; no entry modifies or deletes anything under `.motebit/bundles/`. Every axis is still computed when a shape check fails | Read at the tip of `main`. Spent iff that bundle path ever existed on `main`'s first-parent history, so deleting a bundle never un-spends a grant. Revocation freshness `asserted`, as of the tip | The runner's clock: `temporalBasis: "local_clock"`                                                                                                                                                                                                                                                                 |
| Offline on a landed change | The squash commit has exactly one parent, and its entries are exactly one `A 100644` at `.motebit/bundles/<grant_id>.json` plus entries equal to the recorded `entries`; `parent_commit` is a first-parent ancestor of the squash commit's parent; the squash commit is on the first-parent chain of a **trusted tip of `main`** the caller supplies                                                                                                     | At the squash commit's parent. Spent iff that bundle path ever existed on the parent's first-parent history. Revocation freshness `asserted`, as of that parent                                   | The squash commit's committer time, accepted only when the committer is the hosting operator and the commit's signature verifies under a pinned set of that operator's signing keys: `temporalBasis: "operator_recorded"`. If the time cannot be accepted, `authority` is `unknown` and the change does not verify |

**`operator_recorded` is a `TemporalBasis` value**, appended to that agility axis by this spec. It is neither `local_clock` (the verifier's own clock) nor `ledger_anchored` (a chain ordering): it is a wall-clock time an operator recorded and signed, accepted only under a pinned key of that operator, and a consumer weighs it as the operator's word. No existing value changes meaning.

## 10. Security considerations

- **Custody, not immutability.** The protected branch is a custody and enforcement boundary. A rewrite of its history (dropping or reordering a record against a revocation) is detectable only against an independent witness of its tip; every motebit signature in every bundle still verifies, so no forged change passes.
- **Replay.** A grant is spent once its bundle is on the judged history. Two changes under one grant add the same bundle path with different bytes, so git refuses to merge the second.
- **Git object lookups are not trusted offline.** A caller computing entries reads raw objects, re-hashes each against its id, parses trees itself and refuses malformed ones, with replace objects, grafts and commit-graph disabled; it never takes entries from `git diff`.
- **The predicate is data.** A verifier never executes repository code to obtain the path predicate; it interprets a data file read at the judged commit (§7.2).

## 11. Relationship to other specs

- [`standing-delegation-v1.md`](standing-delegation-v1.md) — the grant, the tick, `subject_binding`, revocation binding.
- [`execution-ledger-v1.md`](execution-ledger-v1.md) — `ExecutionReceipt` and `ToolInvocationReceipt`, profiled here.
- [`evidence-provenance-v1.md`](evidence-provenance-v1.md) — `DigestRef`.
- [`terminology-v1.md`](terminology-v1.md) — the terms admitted for this spec.
