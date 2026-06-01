# Wire-schema type-parity inventory

**Status:** Branch A (read-only forensic inventory). Generated 2026-05-31 against `main @ f037d4b4`.
**Source of truth:** an index-signature-safe `_PDiff` mapped-type probe (the `_PD2` form) injected into each of the 18 failing `packages/wire-schemas/src/*.ts` files, reusing each file's own local `Inferred`/`BrandedToString` types so the surfaced divergences match the existing parity checks' assignability semantics exactly. Probe restored after capture; this doc is the only artifact.

This inventory exists because the `_*_TYPE_PARITY` blocks are **inert**: their value lines are written `forward: true as _ForwardCheck`, and `true as never` is a legal assertion, so a check that resolves to `never` on drift is swallowed and `tsc` passes. Empirically: adding a required field to `ExecutionReceipt` and rebuilding leaves `wire-schemas` `tsc --noEmit` at **exit 0**. Stripping the 130 `: true as _\w+` casts surfaces failures in **exactly 18 of 27** parity files. See `wire-schemas/CLAUDE.md` rule 5 (the claim "keeps the zod shape and the protocol type in perfect sync" — false today) and memory `wire_schema_parity_cast_hole`.

---

## Headline — the premise needs correcting before Branch B

"Strip the casts → 18 real divergences" is only **half** true. Stripping the casts surfaces 18 _files_ of failures, but the **majority of those failures are structural artifacts of the check itself, not real protocol↔schema disagreements.** Four artifact classes (see § Structural artifacts) cause most of the 18 to fail even when the wire shape is byte-identical. Only **~5** failures are genuine wire issues worth fixing on their own merits, and a **further cluster** is the intentional single-suite pin (a policy decision, not a bug).

**Consequence for Branch B:** the memory's plan — "remove all 130 casts + add a gate forbidding the cast" — **cannot be executed as written.** Removing the casts makes `wire-schemas` `tsc` (and therefore CI) red with dozens of false positives. A gate that forbids `true as _\w+` would lock that red in. The load-bearing work is **first making the parity check artifact-free** (relax `readonly`, fix the over-broad `BrandedToString`, decide nominal-enum handling, decide the suite-pin policy), **then** fixing the ~5 real divergences, **then** removing the casts and adding the gate. Sequencing matters; the gate is last, not first.

---

## Category legend

- **Cat 1** — protocol type unintentionally **wider** than the schema → narrow the protocol to the schema (minor `@motebit/protocol` bump; each narrowing must be checked against constructors — narrowing can break callers, the reverse of `feedback_api_widening_consumer_typecheck`).
- **Cat 2** — schema unintentionally **tighter** than the protocol → widen the schema (patch `wire-schemas` only; runtime validation currently rejects valid wire values).
- **Cat 3** — **intentional** divergence → `// parity-divergence: <reason>` waiver + a typed escape, never the blanket `as` cast.
- **Artifact** — type-nominally divergent but **wire-identical**; not a real divergence. Caused by the check's construction, not by drift. These are why most of the 18 fail.

---

## A. Real wire divergences (fix on their own merits)

| #   | File · field                                                   | Protocol type                                                                                                      | Schema (zod) type                                                                                                                 | Category                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `agent-task.ts` · `required_capabilities[]`                    | `DeviceCapability[]` — **8-member** enum incl. `secure_enclave` (`protocol/src/index.ts:799-818`)                  | `z.enum([7 values])` — **missing `secure_enclave`** (`agent-task.ts:47-48`)                                                       | **2**                           | Real wire bug: an `AgentTask` requiring `secure_enclave` fails zod validation. The schema comment claims it mirrors the closed `DeviceCapability` set but drops one. Widen schema to 8.                                                                                                                                                                                                                  |
| A2  | `computer-use.ts` · `ComputerActionRequest.action`             | `ComputerAction` — **13-arm** union (`computer-use.ts:272-285`)                                                    | `z.discriminatedUnion("kind", [10 arms])` (`computer-use.ts:159-170`) — **missing `click_element`, `focus_element`, `type_into`** | **2**                           | Real wire bug: the three AX-mode actions (`ClickElementAction`, `FocusElementAction`, `TypeIntoAction`) are absent from the schema union. A valid `type_into` action fails validation. Add the 3 arms.                                                                                                                                                                                                   |
| A3  | `consolidation-receipt.ts` · `ConsolidationReceipt.phases_run` | `ReadonlyArray<"orient"\|"gather"\|"consolidate"\|"prune"\|"flush">` — **5 phases** (`protocol/src/index.ts:1030`) | `z.enum(["orient","gather","consolidate","prune"])` — **4, missing `flush`** (`consolidation-receipt.ts:56`)                      | **2** (or 1)                    | Needs intent decision: if consolidation genuinely runs a `flush` phase (cf. `retention-policy.md` consolidation_flush), widen schema → cat 2. If `flush` is spurious in the protocol type, narrow protocol → cat 1. The schema author's comment (`:110`) lists only 4 phases. Resolve against the runtime `consolidationCycle()`. (Also carries the `readonly` artifact — see B2.)                       |
| A4  | `memory-events.ts` · `MemoryAuditPayload.missed_patterns`      | `ReadonlyArray<string>` (`protocol/src/memory-events.ts:121`)                                                      | `z.array(SensitivityLevelSchema)` → `("none"\|"personal"\|"medical"\|"financial"\|"secret")[]` (`memory-events.ts:302-303`)       | **1**                           | Protocol typed as generic `string[]`; schema (and the field's intent — "sensitivity classifications") is the closed `SensitivityLevel` set. Narrow protocol to `ReadonlyArray<SensitivityLevel>`. Check producers don't write arbitrary strings. (Also carries `readonly`.)                                                                                                                              |
| A5  | `settlement-record.ts` · `SettlementRecord.settlement_mode`    | `SettlementMode` = `"relay" \| "p2p"` (`protocol/src/settlement-mode.ts:11`)                                       | inferred **`string`** — from `z.enum(ALL_SETTLEMENT_MODES as readonly [string, ...string[]])` (`settlement-record.ts:92-93`)      | **1-variant** (type-level only) | Runtime validation is **correct** (it checks against `ALL_SETTLEMENT_MODES` values); only the _inferred type_ is widened to `string` by the `as readonly [string, ...]` cast, losing the literal union. Fix the schema typing to preserve `"relay" \| "p2p"` (e.g. a properly-typed const tuple). No wire behavior change. Recurring idiom — grep other `z.enum(ALL_* as readonly [string, ...])` sites. |

---

## B. Suite-pin divergences (one policy decision, not bugs)

Protocol types every signed artifact's `suite` field as the full closed union `SuiteId` (5 members; `protocol/src/crypto-suite.ts:37-42`) — the cryptosuite-agility shape (adding a suite is a registry append, not a wire break). Every schema **pins a single `z.literal`** of today's suite. `wire-schemas/CLAUDE.md` **rule 6** says the opposite: "Every signed artifact's schema accepts the closed `SuiteId` union." So this is a real, systemic tension to resolve **once**, then apply everywhere.

| #         | File · field                                     | Surfacing                                        | Protocol                                                        | Schema                                                 |
| --------- | ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------ |
| B-suite-1 | `retention-manifest.ts` · `suite`                | direct                                           | `readonly suite: SuiteId`                                       | `z.literal("motebit-jcs-ed25519-hex-v1")` (`:131-132`) |
| B-suite-2 | `transparency-declaration.ts` · `suite`          | direct                                           | `readonly suite: SuiteId` (`protocol/src/transparency.ts:87`)   | `z.literal("motebit-jcs-ed25519-hex-v1")` (`:84`)      |
| B-suite-3 | `skill-envelope.ts` · `manifest`                 | nested → `SkillManifest.motebit.signature.suite` | `suite: SuiteId` (`protocol/src/skills.ts:103`)                 | nested `z.literal(...)`                                |
| B-suite-4 | `skill-manifest.ts` · `motebit`                  | nested → `SkillManifestMotebit...suite`          | `suite: SuiteId`                                                | nested `z.literal(...)`                                |
| B-suite-5 | `skill-registry.ts` · `envelope` (SubmitRequest) | nested → `SkillEnvelope...suite`                 | `suite: SuiteId`                                                | nested `z.literal(...)`                                |
| B-suite-6 | `skill-registry.ts` · `envelope` (Bundle)        | nested → `SkillEnvelope...suite`                 | `suite: SuiteId`                                                | nested `z.literal(...)`                                |
| B-suite-7 | `witness-omission-dispute.ts` · `cert_body`      | nested → `HorizonWitnessRequestBody.suite`       | `suite: SuiteId`                                                | nested `z.literal(...)`                                |
| B-suite-8 | `deletion-certificate.ts` · arms                 | nested → every arm `readonly suite: SuiteId`     | `suite: SuiteId` (`protocol/src/retention-policy.ts:273,349,…`) | `suiteField()` → single `z.literal` (`:41-45`)         |

**Decision needed (one call, applied to all 8):** either (a) **widen the schemas to accept `SuiteId`** (honors rule 6; verifiers still reject _unknown_ suites at the registry layer), or (b) **keep the single-suite pin as intentional fail-closed behavior** and rewrite rule 6 + add a `// parity-divergence: pins today's only emitted suite; widens on PQ registry append` waiver at each site. The pin is defensible (today exactly one suite is emitted per artifact), but it is **not** what rule 6 currently claims, so silence is drift either way. Recommend (b) with the rule-6 correction — it matches the existing `describe()` text and the fail-closed posture — but this is a doctrine call.

---

## C. Structural artifacts (wire-identical; the reason most of the 18 fail)

None of these is a real divergence. They are why "strip the casts" produces a misleadingly large failure set. Each must be neutralized in the **check mechanism** before the cast can be removed.

### C1. Nominal enum vs string-literal union — _wire-identical_

Protocol uses TS `enum`; the schema uses `z.enum([...string values])`. A TS enum type is nominally distinct from a string-literal union even when the string **values** are identical, so `EnumType extends "a"|"b"` is false → flagged. But the serialized wire bytes are identical.

- `agent-task.ts` · `status` — `AgentTaskStatus` (7 values, `index.ts:832-840`) vs `z.enum([7 identical])`. Pure nominal.
- `memory-events.ts` (`MemoryFormedPayload`) · `sensitivity` — `SensitivityLevel` enum (5) vs `z.enum([5 identical])`. Pure nominal.
- `agent-task.ts` · `required_capabilities` also carries this nominal mismatch **on top of** the real missing value (A1).

Mechanism fix: compare against the enum's value-union (e.g. `` `${DeviceCapability}` ``) rather than the nominal enum type.

### C2. `readonly` array vs mutable array — _wire-identical_

Protocol uses `ReadonlyArray<T>` / `readonly T[]`; zod infers mutable `T[]`. `readonly T[]` is not assignable to `T[]`, so forward flags.

- `consolidation-receipt.ts` · `receipt_ids` — `ReadonlyArray<string>` (`index.ts:1096`) vs `string[]`. **Pure** readonly artifact (no other issue).
- Also the readonly portion of `phases_run` (A3), `missed_patterns` (A4), and nested skill/witness/deletion bodies.

Mechanism fix: relax `readonly` in the comparison (a `Mutable<T>` deep-relax in the parity helper).

### C3. `BrandedToString` over-relaxes via the optional brand — _forward false positives_

`Brand<T,B> = T & { readonly [__brand]?: B }` (`protocol/src/index.ts:19`) — the brand property is **optional**. Verified: a plain `string` **assigns to `MotebitId`** with no error (though `MotebitId` still does **not** cross-assign to `DeviceId`). So `X extends MotebitId` is true for _any_ string. `BrandedToString`'s first arm `T[K] extends MotebitId ? string` therefore collapses **every string-literal field** (`status`, `suite`, enums) down to `string`, which then fails forward against the schema's narrow literal.

- `execution-receipt.ts` · `status` — flagged `[string, "completed"|"failed"|"denied"]`. **Not real** — both protocol and schema are the 3-literal union; the `string` is `BrandedToString`'s artifact. (This is the example memory `wire_schema_parity_cast_hole` recorded as "confirmed cat-1"; that was itself a misread of this artifact.)
- Same mechanism pollutes the forward direction of `agent-task` and `settlement-record` (the 3 branded files).

Mechanism fix: make the brand non-optional, **or** relax brands in `BrandedToString` by an explicit nominal test that doesn't match plain strings (e.g. key off the `__brand` symbol's presence), so only genuinely-branded fields collapse.

### C4. Discriminated-union `keyof` — _probe/Check artifact_

`keyof (A | B | C)` = only the **common** keys. A key present on a subset of arms is absent from `keyof union`, so a cross-arm field reads as "missing." Not a real divergence.

- `computer-use.ts` · `artifact_id` (on the screenshot arm of `ComputerObservationResult` only).
- `deletion-certificate.ts` · `target_id` (`NodeId` on `mutable_pruning`, `string` on another arm), `reason` (per-arm).

Mechanism fix: compare discriminated unions arm-by-arm (distribute over the union) rather than at the union level.

---

## D. Side finding (out of parity scope — flag, don't fix here)

The optional brand (C3, `protocol/src/index.ts:19`) means `const id: MotebitId = "raw string"` **compiles without a cast** (verified). Branding still blocks _cross-brand_ assignment (`MotebitId` ↛ `DeviceId`), so it is not worthless, but it does **not** stop a raw string flowing into a branded slot. `CLAUDE.md` advertises "Branded ID types … for compile-time safety"; the guarantee is narrower than that reads. Worth its own ticket and its own verification sweep — not part of the parity fix.

---

## E. Recommended Branch B sequencing (supersedes the memory's "remove casts + gate" as the _first_ move)

1. **Make the check artifact-free** (no behavior change, no published-surface change): deep-relax `readonly` (C2), fix `BrandedToString`'s optional-brand over-match (C3), compare enum value-unions not nominal enums (C1), distribute over discriminated unions (C4). After this, stripping the casts should surface **only** A1–A5 + the suite pins.
2. **Fix the real divergences A1–A5.** A1/A2/A3 are `wire-schemas`-only schema widenings (cat 2) — real bugs, ship regardless. A4/A5 are `@motebit/protocol` narrowings (cat 1) — need a changeset + `pnpm --filter <consumer> typecheck` sweeps (narrowing breaks constructors). Each gets a one-line rationale in the changeset.
3. **Decide the suite-pin policy (B)** once; apply to all 8 sites (waiver + rule-6 correction, or widen-to-`SuiteId`).
4. **Only now**: remove all 130 `: true as _\w+` casts and add the drift gate `check-wire-schema-parity-bites` (forbid `true as _\w+` in `_TYPE_PARITY` value lines; adversarial probe per `check-gates-effective`). Correct `wire-schemas/CLAUDE.md` rule 5 to name the gate as the proof of sync.
5. Keep the `_PD2` probe as a committed dev tool under `packages/wire-schemas/src/__diagnostic/`, excluded from the npm tarball via the package `files` allowlist / `.npmignore` (not `.gitignore`), verified with `pnpm pack --dry-run`.

Never weaken the check to pass — fix the divergence (`feedback_coverage_thresholds`-shaped). See `architecture_synchronization_invariants`, `feedback_legibility_ratio`.
