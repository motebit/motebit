# Payment receipts — well-formed text: stop condition and exhaustive harness

Status: **fixed structurally; harness green with `known-red.json` empty (822 → 0 failing
cells).** The harness and this note were committed red on `harness/payment-receipt-wellformed`
(cut from `feat/payment-receipt-hash-binding` @ `0d4497c49`); the founder decided the open
questions on 2026-10-11 (§3) and `fix/payment-receipt-wellformed` implemented them (§6).

Why this note exists: review rounds 1–4 on the hash-binding branch kept finding the same class of
defect, malformed text (lone UTF-16 surrogates and other non-well-formed strings) in a signed
field. That text produced different bytes or verdicts in different producers and verifiers, and
each round patched the field or path the reviewer had just found. After a second similar finding
the rule is: no more patch rounds. First the stop condition, then an exhaustive harness shown
failing.

## 1. Invariant

> **Every string a payment-family receipt signs (every value and every object key, at every
> delegation depth) is well-formed Unicode when it is signed. Every strict reader rejects a
> receipt that breaks this, at one point and with one diagnostic (`§11.4 … unpaired UTF-16
surrogate`). Every default/lenient reader (the `@motebit/verifier` and `@motebit/crypto`
> defaults, the runtime and relay acceptance path, `--lenient`) returns, for any receipt, exactly
> the verdict origin/main returns.**

"Well-formed" means `String.prototype.isWellFormed()`, so there is no unpaired surrogate. NUL,
BOM, noncharacters, U+FFFD, U+2028/9 and astral pairs are all well-formed and must pass through
every producer unchanged.

## 2. Enumerated surface

### 2.1 Signed text fields (ExecutionReceipt shape; sovereign payment receipts are this shape)

| class                                                                                  | fields                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| free text                                                                              | `task_id`, `motebit_id`, `device_id`, `result`, `tools_used[i]`, `relay_task_id`, `delegated_scope`, `source_projection`, and the same fields of every `delegation_receipts[i]` (any depth) |
| format/enum (a well-formed value can still be invalid; surrogates are a second defect) | `status`, `suite`, `invocation_origin`, `public_key`, `prompt_hash`, `result_hash`, `service_result_hash`, `source_digest.value`, `signature`, any **object key** (unknown keys)            |

Sovereign payment inputs that flow into those fields (`signSovereignPaymentReceipt`):
`payee_motebit_id→motebit_id`, `payee_device_id→device_id`, `rail`+`tx_hash→task_id`,
`service_description`+`payer_motebit_id`+`asset`+`rail→result`, `prompt_hash`, `tools_used`,
`result_hash→service_result_hash`. In the runtime payee handler
(`MotebitRuntime.handleSovereignReceiptRequest`) every one of these except the payee ids comes
straight from the **payer's request**, so the payer controls that text.

### 2.2 Producers

| id  | producer                                                                                       | what it repaired on `0d4497c49` (before §6)                |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P1  | `@motebit/crypto` `signExecutionReceipt` (every producer below signs through it)               | `result` only                                              |
| P2  | `@motebit/crypto` `signSovereignPaymentReceipt` (+ runtime payee handler)                      | `result` (via P1); rejects a non-hex `result_hash` input   |
| P3  | `@motebit/mcp-server` `buildServiceReceipt` (every MCP service)                                | `result` (`toWellFormedText`)                              |
| P4  | `@motebit/runtime` `handleAgentTask` (every served task)                                       | model response (`toWellFormedText`)                        |
| P5  | `motebit smoke-x402` `buildSmokeWorkerReceipt`                                                 | `result` (via P1)                                          |
| —   | `motebit serve` daemon tool path (`apps/cli/src/daemon.ts`)                                    | `result`; not unit-invocable, signs via P1 ⇒ behaves as P1 |
| —   | tool edges (`read_file`, `read_url`, `shell_exec`, `web_search`, proxy fetch, browser-sandbox) | truncate on code-point boundaries (`truncateWellFormed`)   |

### 2.3 Verifiers / readers

| path                                                                                                     | mode            | required behaviour                                             |
| -------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------- |
| `@motebit/verifier` `verifyArtifact` / `verifyFile` (no options)                                         | library default | ≡ origin/main (pinned public contract)                         |
| `@motebit/crypto` `verify` / `verifyReceipt` (no options)                                                | library default | ≡ origin/main                                                  |
| `@motebit/crypto` `verifyReceiptVerdict` (re-exported by the verifier)                                   | library default | ≡ origin/main                                                  |
| `verifyExecutionReceipt` (runtime ×5 call sites, relay `tasks.ts`/`agents.ts`/`federation-callbacks.ts`) | acceptance      | ≡ origin/main; accepts old receipts                            |
| `motebit verify receipt` (`verifyWire`)                                                                  | strict default  | reject + §11.4 diagnostic                                      |
| `motebit-verify` (`verifyFile(…, {strictHashBinding: true})`)                                            | strict default  | reject + §11.4 diagnostic                                      |
| both CLIs `--lenient`                                                                                    | lenient         | accept an old receipt whose only defect is malformed free text |
| Python reference `examples/python-receipt-verifier/verify.py`                                            | strict (only)   | reject + §11.4 diagnostic; agrees with TS strict               |

## 3. The structural stop condition

The defect keeps coming back for one reason: **well-formedness is enforced per field and per
path, never at the one boundary every signed byte crosses.** Each patch round added a repair to
whichever producer field or verifier branch the reviewer had just found. The harness shows the
remainder: every other field on every producer, the schema-first and shape-first readers, and a
library default that changed.

This class cannot recur only if all three of these hold:

1. **One producer boundary, fail-closed and deep.** The canonical-bytes-for-signing step (the
   single function every receipt signer goes through, i.e. `canonicalJson` as called by
   `signExecutionReceipt`, or better a `canonicalJsonForSigning` that every signed artifact
   family shares) refuses any body that holds an unpaired surrogate in any string value or key
   at any depth, embedded child receipts included. It refuses rather than repairs: a silent
   U+FFFD in an id or hash changes an identity, and a signed child cannot be repaired. Repair
   stays where it belongs, at the text's source (stream cut, tool truncation), which already
   uses `toWellFormedText` / `truncateWellFormed`.
2. **One verifier predicate, one place, strict-only.** Strict readers run the one deep predicate
   (`hasUnpairedSurrogate`) **before** schema or shape validation, so the §11.4 diagnostic does
   not depend on which field carries the surrogate. Default and lenient paths contain **no**
   well-formedness branch and no other new default-mode check (today `verifyReceiptVerdict`'s
   surrogate branch and the default-mode `service_result_hash` shape check both break this).
3. **A gate proves both.** This harness, with `known-red.json` emptied, is the proof: the cross
   product of every signed field × the input corpus × every producer and reader, plus the
   committed origin/main verdict golden for the default paths. A static companion gate
   (`check-signed-text-wellformed`) should fail any signer that reaches `ed25519Sign` /
   `signBySuite` over canonical bytes without going through the guarded canonicalizer, so a
   new producer cannot sidestep (1).

Decisions (the harness encodes the invariant as written, not an answer). **DECIDED 2026-10-11**
by the founder / PE:

- (a) **A producer REFUSES to embed an old child receipt holding an unpaired surrogate** (P1/P3
  `delegation_receipts`): fail closed, rule (1) as written. No exception for a child signed by
  someone else.
  **REFINED 2026-10-11 by the principal engineer:** refusing to _embed_ the child must not mean
  refusing to _sign the parent_. The parent must never be lost because a third party's child is
  malformed. So the embedding producers (`handleAgentTask` in `@motebit/runtime`,
  `buildServiceReceipt` in `@motebit/mcp-server`) **drop** such a child from
  `delegation_receipts` (the runtime logs it) and still sign the parent, which is strict-valid.
  The signing boundary itself is unchanged: `signExecutionReceipt` (P1) still throws
  `UnpairedSurrogateError` when handed a body that embeds one — the drop happens before it, at
  the producers that assemble the chain.
- (b) **`verifyReceiptVerdict`'s default stays byte-identical to origin/main** (pinned public
  contract, re-exported by `@motebit/verifier`). It has no surrogate branch; it has no strict
  mode, so it carries no well-formedness check at all.
- (c) **The `service_result_hash` shape check runs in STRICT mode only.** Tightening the default
  is deferred to the next major of `@motebit/crypto` / `@motebit/verifier`, announced as a
  deprecation note in the `sovereign-payment-receipt-service-result-hash` changeset.

## 4. The harness

`apps/cli/src/__tests__/payment-receipt-wellformed-harness.test.ts` (runs in the `motebit` app's
vitest suite, so in CI), with:

- `helpers/wellformed-corpus.ts`: 16 inputs (9 malformed: lone high/low mid-string, lone high at
  the end, lone low at the start, reversed pair, high-then-pair, only-high, only-low, mixed; 7
  well-formed controls: astral, NUL, BOM, noncharacters, U+FFFD, U+2028/9, the escaped-looking
  literal `\ud800`). 19 legacy fields, deterministic keys and signatures, receipts signed exactly
  as main's producers signed (JCS escapes the surrogate, so the signature verifies).
- `fixtures/payment-receipt-wellformed.main-verdicts.json`: origin/main (`f2398e848`) verdicts for
  all 304 legacy receipts on the 4 default paths, recorded by `apps/cli/scripts/wellformed-main-oracle.mjs`
  against a built origin/main worktree.
- `fixtures/payment-receipt-wellformed.known-red.json`: every cell that fails today, with its
  reason. Each one is registered with `it.fails` (vitest's expected-failure mechanism), so the
  suite is green only while each listed cell still fails its unweakened assertion. A fix that
  turns a cell green turns that `it.fails` red, and the fix's PR deletes the line. Nothing is
  skipped. The python leg runs when `python3` + `pynacl` + `requests` import (it did for this
  run); `REQUIRE_PYTHON=1` makes it mandatory, like `check-receipt-conformance`.
- The CLIs run in-process, through the exact call each binary's exit code is computed from
  (`verifyWire` for `motebit verify receipt`; `verifyFile` with `strictHashBinding` for
  `motebit-verify`). These are the calls the exit codes come from (`handleVerifyWire` → `verifyWire`; `cli.ts` `main` → `verifyFile`); `verify-cli-differential.test.ts` covers the spawned binaries on its own corpus.

Run it: `pnpm --filter motebit exec vitest run payment-receipt-wellformed-harness`
(set `WF_REPORT=/tmp/r.json` to dump the failing cells).

**Result on `0d4497c49`: 5,844 cells, 5,022 hold, 822 fail.** Failing cells by path:

| path                                                          | failing cells |
| ------------------------------------------------------------- | ------------: |
| P1 `signExecutionReceipt`                                     |           153 |
| P2 `signSovereignPaymentReceipt`                              |            99 |
| P3 `buildServiceReceipt`                                      |           144 |
| P4 `handleAgentTask`                                          |            54 |
| P5 smoke-x402 worker receipt                                  |            54 |
| I5 `crypto.verifyReceiptVerdict` ≢ main                       |           178 |
| I5 `verifier.verifyArtifact` (default) ≢ main                 |            16 |
| I5 `crypto.verify` (default) ≢ main                           |            16 |
| I2 `motebit verify receipt` strict: wrong/no §11.4 diagnostic |            45 |
| I6 python reference: no §11.4 diagnostic                      |            63 |
| **total**                                                     |       **822** |

What holds: the `result` field end to end (every producer repairs it, both CLIs and python
reject legacy ones with §11.4, lenient and runtime/relay accept them); every I3 lenient cell;
every I4 runtime/relay acceptance cell; every I7 CLI-agreement cell; I5 for the
`verifyArtifact`/`verify`/`verifyExecutionReceipt` defaults on every field except
`service_result_hash`; and every well-formed control is preserved byte-identically by every
producer.

What fails, in three findings:

1. **Producers repair one field.** Every producer emits an unpaired surrogate in every
   caller-supplied signed field other than `result`/response text (ids, `tools_used`,
   `relay_task_id`, `delegated_scope`, `source_projection`, `prompt_hash`, an embedded old child
   receipt, and on sovereign payment receipts the payer-controlled `rail`/`tx_hash`/`tools_used`/
   `prompt_hash`). The branch's own strict verifier then rejects that output (`strict-accepts-own`).
2. **The library default moved.** `verifyReceiptVerdict` now returns `integrity=invalid`
   (`integrity.unpaired_surrogate`) where main returned `verified`, for every malformed input on
   every field (171 cells). The default `verify` / `verifyArtifact` now reject any
   `service_result_hash` that is not 64 lowercase hex, including well-formed text main accepted
   (16 + 16 cells, plus 7 verdict cells).
3. **The strict diagnostic depends on the field.** `motebit verify receipt` runs the zod wire
   schema first, so a surrogate in `status`, `suite`, `invocation_origin`, `service_result_hash`
   or an unknown key is reported as a schema error, never §11.4. The Python reference runs its shape checks first in the same way (`status`, `suite`, `invocation_origin`, `public_key`, `prompt_hash`, `result_hash`, `service_result_hash`). `motebit-verify` names §11.4 in every malformed cell.

## 5. Out of scope

- **Format validation of well-formed values.** The wire schema, crypto and python already
  disagree on main about a well-formed but invalid `status`, a non-hex `prompt_hash`, or an
  unknown key. That is a different class (schema strictness). For format fields the harness
  asserts only malformed inputs, plus "never crash" everywhere.
- Other signed families (ToolInvocationReceipt, ContentArtifactManifest, delegation tokens,
  settlement artifacts). They share the canonicalizer, so stop condition (1) would cover them,
  but the harness enumerates only the payment-receipt family.
- Invalid UTF-8 at the **byte** level in a receipt file (the CLIs decode with `utf8`, which
  substitutes U+FFFD before JSON parsing). Prompt text, which is hashed and never signed. Unicode
  normalization (NFC/NFD). Duplicate JSON keys.
- The `motebit serve` daemon path and the relay HTTP doors, exercised through the functions they
  call (P1, `verifyExecutionReceipt`) rather than booted.
- Fixing anything (on the harness branch). The fix is §6.

## 6. The fix (`fix/payment-receipt-wellformed`, 2026-10-11)

1. **Producer boundary.** `canonicalJsonForSigning` (`packages/crypto/src/signing.ts`) is
   `canonicalJson` that throws `UnpairedSurrogateError` (with the first offending path) for an
   unpaired surrogate in any string value or object key at any depth, embedded receipts
   included. `signExecutionReceipt` (so P1, P2, P3, P4, P5 and the daemon) signs through it, as
   do the other `@motebit/crypto` signers. The per-field repair inside `signExecutionReceipt`
   is gone; repair stays where text is produced (`toWellFormedText` in the task handler, the MCP
   receipt builder and the daemon; `truncateWellFormed` at the tool edges and, now, in the
   smoke worker's `result` cut, which used to split a pair and lean on the signer's repair).
   No new silent repair was added.
2. **One strict predicate.** `hasUnpairedSurrogate` (deep, walks exactly what `canonicalJson`
   serializes) runs before any schema/shape check in `motebit verify receipt`'s strict default
   (`verifyWire`) and in the Python reference (`verify_receipt`); `motebit-verify` reaches it
   through `@motebit/crypto`'s strict `verifyReceipt`, which runs it on every node independently
   of the other checks. `verifyReceiptVerdict` is origin/main's function verbatim, and the
   `service_result_hash` shape check in `verifyReceipt` runs only under `strictHashBinding`.
   The lenient, runtime and relay paths have no well-formedness branch.
3. **Static gate.** `check-signed-text-wellformed` (in `pnpm check`, invariant #176) scans
   every call of `ed25519Sign` / `signBySuite` / an imported `sign` alias in `packages/`,
   `services/` and `apps/`; the signing function must call the guard or hand it to a bytes
   helper. Documented non-JCS signers (JWT payload, identity-file YAML) pass. Out-of-fence
   canonical-JSON signers are a **count-pinned debt list**, not silently exempt: the money-record
   signers in `@motebit/crypto` (settlement, federation settlement, withdrawal receipt, balance
   waiver, bond commitment, invoice, cost attestation, dispute resolution), 27 relay call sites,
   two runtime ledger-digest signers and the identity-file guardian attestation. Refusing on
   those changes a settlement- or relay-path failure mode, so each needs its own review; a
   new unguarded call in a pinned function, or any new signer, fails the gate. Tamper test:
   `scripts/__tests__/check-signed-text-wellformed.test.ts` (planted bypasses in a fixture) and
   a `check-gates-effective` probe that reverts `signExecutionReceipt` to `canonicalJson`.

Result: **5,844 cells, 5,844 hold** (python leg required, `REQUIRE_PYTHON=1`), with
`known-red.json` empty. The origin/main verdict golden (`main-verdicts.json`) is unchanged and
every I5 default-path cell matches it. Public API in default mode: unchanged. Additive
producer-side exports: `canonicalJsonForSigning`, `UnpairedSurrogateError` (`@motebit/crypto`;
re-exported with `hasUnpairedSurrogate` from `@motebit/encryption`).

## 7. Cold review round (`fix/payment-receipt-wellformed`, 2026-10-11)

A cold review of §6 found the recurring class again — a DEFAULT-mode verdict diverging from the
base — so the harness came first:

1. **Differential default-mode harness.** `apps/cli/src/__tests__/default-verdict-differential.test.ts`
   runs every default-mode verifier path (`crypto.verify` on an object / a JSON string / with
   `expectedType`, `verifyReceipt` with no options / `{}` / `strictHashBinding: false`,
   `verifyReceiptVerdict`, `@motebit/verifier`'s `verifyArtifact` / `verifyFile`, and the
   runtime/relay `verifyExecutionReceipt`) over a 751-receipt corpus — every `public_key`
   spelling (any-case hex, partially-parseable pairs `"ag"` / `" a"` / `"+a"` / `"-a"` / `"zz"`,
   short / 65 / 66 characters, non-strings, arrays) × every `delegation_receipts` shape (`[]`,
   `[null]`, non-objects, bad / keyless / lenient-key / lone-surrogate children, chains to the
   cap of 10), plus a seeded fast-check sample over malformed text, missing / extra fields,
   suites, signatures and `result_hash`. Each verdict (valid, every error, every field, or the
   thrown message) must equal the merge-base `4571d3b42`'s, recorded as a golden by
   `apps/cli/scripts/default-verdict-base-oracle.ts`. Committed red: **477 of 751 cases
   diverged.**
2. **Fix.** `verifyReceipt` dispatches on `strictHashBinding`: the default is the merge-base
   function verbatim (lenient `hexToBytes` + 32-byte check, keyless early return with no
   `§11.5` entries, a `null` child throws as it always did); the 64-hex key rule, the full
   nested walk, the `§11.4` / `§11.5` strictness and the shape errors are strict-only. **0 of
   751 diverge.** `motebit-verify --lenient` maps a verifier throw to INVALID (exit 1), as
   `motebit verify receipt` does, instead of "cannot read" (exit 2).
3. **Gate.** `check-signed-text-wellformed` now sees property-access signers (`C.signBySuite`,
   `ed.signAsync`, `x["ed25519Sign"]`, re-bound methods, `tx.sign`; not `Math.sign`) and traces
   the argument carrying the signed bytes to the guard's output within the function (encoders,
   digests, local variables, buffers built from guarded digests, a helper handed the guard), so
   a decoy guard no longer passes. Tamper fixtures: the previous gate flagged 0 of the 7 new
   planted bypasses, this one flags all 7 (10 in total). `create-motebit rotate`'s
   key-succession signer goes through an inlined guard; Solana `tx.sign` and the motebit.md
   YAML signers are documented non-JCS; the simulated Secure Enclave test mint is pinned debt.
4. **P3.** Decision (a) refined (§3): an old malformed child is dropped, the parent signed.

## Appendix A — failing cells on `0d4497c49`, before the fix (field × path × input)

Inputs: "all 9 malformed" = lone-high-mid, lone-low-mid, lone-high-end, lone-low-start,
reversed-pair, high-then-pair, only-lone-high, only-lone-low, mixed. The full list with the
per-cell reason is `apps/cli/src/__tests__/fixtures/payment-receipt-wellformed.known-red.json`.
"old receipt" rows are verifier paths over legacy-signed receipts.

| path                                  | field                                                | invariant                                         | inputs                                                                                                                            | cells | sample reason                                                                                                |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------ |
| P1 crypto.signExecutionReceipt        | `delegated_scope`                                    | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `delegated_scope`                                    | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P1 crypto.signExecutionReceipt        | `delegation_receipts[0] (old child, text in result)` | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `delegation_receipts[0] (old child, text in result)` | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.5 violation: delegation task-wf-child verification failed: §11.4 violation: … |
| P1 crypto.signExecutionReceipt        | `device_id`                                          | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `device_id`                                          | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P1 crypto.signExecutionReceipt        | `motebit_id`                                         | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `motebit_id`                                         | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P1 crypto.signExecutionReceipt        | `prompt_hash`                                        | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `relay_task_id`                                      | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `relay_task_id`                                      | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P1 crypto.signExecutionReceipt        | `source_projection`                                  | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `source_projection`                                  | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P1 crypto.signExecutionReceipt        | `task_id`                                            | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `task_id`                                            | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P1 crypto.signExecutionReceipt        | `tools_used[0]`                                      | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P1 crypto.signExecutionReceipt        | `tools_used[0]`                                      | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P2 crypto.signSovereignPaymentReceipt | `payee_device_id`                                    | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P2 crypto.signSovereignPaymentReceipt | `payee_device_id`                                    | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P2 crypto.signSovereignPaymentReceipt | `payee_motebit_id`                                   | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P2 crypto.signSovereignPaymentReceipt | `payee_motebit_id`                                   | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P2 crypto.signSovereignPaymentReceipt | `prompt_hash`                                        | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P2 crypto.signSovereignPaymentReceipt | `rail`                                               | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀:tx:5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKho… |
| P2 crypto.signSovereignPaymentReceipt | `rail`                                               | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P2 crypto.signSovereignPaymentReceipt | `tools_used[0]`                                      | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P2 crypto.signSovereignPaymentReceipt | `tools_used[0]`                                      | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P2 crypto.signSovereignPaymentReceipt | `tx_hash`                                            | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"solana:tx:\\ud83d😀\"                                                       |
| P2 crypto.signSovereignPaymentReceipt | `tx_hash`                                            | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P3 mcp-server.buildServiceReceipt     | `delegatedScope`                                     | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P3 mcp-server.buildServiceReceipt     | `delegatedScope`                                     | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P3 mcp-server.buildServiceReceipt     | `delegationReceipts[0] (old child, text in result)`  | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P3 mcp-server.buildServiceReceipt     | `delegationReceipts[0] (old child, text in result)`  | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.5 violation: delegation task-wf-child verification failed: §11.4 violation: … |
| P3 mcp-server.buildServiceReceipt     | `deviceId`                                           | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P3 mcp-server.buildServiceReceipt     | `deviceId`                                           | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P3 mcp-server.buildServiceReceipt     | `motebitId`                                          | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P3 mcp-server.buildServiceReceipt     | `motebitId`                                          | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P3 mcp-server.buildServiceReceipt     | `relayTaskId`                                        | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P3 mcp-server.buildServiceReceipt     | `relayTaskId`                                        | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P3 mcp-server.buildServiceReceipt     | `sourceProjection`                                   | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P3 mcp-server.buildServiceReceipt     | `sourceProjection`                                   | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P3 mcp-server.buildServiceReceipt     | `taskId`                                             | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P3 mcp-server.buildServiceReceipt     | `taskId`                                             | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P3 mcp-server.buildServiceReceipt     | `toolsUsed[0]`                                       | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P3 mcp-server.buildServiceReceipt     | `toolsUsed[0]`                                       | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P4 runtime.handleAgentTask            | `deviceId`                                           | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P4 runtime.handleAgentTask            | `deviceId`                                           | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P4 runtime.handleAgentTask            | `task.motebit_id`                                    | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P4 runtime.handleAgentTask            | `task.motebit_id`                                    | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P4 runtime.handleAgentTask            | `task.task_id`                                       | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P4 runtime.handleAgentTask            | `task.task_id`                                       | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P5 cli.smoke-x402 worker receipt      | `taskId`                                             | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"abcdefg\\ud83d😀\"                                                          |
| P5 cli.smoke-x402 worker receipt      | `taskId`                                             | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P5 cli.smoke-x402 worker receipt      | `worker.deviceId`                                    | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P5 cli.smoke-x402 worker receipt      | `worker.deviceId`                                    | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| P5 cli.smoke-x402 worker receipt      | `worker.motebitId`                                   | I1 emits-well-formed                              | all 9 malformed                                                                                                                   |     9 | emitted an unpaired surrogate: \"\\ud83d😀\"                                                                 |
| P5 cli.smoke-x402 worker receipt      | `worker.motebitId`                                   | I1 strict-accepts-own                             | all 9 malformed                                                                                                                   |     9 | strict rejects own output: §11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — i… |
| old receipt                           | `<object key>`                                       | I2 motebit verify receipt (strict)                | all 9 malformed                                                                                                                   |     9 | rejected without the §11.4 diagnostic: schema: (root): Unrecognized key: \"x_\ud83d😀\"                      |
| old receipt                           | `<object key>`                                       | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `delegated_scope`                                    | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `delegation_receipts[0].result`                      | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `delegation_receipts[0].task_id`                     | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `device_id`                                          | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `invocation_origin`                                  | I2 motebit verify receipt (strict)                | all 9 malformed                                                                                                                   |     9 | rejected without the §11.4 diagnostic: schema: invocation_origin: Invalid option: expected one of \"user-ta… |
| old receipt                           | `invocation_origin`                                  | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `invocation_origin`                                  | I6 python reference (strict)                      | all 9 malformed                                                                                                                   |     9 | rejected without §11.4: §11.7 violation: invocation_origin '\ud83d😀' not in ['agent-to-agent', 'ai-loop', … |
| old receipt                           | `motebit_id`                                         | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `prompt_hash`                                        | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `prompt_hash`                                        | I6 python reference (strict)                      | all 9 malformed                                                                                                                   |     9 | rejected without §11.4: §11.4 violation: prompt_hash must be 64-char lowercase hex SHA-256                   |
| old receipt                           | `public_key`                                         | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=invalid ≠ branch: integrity=invalid                                                          |
| old receipt                           | `public_key`                                         | I6 python reference (strict)                      | all 9 malformed                                                                                                                   |     9 | rejected without §11.4: §11.1 violation: public_key must be 64-char lowercase hex Ed25519                    |
| old receipt                           | `relay_task_id`                                      | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `result`                                             | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `result_hash`                                        | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=invalid ≠ branch: integrity=invalid                                                          |
| old receipt                           | `result_hash`                                        | I6 python reference (strict)                      | all 9 malformed                                                                                                                   |     9 | rejected without §11.4: §11.4 violation: result_hash must be 64-char lowercase hex SHA-256                   |
| old receipt                           | `service_result_hash`                                | I5 crypto.verify(default) ≡ origin/main           | all 9 malformed + 7 well-formed (astral-well-formed, bom, escaped-literal, line-separators, noncharacters, nul, replacement-char) |    16 | main: valid=true ≠ branch: valid=false errors=service_result_hash must be 64 lowercase hex characters (SHA-… |
| old receipt                           | `service_result_hash`                                | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed + 7 well-formed (astral-well-formed, bom, escaped-literal, line-separators, noncharacters, nul, replacement-char) |    16 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `service_result_hash`                                | I5 verifier.verifyArtifact(default) ≡ origin/main | all 9 malformed + 7 well-formed (astral-well-formed, bom, escaped-literal, line-separators, noncharacters, nul, replacement-char) |    16 | main: valid=true ≠ branch: valid=false errors=service_result_hash must be 64 lowercase hex characters (SHA-… |
| old receipt                           | `service_result_hash`                                | I2 motebit verify receipt (strict)                | all 9 malformed                                                                                                                   |     9 | rejected without the §11.4 diagnostic: schema: service_result_hash: service_result_hash MUST be 64 lowercas… |
| old receipt                           | `service_result_hash`                                | I6 python reference (strict)                      | all 9 malformed                                                                                                                   |     9 | rejected without §11.4: §11.4 violation: service_result_hash must be 64-char lowercase hex SHA-256           |
| old receipt                           | `source_digest.value`                                | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `source_projection`                                  | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `status`                                             | I2 motebit verify receipt (strict)                | all 9 malformed                                                                                                                   |     9 | rejected without the §11.4 diagnostic: schema: status: Invalid option: expected one of \"completed\"\|\"fai… |
| old receipt                           | `status`                                             | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `status`                                             | I6 python reference (strict)                      | all 9 malformed                                                                                                                   |     9 | rejected without §11.4: §11.1 violation: status '\ud83d😀' not in ['completed', 'denied', 'failed']          |
| old receipt                           | `suite`                                              | I2 motebit verify receipt (strict)                | all 9 malformed                                                                                                                   |     9 | rejected without the §11.4 diagnostic: schema: suite: Invalid input: expected \"motebit-jcs-ed25519-b64-v1\" |
| old receipt                           | `suite`                                              | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=invalid ≠ branch: integrity=invalid                                                          |
| old receipt                           | `suite`                                              | I6 python reference (strict)                      | all 9 malformed                                                                                                                   |     9 | rejected without §11.4: §11.1 violation: suite '\ud83d😀' is not 'motebit-jcs-ed25519-b64-v1' — this verifi… |
| old receipt                           | `task_id`                                            | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
| old receipt                           | `tools_used[0]`                                      | I5 crypto.verifyReceiptVerdict ≡ origin/main      | all 9 malformed                                                                                                                   |     9 | main: integrity=verified ≠ branch: integrity=invalid                                                         |
