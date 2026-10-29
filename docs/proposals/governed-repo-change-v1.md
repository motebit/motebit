# Governed repo change (design, milestone B)

**Target invariant:** for one repository change made by an agent, an independent party holding a clone of the repository and an offline verifier can establish **which agent acted, under whose authority, within what limits, with what outcome**, and that the commit that landed on `main` is that outcome. GitHub's check judges the same chain as of each PR event, so its result can be stale; only the offline verdict judges the landed commit. Judging the integration commit in the merge queue is the contract step's. The model that wrote the change can be swapped without changing any of that.

**What B adds and what it does not.** B adds evidence and a verifier. It adds **no merge authority**: a governed change still merges only under the existing tier rules ([`repo-autonomy-v1.md`](repo-autonomy-v1.md)), and `AUTONOMY_T0` stays `off`. Denial, tampering, restart and revocation tests are milestone C; this design must not preclude them. OAuth/OIDC/SPIFFE adapters are milestone D. Alignment with NIST's design tenets is mapped below as evidence and gaps, never as a compliance claim ([`nist-alignment.md`](../doctrine/nist-alignment.md)).

## The organizing choice: protected `main` is the custody boundary

Every time-dependent question is answered from the history of the protected branch, never from a clock or claim of the agent's:

- **Pins:** the founder's key and the agent's key are role-typed files on `main`. Eligibility is judged against the pins at the commit being judged.
- **Spent:** a grant is spent once its bundle file exists on `main`.
- **Revocation:** a revocation counts from the commit that landed it on `main`, not from the time its signer wrote into it.
- **Landing:** the evidence lands in the same squash commit as the change, so a clone holds everything.

This is a **custody and enforcement boundary, not proof of immutability.** The trust assumptions:

- `main-protection` has an empty bypass list, so nobody can force-push through it. An organization owner can still edit or disable the ruleset, and GitHub as operator can do anything.
- Squash commits on `main` are signed by GitHub with GitHub as committer. Their committer time is when the merge queue built the commit, shortly before it landed (seen on `c1ece413c`, `ef7891111`, `80419ae49` and `707c490b8`). GitHub's commit-signing key is shared across GitHub, so a signature proves GitHub made the commit object, not that it is on `main`. That assurance comes only from the verifier's trusted tip (below).
- A rewrite can drop or reorder history. That is detectable **only against an independent witness**: an earlier clone, a mirror, or an external commitment to `main`'s tip.
- What survives a compromised administrator: every motebit signature in every bundle still verifies, so no forged change passes. What does not survive: hiding a record, or reordering a record against a revocation, without a witness. An independent witness of `main` is listed as a gap for C.

## What the repo already has

| Need                           | Existing primitive                                                                                                                                                                                                                                                                              | Gap                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                       | Ed25519 identity, `motebit.md`, `motebit verify`, the `packages/github-action` check                                                                                                                                                                                                            | Nothing binds the GitHub account `motebit-agent` to a motebit key                                                                                                                                                                                                                                                                                                                 |
| Scoped, time-limited authority | `StandingDelegation` with `subject_binding` ([`spec/standing-delegation-v1.md`](../../spec/standing-delegation-v1.md) §3.1–3.2), per-tick `DelegationToken` (§4), `verifySubjectBinding(binding, artifact)`, `DelegationRevocation` and its key-bound consumer check `findGrantRevocation` (§5) | `motebit grant` mints only self-delegated money grants. The wire law says revocation keys are lowercase 64-hex, but a non-canonical key still passes `verifyDelegationRevocation` and can be cached by the relay, while no verifier ever binds it to a grant: a revocation that looks accepted and does nothing. Rejecting non-canonical keys as malformed is its own PR (step 0) |
| Authority verdict              | `verifyDelegationTokenVerdict(token, grant, {revocations, revocationFreshness, now, temporalMode})` returns a `VerificationVerdict`                                                                                                                                                             | Not wired to any repo flow; its repair texts cover signature, ceiling, expiry, activation and revocation failures, none of them repo-change failures                                                                                                                                                                                                                              |
| Signed outcome                 | `ExecutionReceipt`: `status` is `completed`, `failed` or `denied`; `delegated_scope`, `tools_used`, `memories_formed`, signed `result`                                                                                                                                                          | No CLI path produces one for an owner-run task                                                                                                                                                                                                                                                                                                                                    |
| Record of each tool call       | `ToolInvocationReceipt`, `status` is `completed`, `failed` or `denied`                                                                                                                                                                                                                          | On the AI-loop path the runtime signs every finished call, thrown ones included, as `completed` (`invokeCapability` signs `failed` correctly); policy-denied calls get none; receipts sit in the runtime's 50-entry buffer (`RECEIPTS_BUFFER_CAP`) and are lost at exit                                                                                                           |
| Digests                        | `DigestRef` (`{algorithm, value}`)                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                 |
| Inert-path rules               | `classifyDiff`, `isAllowlisted`, `caseCollision`, `caseIndex` in [`scripts/classify-autonomy-tier.ts`](../../scripts/classify-autonomy-tier.ts)                                                                                                                                                 | Repo policy, in code; B moves the allowlist to data the verifier interprets (below)                                                                                                                                                                                                                                                                                               |
| External enforcement           | `autonomy-tier` required check, merge queue (squash)                                                                                                                                                                                                                                            | No check verifies motebit artifacts beyond `motebit.md`                                                                                                                                                                                                                                                                                                                           |

Three shipped paths are deliberately **not** reused:

- `verifyGrantForTurn` / `TurnContext.verifiedGrant` require delegator = this runtime and exist for money ([`memory-never-confers-authority.md`](../doctrine/memory-never-confers-authority.md)). B touches neither.
- The policy gate's `pathAllowList` is a lexical prefix match (`policy-gate.ts`, step 4), and B never relies on it.
- The builtin `read_file` and `write_file` tools are filesystem tools. B's tools have their own names, so a builtin cannot stand in for one.

**Why an `ExecutionReceipt`.** The spec says each tick of a standing delegation produces an `ExecutionReceipt` that references the tick and `grant_id` (§2, §4). Its `denied` and `failed` statuses are what C needs. The references travel inside its signed `result`.

**New wire artifacts.** B specifies these, and they ship as protocol in build step 1:

- the scope `motebit/repo-task-scope@1.0`;
- the change record `motebit/repo-change@1.0`;
- the bundle;
- one `VerdictSubject` value;
- repair codes for the repo-change failures.

The published Apache-2.0 `@motebit/verifier` will verify them, so they get a spec (`spec/repo-change-v1.md`), committed JSON Schemas, terminology entries and a minor version bump under `check-api-surface`. The spec also records three deviations:

- the change record is the receipt's `result` for every status, where `spec/execution-ledger-v1.md` §11.1 gives an error message for `failed`/`denied`;
- `prompt_hash` is defined below;
- B's `pinned` is the strict form defined below.

A `TemporalBasis` value for operator-recorded time may also be needed (see Time); it would be an append to an agility axis, which is again a wire-schema change. No existing field changes meaning.

## Roles

| Role      | Who                                                           | Holds                   | Signs                                                   |
| --------- | ------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Principal | the founder, motebit identity **F**, on the founder's machine | F's key                 | the grant, the scope (by digest), the tick, revocations |
| Agent     | a new motebit identity **A** that runs the task               | A's key, nothing of F's | tool receipts, the execution receipt                    |
| Publisher | GitHub account `motebit-agent`                                | the PR credential only  | nothing motebit; it pushes and opens the PR             |
| Verifier  | GitHub Actions, running code from the protected base tip      | nothing                 | nothing; it reports a check                             |
| Approver  | unchanged: the founder                                        |                         | the GitHub review                                       |

**Pins, typed by role.** All pins live under `.motebit/principals/`, owned in `CODEOWNERS` and changed only by founder-approved T1 PRs:

- `.motebit/principals/principal.md` holds F's identity file;
- `.motebit/principals/agents/<name>.md` holds each agent's identity file.

The binding rules are:

- the delegator must be the principal pin;
- the delegate must be an agent pin;
- delegator ≠ delegate;
- every receipt's signer must equal `grant.delegate_public_key`, which must equal the tick's delegate.

"Pinned" here is **strict**: byte-equality with the current `(motebit_id, public_key)` pair in the role file at the commit being judged, matched against the artifact's id and key together. It never uses a time-windowed key check (`verifyKeyBindingAtTime`) with a time taken from an artifact. A rotated-out key therefore stops authorizing new changes at once, whatever commit a PR is built on, and so do live grants it signed. That is the rule in [`memory-never-confers-authority.md`](../doctrine/memory-never-confers-authority.md) that authority flows forward across rotation, never back. It is narrower than `pinned` in [`spec/terminology-v1.md`](../../spec/terminology-v1.md) §10.1, and the terminology entry records that.

**Revocations on `main`.** `.motebit/revocations/<grant_id>.json` holds a `DelegationRevocation`, landed by a founder-approved T1 PR. Revocations are parsed strictly:

- the file name must equal the revocation's `grant_id`;
- keys must be lowercase 64-hex, and base64url must be canonical;
- the signature must verify.

Any file under that directory that fails any of these makes `revocation` **`unchecked`**, never `fresh`, so a malformed revocation can never be silently ignored. Authority over a grant is then decided per grant by the §5 binding (`findGrantRevocation`: same `grant_id`, revocation key equal to the grant's delegator key), never by the current principal pin. So revocations signed before the founder rotates stay valid evidence, and a well-formed revocation under some other key cannot revoke a principal's grant.

## The chain

1. **Scope** (founder-authored, detached): JSON with `schema: "motebit.repo-task-scope.v1"` (the field `verifySubjectBinding` reads) and `{spec: "motebit/repo-task-scope@1.0", repo, base_ref: "main", object_format: "sha1", allowed_paths[], max_changed_files, task}`.
   - Every `allowed_paths` entry is canonical:
     - every segment matches `[A-Za-z0-9._-]+` (ASCII only), so no Unicode case-fold or normalization alias such as `ſ` (U+017F) can stand for an excluded path, on any filesystem;
     - repository-relative, with no empty, `.` or `..` segment, no `.git` segment in any case, no backslash and no leading `/`.
   - Every entry passes the repo's path predicate.
   - Every comparison anywhere is **byte-exact on git's own path bytes**, decoded strictly, with no other normalization.
2. **Grant** (F signs): a `StandingDelegation` from F to A with:
   - `scope` ⊆ {`repo_read_blob`, `repo_write_path`};
   - `subject = "repo-change"`;
   - `subject_binding` to the scope's digest, with `artifact_schema: "motebit.repo-task-scope.v1"`;
   - no `spend_ceiling`;
   - a lifetime of at most 24 hours;
   - `cadence_ms` equal to the lifetime.

   The verifier enforces every one of these (the `authority` row). **One grant backs at most one landing**, enforced by the spent rule.

3. **Tick** (F signs, pre-minted): one `DelegationToken` with `grant_id` (§4) and `expires_at ≤ grant.expires_at`.
4. **Run** (A, any provider): `motebit repo-task run`.
   - **Before the first model call it checks, failing closed:**
     - the authority verdict of the tick and grant is `valid` at the local clock;
     - every grant rule above holds;
     - the revocations at the tip are parsed strictly and none revokes the grant;
     - the delegator is the principal pin at the tip, and A is the delegate;
     - the scope matches the binding;
     - every path is canonical and passes the predicate;
     - every key, digest and base64url value is canonical;
     - the worktree is clean at the tip.
   - **Interior: none.** The run uses an ephemeral in-memory storage adapter. It never reads `~/.motebit/config.json`: the personality is the default, and session-state facets, first-conversation and activation prompts are off, floored as foreign turns are. It loads no skills, recalls no memories, forms none, adds no trust context, does not sync, and runs no proactive cycle. Its receipt carries `memories_formed: 0`, which the verifier requires. The system prompt is a pure function of the scope, `runtime_version` and model, and its digest is recorded (`system_prompt_digest`). So nothing from the host, and nothing from an earlier run, reaches the model's context.
   - **Tools: exactly two, frozen.** The turn's tools are built **from the verified scope only**, under their own names. No MCP servers, delegation tools, builtin tools, `governance` config or `mcp_servers` config are loaded. The registry is frozen after construction, and on every model call the runtime asserts that the offered tools are exactly the scope's, by handler identity, not by name.
   - **`repo_read_blob`** returns only blobs tracked at the tip, through `git cat-file` against the tip's tree. Gitlinks, symlinks and anything outside that tree are refused. It never reads the filesystem.
   - **`repo_write_path`** is a handler closed over the exact `allowed_paths` byte strings. It refuses any other string, any allowed path that collides by case with a tracked path or another allowed path (the verifier's case rule), a tracked path that is not a regular 100644 file, content with a NUL byte, and a write past `max_changed_files`. It then stores the content as a blob in git's object store (`git hash-object -w`) and records `path → {100644, blob}`. **The worktree filesystem is never written.**
     - _Amended 2026-10-29 (build step 2, cold review round 3)._ The design first said the handler "refuses a path with a symlink component, and writes by the real path inside the worktree". A path-based writer cannot keep that promise in Node, which has no `openat`: a two-swap race (swap a directory for a symlink, open, swap back, pass the checks) escaped the worktree 23 times in 478k attempts with an atomic rename. No re-check closes a race on a path the writer does not hold, so the write no longer goes through a filesystem path at all.
   - **Every call re-runs the full authority check:** the tick against the grant, with expiry, and the revocations read at preflight. Continuous re-reading of revocations during the run is C's.
   - **The run's policy** is fixed by the command and ignores the user's governance config.
   - **Receipts.** Every tool call yields a `ToolInvocationReceipt` signed by A, carrying the run's fresh `task_id` and one of these statuses:
     - `completed`;
     - `failed` when the handler errs;
     - `denied` when the scope-built handler refuses (that handler is the policy boundary for this run).
5. **Change commit** (the harness, outside the model): one non-merge commit on the tip `parent_sha`, giving `head_sha`. _Amended 2026-10-29:_ it is built from the staged blobs on a private index (`GIT_INDEX_FILE` in an owner-only temporary directory): `read-tree <tip>`, `update-index -z --index-info` with every path on stdin as exact bytes (never an argument, so never shell-, glob- or option-interpreted), `write-tree`, `commit-tree -p <tip>`. No worktree file, repository index or ref is touched; the entries are what `git diff-tree` reports against the tip. The run's "worktree is clean" preflight still holds, and the worktree stays as it was.
6. **Outcome** (A signs): an `ExecutionReceipt` with:
   - `status`;
   - `motebit_id` and `public_key` = A;
   - `delegated_scope` = the tick's scope;
   - `tools_used` ⊆ that scope;
   - `memories_formed: 0`;
   - `prompt_hash` = SHA-256 of the scope's `task` string, the prompt the run starts from;
   - `result` = canonical JSON `{spec: "motebit/repo-change@1.0", grant_id, grant_digest, tick_digest, scope_digest, repo, object_format, parent_commit, head_commit, entries[], tool_receipt_digests[], system_prompt_digest, provider, model, runtime_version}`.

   Here:
   - every digest is a `DigestRef`;
   - commit ids are lowercase hex in the scope's `object_format`;
   - `entries[]` is the sorted list of `{path, mode, blob}` that the change adds or modifies.

7. **Bundle commit** (the harness): one more commit on `head_commit` that adds exactly one file, `.motebit/bundles/<grant_id>.json`. Its bytes are exactly the canonical JSON of `{spec, scope, grant, tick, tool_receipts[], receipt}`, with no other keys and at most 256 receipts. Squash-merging lands the change and its evidence as one commit.

## The verifier

**Computing entries.** Entries are never taken from `git diff`. The verifier lists both trees completely (`git ls-tree -r -z --full-tree`) and compares them in-process. The git process runs against a bare or `--git-dir` repository with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`. So no `.gitmodules`, attribute or config file can hide an entry, including a submodule. In CI the bare repository is fetched with explicit refspecs and `fetch.fsckObjects=true`.

**Offline, git's object lookups are not trusted at all.** Replace refs (copied by `clone --mirror`), grafts and a forged commit-graph can make git report a tree or a parent that is not the real one. So the offline verifier reads raw objects with `git cat-file --batch` from the trusted tip downward, **re-hashes every object in-process against its id**, and parses parents and tree entries itself, refusing malformed trees (an entry name containing `/`, duplicate names). It also sets `GIT_NO_REPLACE_OBJECTS=1`, `GIT_GRAFT_FILE=/dev/null` and `core.commitGraph=false`, and refuses a shallow repository.

**The core** is a pure function in `@motebit/verifier`, with no git or file I/O and no repo policy. Its caller supplies:

- the bundle;
- the computed entries (mode, kind, path bytes, blob, contains-NUL flag);
- the tracked paths at the parent the change lands on (in CI the tip of `main`; offline the squash commit's parent);
- the pins;
- the path predicate;
- the strictly parsed revocations and their freshness;
- the spent status;
- the expected repository;
- the results of the mode's ancestry and shape checks;
- the evaluation time.

`motebit-verify repo-change` (in `@motebit/verify`) and the CI script compute these inputs.

**Canonicality.** Every base64url value must be canonical (`toBase64Url(fromBase64Url(s)) === s`), and every key and digest lowercase hex of its declared length. That stops one artifact being spelled several ways.

**What it returns:** `{verdict, outcome, diagnostics}`.

- **`verdict`** is a `VerificationVerdict`. **Every failure lands in one of its four axes**, with a repo-change repair code, so `isFullyVerified` covers it, and nothing reads as fully verified while any check failed.
- **`outcome`** is the receipt's `status`.
- **`diagnostics`** says which rule failed.

| Axis              | Fails (value) when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrity`       | `invalid` when any of these hold: any signature fails; the scope does not match `subject_binding`; any value is non-canonical; the bundle bytes are not the canonical JSON of its strict shape; the record's digests differ from the bundle's grant, tick or scope; the record's `tool_receipt_digests` **differ as a set** from the bundle's receipts; a receipt's `task_id` differs from the run's; the mode's ancestry or shape check failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `identityBinding` | `invalid` when any of these hold: the delegator is not the principal pin; the delegate is not an agent pin; delegator = delegate; a receipt's signer, `motebit_id` or `public_key` differs from the grant's delegate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `authority`       | from `verifyDelegationTokenVerdict` over the tick and grant (`expired`, `not_yet_valid`, `insufficient`), and also **`insufficient`** when any of these hold: `subject_binding` is absent, or has the wrong schema or subject; the scope's tools are outside {`repo_read_blob`, `repo_write_path`}; the grant lifetime exceeds 24 hours; a `spend_ceiling` is present; `cadence_ms` is less than the lifetime; `repo` ≠ the expected repository; the grant is already spent; `delegated_scope` or `tools_used` is outside the scope; any tool receipt whose `status` is not `denied` names a `tool_name` outside the tick's scope; `tools_used` differs from the set of `tool_name`s in the receipts that are not `denied` (denied receipts may name anything, so C's denial evidence stays valid); `memories_formed` ≠ 0; **any change entry is outside the scope** (see below); the recorded `entries[]` differ from the computed ones |
| `revocation`      | `revoked` when a strictly parsed revocation of the grant is present at the judged commit; `unchecked` when no revocation set was supplied, or any file under `.motebit/revocations/` failed strict parsing. Never reads as "not revoked"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A change entry is outside the scope (`executed ⊄ authorized`, §3.2) when any of these hold:

- it is not a `100644` add or modify;
- it contains a NUL byte;
- it is a rename, deletion, symlink, submodule or mode change;
- it collides by case with another path in `caseIndex(tracked ∪ changed)`;
- its path is not byte-equal to an `allowed_paths` entry, or fails the predicate;
- there are more entries than `max_changed_files`.

**The outcome is not authority.** A truthful `denied` or `failed` run has valid authority. CI requires a fully verified verdict **and** `outcome == "completed"`. So C's denial evidence reads as a denial, not as an authority failure.

**Modes.**

| Mode                       | Ancestry and shape checks (into `integrity`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Pins, revocations, spent                                                                                                                                                                          | Time                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI on a PR                 | <ul><li>`parent_commit` is the current tip of `main`</li><li>the PR is exactly the change commit and the bundle commit, linear</li><li>`head_commit..pr_head` is exactly one `A 100644` entry at `.motebit/bundles/<grant_id>.json`</li><li>base ref is `main`</li><li>PR author is `motebit-agent`</li><li>expected repository = `github.repository`</li><li>no entry modifies or deletes anything under `.motebit/bundles/`</li></ul>CI **computes and records every axis** even when a shape check fails | Read at the tip of `main`. Spent iff that bundle path ever existed on `main`'s first-parent history, so deleting a bundle never un-spends a grant. Revocation freshness `asserted`, as of the tip | The runner's clock (`local_clock`), recorded in the check summary                                                                                                                                                                                                                                                                                                                                                                                                            |
| Offline on a landed change | <ul><li>the squash commit has exactly one parent, and its entries are exactly one `A 100644` at `.motebit/bundles/<grant_id>.json` plus entries equal to the recorded `entries[]`</li><li>`parent_commit` is a first-parent ancestor of the squash commit's parent</li><li>the squash commit is on the first-parent chain of a **trusted tip of `main`** the caller supplies, with the expected repository</li></ul>                                                                                        | At the squash commit's parent. Spent iff that bundle path ever existed on the parent's first-parent history. Revocation freshness `asserted`, as of that parent                                   | The squash commit's committer time, accepted only when the committer is GitHub and the commit's OpenPGP signature verifies under a pinned set of GitHub signing keys (a set, since GitHub has rotated its key; landed in `.motebit/principals/` by a founder-approved PR). If the time cannot be accepted, `authority` is `unknown` and the change does not verify: operator-recorded time, declared in build step 1 as a new `TemporalBasis` value or as a stated deviation |

**The path predicate is data, not code.** The T0 allowlist moves from code to a data file at the commit being judged (the classifier's `ALLOWLIST` patterns as JSON, in a fixed pattern language), which the classifier and the verifier both interpret. The published verifier therefore never executes repository code to get the predicate. The data file is owned in `CODEOWNERS` and outside the allowlist, so widening it is always a T1 change. CI reads it at the tip of `main`, never from the PR; offline reads it at the squash commit's parent. Revocation freshness records its as-of point as a timestamp; the commit it was read at goes in `diagnostics`, because `RevocationFreshness.asOf` has no commit field.

**Replay.** A grant is spent once its bundle file is on `main`. Two PRs with one grant add the same path with different bytes, so git refuses to merge the second. In the contract step, a `merge_group` mode would also see the first bundle on the queue's base.

## External enforcement

`governed-change.yml` runs on `pull_request_target` (`opened`, `edited`, `synchronize`, `reopened`, `ready_for_review`) for base ref `main`. It mirrors `autonomy-tier.yml`: a trusted base checkout, the PR's commits as fetched objects in a bare repository only, permissions `contents: read` and `pull-requests: read`. It reports `governed-change` on the PR head, with every axis in the summary.

Rollout is expand → verify → contract:

- **Expand:** the check runs on `pull_request_target` only. It is not required, and the tier verdict ignores it. A result reflects the PR as of its last event, and can be stale. It does **not** run on `merge_group`: on that event the workflow file comes from the queue commit, which a queued PR can change, and the base can be a queue entry not yet on `main` (the limitation `autonomy-tier.yml` documents). Running there needs its own mode, with policy and inputs from a `merge_group.base_sha` that must be on `main` or the run fails closed, so it belongs to the contract design.
- **Verify:** acceptance tests B1–B6 pass live.
- **Contract (a founder decision, after C, in its own reviewed design):** make the check required, decide how a ruleset-required check treats PRs not published by `motebit-agent`, and decide whether a passing check lets `.motebit/bundles/` sit beside a T0 change.

`.motebit/` is outside the T0 allowlist, so every governed PR in B is T1 and needs the founder's approval.

## NIST design tenets: evidence and gaps

NIST proposed ten design tenets for agent identity management systems on 2026-10-27 ([source](https://www.nist.gov/blogs/cybersecurity-insights/design-tenets-agent-identity-management-systems)). This is a map of evidence, not a compliance claim. The levels are the ledger's ([`milestone-ledger.md`](../ops/milestone-ledger.md)):

- **implemented**: the code is on `main`;
- **tested internally**: tests, tampers or unbriefed cold reviews by the operator;
- **operationally demonstrated**: observed live and recorded with run ids;
- **independently verified**: checked by a party outside the operator (milestone F).

"—" means none of these has been reached.

| #   | Tenet (paraphrased)                                                                       | Motebit mechanism                                                                                                                         | B's evidence                                                                              | Today → after B                                                                                                                 | Remaining gap                                                             |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Distinct, cryptographically verifiable agent identity, bound to an approved configuration | Ed25519 identity; role-typed pin of A                                                                                                     | `identityBinding`; B4                                                                     | implemented → operationally demonstrated                                                                                        | Binding to an approved runtime configuration: — (C)                       |
| 2   | Linked to its originator; authority attenuates                                            | `StandingDelegation` F→A, tick scope ⊆ grant                                                                                              | `authority`, `identityBinding`; B1                                                        | implemented → operationally demonstrated                                                                                        | Multi-hop attenuation in a repo flow: not exercised                       |
| 3   | Least privilege, zero standing privilege                                                  | A two-tool scope, one landing per grant, a 24-hour lifetime the verifier enforces, `repo_read_blob` limited to tracked blobs, no interior | `authority`; B3, B5b; run-bound tests                                                     | implemented for tokens → verifier side operationally demonstrated; run bounds tested internally                                 | The `motebit-agent` GitHub credential is standing privilege (C)           |
| 4   | Short-lived, revocable authorization checked at runtime                                   | Expiry re-checked per call; strictly parsed revocations on `main`                                                                         | `revocation`; B6                                                                          | implemented → verdicts observed live with run ids; B's check enforces nothing until the contract step                           | Revocation during a run, cascade revocation, continuous authorization (C) |
| 5   | Human review at risk thresholds                                                           | Tier rules; founder approval on T1                                                                                                        | A's matrix; B1 merged on founder approval                                                 | operationally demonstrated (A)                                                                                                  | Run-time risk thresholds inside the agent: not in B                       |
| 6   | Signed mandates setting outcome and limits                                                | Founder-signed scope bound into the grant                                                                                                 | `integrity`, `authority`; B1, B3                                                          | implemented → operationally demonstrated                                                                                        | —                                                                         |
| 7   | Policy separate from reasoning                                                            | Tools built from the verified scope and frozen; policy fixed by the command                                                               | run-bound tests                                                                           | doctrine and the policy gate implemented → tested internally                                                                    | A live run whose model attempts an out-of-scope write: C                  |
| 8   | Deterministic access decisions                                                            | The policy gate today; byte-exact path rules and a pure verifier in B                                                                     | Every axis; tamper tests                                                                  | implemented (policy gate) → verifier verdicts observed live with run ids; the verifier enforces nothing until the contract step | —                                                                         |
| 9   | Continuous monitoring of agent behaviour                                                  | Audit hash chain only                                                                                                                     | none                                                                                      | —                                                                                                                               | Agent-specific risk signals with policy outcomes (C)                      |
| 10  | Tamper-evident evidence kept apart from the agent                                         | Signed receipts; bundle custody on protected `main`                                                                                       | B1's offline verification, run in a recorded workflow job with no network after the clone | implemented for signing (receipts are lost at exit today) → operationally demonstrated                                          | Independent witness of `main` (C); independently verified only at F       |

## Founder decisions

1. **Writes without a per-write approval.** In `motebit repo-task run` the agent writes without being asked each time. The bound is the founder's signed scope, enforced by the handler built from it. The grant is the founder's decision in advance.
   - **(a) Recommended:** as described.
   - **(b)** Each write also requires a live `ApprovalDecision` signed by the founder's device as the consent root. That adds per-write consent evidence (tenet 5), and the run cannot proceed unattended.
2. **Authorize two key operations:** generating identity A on the agent machine, and the founder signing the first grant with F. The agent never holds F's key.
3. **The first task:** a small fix to one existing file that passes `isAllowlisted`.

## Acceptance tests

| Id  | Setup                                                                                                                                             | Expected                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | governed change, provider 1                                                                                                                       | `governed-change` PASS, fully verified, outcome `completed`; merged under the tier rules **before the tick expires** (the landing is judged at the squash commit's time); then offline PASS on a fresh clone against a trusted tip, in a recorded workflow job with no network after the clone |
| B2  | a new grant, the same task, provider 2                                                                                                            | PASS; the two records differ only in run-specific fields                                                                                                                                                                                                                                       |
| B3  | a change touching a path outside `allowed_paths` (hand-built, since a real run's handler refuses it)                                              | FAIL, `authority: insufficient`                                                                                                                                                                                                                                                                |
| B4  | a bundle signed by a key other than the grant's delegate                                                                                          | FAIL, `identityBinding: invalid`                                                                                                                                                                                                                                                               |
| B5a | B1's tick signature re-spelled in non-canonical base64url, with a record **re-signed by A over the re-spelled tick**, while the tick is unexpired | FAIL, `integrity: invalid`, from the canonicality rule alone                                                                                                                                                                                                                                   |
| B5b | a second PR built on the current tip with a grant whose first bundle already landed, while unexpired                                              | the recorded `authority: insufficient` (spent), asserted on that axis, not only on the PR-shape failure                                                                                                                                                                                        |
| B6  | a revocation landed on `main`, then a PR on the new tip with that grant                                                                           | the recorded `revocation: revoked`, asserted on that axis                                                                                                                                                                                                                                      |

Each row records the run id, event, policy SHA, head commit, landing commit, evaluation time and every axis in [`docs/ops/milestone-ledger.md`](../ops/milestone-ledger.md). The full denial, tamper, restart and revocation matrix is C.

## Gaps assigned to C

- Continuous monitoring with agent-specific risk signals (tenet 9).
- Continuous authorization: revocations re-read during a run.
- Cascade revocation.
- An independent witness of `main`.
- Zero standing privilege for the `motebit-agent` credential.
- Binding A to an approved runtime configuration.
- A live run whose model attempts out-of-scope actions.
- Before `AUTONOMY_T0` can be turned on: milestone A's classifier has the same Unicode case-fold gap (its exclusion patterns use `i` without `u`; `caseIndex` uses `toLowerCase`), and there the agent chooses the path. The ASCII segment rule above applies to T0 too.

## Build order

Each step is its own reviewed PR: 0. Reject non-canonical keys in revocations as malformed, at `verifyDelegationRevocation` and at the relay's revocation route (packages/crypto and services/relay, founder-reviewed). Independent of B, whose strict parse already makes such a file `unchecked`.

1. `spec/repo-change-v1.md`, JSON Schemas, terminology entries, the verdict-vocabulary additions and repair codes; then the verifier core, with tamper tests for every condition in every axis.
2. The runtime pieces:
   - receipts for every tool call, with their real status;
   - a durable receipt sink;
   - the ephemeral no-interior run;
   - the frozen two-tool registry with the handler-identity assertion.

   Tests must show the run cannot start or write without a valid tick, offers no other tool on any model call, and forms no memory.

3. `motebit repo-task delegate` and `revoke` (the founder side), as a sibling of `motebit grant`, never an extension of the money path.
4. Move the T0 allowlist from code to a data file that the milestone-A classifier and the verifier both interpret (founder-reviewed; it changes A's classifier). Then `motebit repo-task run`, the bundle writer, and the `motebit-verify repo-change` kind.
5. The `.motebit/principals/` (role-typed) and `.motebit/revocations/` directories with `CODEOWNERS` (T1), then `governed-change.yml` in its expand state.
6. The live acceptance tests.

## Honest limits

- The key-to-account binding is **pinned** (in the strict sense above) through GitHub, not sovereign.
- The custody of `main`, the landing time, and the CI clock are GitHub's (see the trust assumptions above).
- The verifier proves who signed what, within which limits, which entries changed, and that the landed commit carries exactly that change. It does not prove that the change is correct, or that the model did what the task text asked.
- A and the `motebit-agent` credential run on the same machine. That is C's question.
- The two harness commits run outside the policy gate. The `authority` axis and the shape checks bind them.
- A run writes blobs into the repository's object store (they are unreferenced until the change commit is made, and git's garbage collection removes any a run leaves behind). This is the cost of never writing the worktree (amendment of 2026-10-29).
