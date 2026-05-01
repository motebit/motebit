# Promoting a private package to public

Motebit ships 12 packages to npm and keeps 54 workspace-internal at `0.0.0-private`. The boundary is settled by [`docs/doctrine/protocol-model.md`](protocol-model.md) and the sentinel commit `fa5fdfeb` (2026-04-24). This file documents the _process_ — what to do when a real third-party trigger arrives and a private package needs to become public.

## The trigger condition

Promote a package only when **all** of the following hold:

1. **A real consumer exists.** Someone outside motebit has named the symbol they need to import. Hypothetical demand ("a third party might want this") does not qualify. The metabolic principle: don't manufacture a public API for a consumer who doesn't exist yet.
2. **The symbol cannot be re-exported through an existing public package instead.** If `@motebit/sdk`'s re-export surface can cover the consumer's need by widening (`packages/sdk/src/index.ts`), do that — it's strictly cheaper. Run `pnpm tsx scripts/audit-doc-imports-vs-sdk.ts` to surface the SDK-coverage gap.
3. **The API is stable enough to support.** The internal API has held its current shape for at least one minor cycle. Symbols that churn every refactor are not promotion candidates.
4. **The consumer accepts semver-major-bump cadence.** Promoting binds future motebit to changeset discipline (`check-changeset-discipline`, `check-api-surface`). The consumer needs to be able to absorb major bumps when motebit's internal model evolves.
5. **The license decision is settled.** Apache-2.0 (permissive floor) or BSL-1.1 (reference implementation, source-available, converging at the Change Date). The choice is doctrinal — see [`protocol-model.md`](protocol-model.md). Motebit does not publish to npm under any other license.

If any of the five fails, **do not promote**. The fallback path is to keep the package private and either (a) widen the SDK re-export surface for the specific symbol the consumer needs, (b) wrap the consumer's example in `<ReferenceExample>` in the docs and ship it as reference-implementation context, or (c) tell the consumer the public path is "implement the spec or read the source."

## The promotion playbook

Once the trigger conditions hold, the sequence is mechanical. Each step has a check that activates after it lands.

### 1. Flip the privacy field

Edit `packages/<name>/package.json`:

- Remove `"private": true` (or set to `false`).
- Set `"version": "1.0.0"` (the convention motebit's other published packages use; pre-1.0 with explicit `@experimental` annotations is the alternative if API stability is uncertain — see step 4).
- Confirm `"name"` matches the npm scope motebit owns (`@motebit/<name>` or one of the unscoped names like `motebit` and `create-motebit`).

This change alone removes the package from the `check-doc-private-imports` (#50) gate's tracked set — wraps that referenced this package will no longer be required. **Do not delete those wraps until step 6 is done**; the wraps are still doctrinally correct until consumers can install the package.

### 2. Add the license file

`packages/<name>/LICENSE` — Apache-2.0 or BSL-1.1, matching the package's role. If BSL, include the four-year Change Date language (see `LICENSING.md`).

### 3. Add a `README.md`

`packages/<name>/README.md` — published to npm as the package's landing page. Mirror the shape of an existing public package's README (e.g. `packages/protocol/README.md`).

### 4. Generate the api-extractor baseline

```bash
pnpm --filter @motebit/<name> build
pnpm --filter @motebit/<name> api:extract
```

This produces `packages/<name>/etc/<name>.api.md` — the locked public surface that `check-api-surface` enforces against. Commit the baseline.

If parts of the API are intentionally still in flux, annotate them with `@experimental` and the four-field temporal-sanity contract (`@since`, `@stabilizes_by`, `@removed_in_alternative`, `@reason`) per the spec-tools / spec-routes invariant pattern (#47, #48). `check-deprecation-discipline` rejects any `@experimental` whose `@stabilizes_by` is past-due.

### 5. Add the package to `check-api-surface`'s tracked roster

`scripts/check-api-surface.ts` already scans `packages/*/etc/*.api.md` automatically once the baseline exists. No manual roster update needed — but verify by running `pnpm check-api-surface` and confirming the package appears in the report.

### 6. Update the public-surface docs

Three doc surfaces drift in step here. All must move:

- [`apps/docs/content/docs/concepts/public-surface.mdx`](../../apps/docs/content/docs/concepts/public-surface.mdx) — add the new package to the published-packages table; subtract from the workspace-private count.
- [`apps/docs/content/docs/developer/api-reference.mdx`](../../apps/docs/content/docs/developer/api-reference.mdx) — add the new package's row in the api-extractor baseline table, with link to the committed `etc/<name>.api.md`.
- [`README.md`](../../README.md) — update the "N npm packages publish at 1.0.0" sentence and the package table. Confirm `check-doc-counts` (#45) still passes — it derives `publishedTotal` / `publishedApache` / `publishedBsl` / `privatePackages` from `package.json` and compares against probes anchored on this README sentence (and siblings in `changelog.mdx`, `public-surface.mdx`, this doctrine page), so the prose counts must match the new totals.

If wraps in `<ReferenceExample>` referenced this package, unwrap them now. Replace with plain `import` statements naming the now-public package. Run `pnpm check-doc-private-imports` and `pnpm tsx scripts/audit-doc-imports-vs-sdk.ts` to confirm both report clean.

### 7. Land a `major` changeset

```bash
pnpm changeset
```

Pick `major` for the new package. The body MUST include a `## Migration` section explaining what consumers gain and what — if anything — they need to do (this is the change _this_ package makes; the migration is from "you couldn't install it" to "you can"). `check-changeset-discipline` (#43) enforces the section's presence on `major` bumps.

The first publish flows through the normal Changesets release pipeline. GitHub Releases auto-generates human-readable release notes per [`apps/docs/content/docs/changelog.mdx`](../../apps/docs/content/docs/changelog.mdx).

## What changes after promotion

The same package now sits under a different doctrine. Future contributors editing it must:

- Treat refactors as public-API decisions. `check-api-surface` will reject any export-shape change without an explicit `major` changeset.
- Annotate experimental APIs with the temporal-sanity contract per `check-deprecation-discipline` and the spec-faithfulness family.
- Not delete an export without going through the [`docs/doctrine/deprecation-lifecycle.md`](deprecation-lifecycle.md) flow (deprecate, name `removed in`, ship the alternative, remove on the named version).

The cost of these promises is real. That is why the trigger condition is "a real consumer exists" — promoting on hypothesis adds permanent maintenance surface for nothing in exchange.

## Reverse direction: making a public package private

This is doctrinally possible (a `major` changeset can deprecate the package and remove it), but the friction is high enough that motebit has never done it. The published packages have committed downstream consumers; pulling one back creates an upgrade obligation for everyone who imported it. If the situation arises, the path is:

1. Annotate every public symbol with `@deprecated` + the four-field contract.
2. Land a `major` changeset naming the deprecation, with a `## Migration` section pointing consumers to the replacement.
3. Wait at least one minor release for the deprecation to propagate.
4. Land a second `major` changeset removing the exports and flipping `"private": true`.

This sequence is the [`deprecation-lifecycle.md`](deprecation-lifecycle.md) flow applied to a whole package rather than an individual symbol. It is slow by design — the friction is the feature.

---

The simplest version of this doctrine: **public packages carry promises, private packages don't, and the trigger to convert is real-consumer-shaped, not docs-convenience-shaped.**

Related: [`docs/doctrine/protocol-model.md`](protocol-model.md), [`docs/doctrine/deprecation-lifecycle.md`](deprecation-lifecycle.md), [`apps/docs/content/docs/concepts/public-surface.mdx`](../../apps/docs/content/docs/concepts/public-surface.mdx), [`scripts/audit-doc-imports-vs-sdk.ts`](../../scripts/audit-doc-imports-vs-sdk.ts).
