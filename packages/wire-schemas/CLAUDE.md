# @motebit/wire-schemas

Zod runtime schemas for every motebit wire-format type. BSL-1.1. Layer 1. The package ships the TypeScript source that **generates** the committed JSON Schema artifacts; the committed artifacts themselves live under `spec/schemas/` (MIT) so they stay part of the permissively-licensed protocol surface third parties implement against.

## Two artifacts, two homes

| Artifact                   | Home                         | License                  | Role                                                    |
| -------------------------- | ---------------------------- | ------------------------ | ------------------------------------------------------- |
| Zod schemas (`src/*.ts`)   | `packages/wire-schemas/src/` | BSL-1.1                  | Motebit's opinionated runtime-validation of wire shapes |
| JSON Schemas (`*-v1.json`) | `spec/schemas/`              | MIT (stamped `$comment`) | Wire-format contracts third parties implement against   |

Separating the physical location by license boundary is cleaner than expressing a file-class split in a mixed-license package manifest. `pnpm --filter @motebit/wire-schemas build-schemas` writes out to `spec/schemas/` where the `spec/LICENSE` (MIT) covers the output; the writer is BSL code, the output is MIT data, and the two never touch each other's licensing.

## Rules

1. **The writer lives here, the artifacts live in `spec/schemas/`.** `scripts/build-schemas.ts` is the only path that writes to `spec/schemas/`. Editing the JSON files by hand is drift — run the build script.

2. **Every committed JSON Schema carries `$comment: "SPDX-License-Identifier: MIT"` as its first field.** `scripts/build-schemas.ts` stamps it automatically via `src/spdx-stamp.ts`. `src/__tests__/drift.test.ts` uses the same helper to match committed against live, so a stripped stamp is caught as drift — the permissive license is part of the contract itself.

3. **The Zod sources are the canonical definition; `spec/schemas/*.json` is generated, committed, drift-checked.** Don't edit JSON by hand. Run `pnpm --filter @motebit/wire-schemas build-schemas` after any zod edit. `drift.test.ts` regenerates live and diffs against committed; CI rejects drift.

4. **Every wire format in the protocol spec has exactly one zod schema here, one committed JSON in `spec/schemas/`, and one entry in the build-schemas list.** The three-way sync is enforced by `check-spec-wire-schemas` + `check-wire-schema-usage` + the in-package drift test.

5. **Dep discipline.** Depends on `@motebit/protocol` for the underlying types it mirrors + `zod` + `zod-to-json-schema`. No other monorepo deps. The `z.infer<...> extends ProtocolType` assignment-compatibility checks keep the zod shape and the protocol type in perfect sync.

6. **Cryptosuite-agility applies.** Every signed artifact's schema accepts the closed `SuiteId` union declared in `@motebit/protocol::crypto-suite.ts`. Adding a new suite means re-running `build-schemas` to regenerate JSON; the Zod schema picks up the new union automatically because it imports `SuiteId` from the protocol.

## Why the physical split over a mixed-license package

The earlier iteration kept both in-package with a `(BSL-1.1 AND MIT)` SPDX expression. That expression is wrong — `AND` means "both licenses apply to the whole work," which is not file-class split licensing. The honest alternative was `"SEE LICENSE IN LICENSE"` with a per-file-class description. That works but it pushes the reader through indirection at the manifest level.

Splitting physically — source code in a BSL package, generated artifacts in the MIT `spec/` tree — means the manifest says what it means (BSL, the whole package), third-party tooling (npm, GitHub, Snyk) renders the license correctly, and there's no special-case parsing of file classes to understand what's covered by what. Each directory inherits the license of its top-level parent. That's the cleanest end-state.

## Consumers

- `services/api` — runtime validation of inbound wire bodies (enforced by `check-wire-schema-usage` #35).
- Third-party validators / verifiers / observability tooling — clone or fetch `spec/schemas/*.json` and validate locally; the JSON files are self-contained under MIT.
- Drift gates (`drift.test.ts`, `check-spec-wire-schemas`, `check-wire-schema-usage`) — the canonical sources of truth that detect protocol/implementation divergence.
