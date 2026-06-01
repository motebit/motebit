# @motebit/wire-schemas

Zod runtime schemas for every motebit wire-format type. BSL-1.1. Layer 1. The package ships the TypeScript source that **generates** the committed JSON Schema artifacts; the committed artifacts themselves live under `spec/schemas/` (Apache-2.0) so they stay part of the permissively-licensed protocol surface third parties implement against.

## Two artifacts, two homes

| Artifact                   | Home                         | License                         | Role                                                    |
| -------------------------- | ---------------------------- | ------------------------------- | ------------------------------------------------------- |
| Zod schemas (`src/*.ts`)   | `packages/wire-schemas/src/` | BSL-1.1                         | Motebit's opinionated runtime-validation of wire shapes |
| JSON Schemas (`*-v1.json`) | `spec/schemas/`              | Apache-2.0 (stamped `$comment`) | Wire-format contracts third parties implement against   |

Separating the physical location by license boundary is cleaner than expressing a file-class split in a mixed-license package manifest. `pnpm --filter @motebit/wire-schemas build-schemas` writes out to `spec/schemas/` where the `spec/LICENSE` (Apache-2.0) covers the output; the writer is BSL code, the output is Apache-2.0 data, and the two never touch each other's licensing.

## Rules

1. **The writer lives here, the artifacts live in `spec/schemas/`.** `scripts/build-schemas.ts` is the only path that writes to `spec/schemas/`. Editing the JSON files by hand is drift — run the build script.

2. **Every committed JSON Schema carries `$comment: "SPDX-License-Identifier: Apache-2.0"` as its first field.** `scripts/build-schemas.ts` stamps it automatically via `src/spdx-stamp.ts`. `src/__tests__/drift.test.ts` uses the same helper to match committed against live, so a stripped stamp is caught as drift — the permissive license is part of the contract itself.

3. **The Zod sources are the canonical definition; `spec/schemas/*.json` is generated, committed, drift-checked.** Don't edit JSON by hand. Run `pnpm --filter @motebit/wire-schemas build-schemas` after any zod edit. `drift.test.ts` regenerates live and diffs against committed; CI rejects drift.

4. **Every wire format in the protocol spec has exactly one zod schema here, one committed JSON in `spec/schemas/`, and one entry in the build-schemas list.** The three-way sync is enforced by `check-spec-wire-schemas` + `check-wire-schema-usage` + the in-package drift test.

5. **Dep discipline + the parity check that bites.** Depends on `@motebit/protocol` for the underlying types it mirrors + `zod` + `zod-to-json-schema`. No other monorepo deps. Each schema carries a `_*_TYPE_PARITY` block (`ParityForward`/`ParityReverse` over the shared `Relax` normalizer in `src/__parity/check.ts`) asserting the zod shape and the protocol type agree on the wire (drift invariant #22). It is **live**, not decorative: the value lines are bare `forward: true`, which typechecks only when the parity alias resolves to `true` — on drift it resolves to `never`, and `true` is not assignable to `never`, so `tsc` fails. Do **not** write `forward: true as _ForwardCheck`: that cast is a legal `true as never` assertion that swallows the drift and silently re-inerts the check (the cast-hole the whole `Relax` arc closed — see `docs/parity-inventory.md`). `check-wire-schema-parity-bites` (#115) forecloses the re-inerting idioms across `src/` — any cast on the parity literal (incl. `as never`, parenthesized, or line-split), a `@ts-expect-error`/`@ts-ignore` on the value, and deleting/omitting a block (every schema-defining file must carry one). It does not (cannot, textually) catch a `_*Check` alias widened to `boolean` or an `any` smuggled into the parity chain — those stay reviewer-caught — so the gate forecloses the idioms, it does not make every false-pass unrepresentable. When a genuine zod representational limit makes a correct schema fail parity (e.g. `z.unknown()` keys are unconditionally optional, so a required `content` reads as `content?`), the sanctioned fix is **not** a cast but a typed `// parity-divergence:` correction of the schema-inferred type that keeps the comparison live with runtime untouched — see the worked A6 example in `transparency-declaration.ts` (`Omit<_Inferred, "content"> & { content: unknown }`). `Relax` normalizes wire-equivalent-but-type-nominally-distinct protocol constructs (branded ids, nominal enums, `readonly` arrays, discriminated unions) so the check surfaces only REAL protocol↔schema divergence; `.passthrough()` envelopes are intentionally wire-open (their `[k: string]: unknown` absorbs extra keys) and parity cannot constrain that openness — by design, per `forward compatibility`. `src/__parity/check.test-types.ts` locks `Relax` itself against regression.

6. **Each signed artifact pins its single suite — never the `SuiteId` union.** Every signed artifact's schema MUST pin its `suite` field to the `z.literal(...)` matching the cryptosuite that artifact's spec section declares (e.g. `ExecutionReceipt` → `motebit-jcs-ed25519-b64-v1`; agent-settlement-anchor batch → `motebit-jcs-ed25519-hex-v1`; the suite differs by artifact family — b64url vs hex). The `@motebit/protocol` type pins the same literal (not `SuiteId`), so the two agree. Cryptosuite agility happens through a **new artifact version with a new schema pin**, never by widening to `SuiteId` — an artifact must never accept a suite it does not sign with, and runtime cross-suite confusion fails fail-closed at the schema boundary. (A blanket "schema accepts the `SuiteId` union" would be wrong on both counts; the schemas pin a literal and do not import `SuiteId`.)

## Why the physical split over a mixed-license package

The earlier iteration kept both in-package with a `(BSL-1.1 AND Apache-2.0)` SPDX expression. That expression is wrong — `AND` means "both licenses apply to the whole work," which is not file-class split licensing. The honest alternative was `"SEE LICENSE IN LICENSE"` with a per-file-class description. That works but it pushes the reader through indirection at the manifest level.

Splitting physically — source code in a BSL package, generated artifacts in the Apache-2.0 `spec/` tree — means the manifest says what it means (BSL, the whole package), third-party tooling (npm, GitHub, Snyk) renders the license correctly, and there's no special-case parsing of file classes to understand what's covered by what. Each directory inherits the license of its top-level parent. That's the cleanest end-state.

## Consumers

- `services/relay` — runtime validation of inbound wire bodies (enforced by `check-wire-schema-usage` #35).
- Third-party validators / verifiers / observability tooling — clone or fetch `spec/schemas/*.json` and validate locally; the JSON files are self-contained under Apache-2.0.
- Drift gates (`drift.test.ts`, `check-spec-wire-schemas`, `check-wire-schema-usage`) — the canonical sources of truth that detect protocol/implementation divergence.
