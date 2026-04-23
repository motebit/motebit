---
"@motebit/verify": major
---

**`@motebit/verify` flipped from BSL-1.1 to Apache-2.0. The full verification lineage now ships on the permissive floor.**

The `motebit-verify` CLI was the last BSL holdout in the verification lineage. It was shipped BSL on 2026-04-22 (commit 58c6d99d) on the theory that the motebit-canonical defaults (bundle IDs `com.motebit.mobile`, RP ID `motebit.com`, integrity floor `MEETS_DEVICE_INTEGRITY`) + CLI ergonomics constituted motebit-proprietary composition worth protecting. On review the next day that framing didn't hold:

- The "defaults" are CLI flags with fallback values — overridable via `--bundle-id`, `--android-package`, `--rp-id`, and the `HardwareVerifierBundleConfig` object. Not trust scoring, not economics, not federation routing. No moat code.
- The `motebit` operator console (BSL, correctly) already contains `motebit verify <path>` as a convenience subcommand. That path covers operators who've accepted BSL for the full runtime. `@motebit/verify` exists to serve a different shape of user — CI pipelines, enterprise audit tooling, third-party verifier integrators — who want a narrow install without the operator runtime. BSL on that tool creates friction (enterprise license-review) without protecting any motebit moat.
- The surrounding stack already shipped Apache on 2026-04-23 (commit 2d8b91a9): `@motebit/verifier` (library), `@motebit/crypto` (primitives), four `@motebit/crypto-*` platform leaves, `@motebit/protocol`, `@motebit/sdk`, `create-motebit`, and `spec/`. The CLI at the top of that stack being BSL was an outlier — a one-outlier drift the convergence principle explicitly rejects.

## Migration

For downstream consumers: **no code change required.** Apache-2.0 is strictly broader than MIT or BSL — everything permitted under BSL remains permitted under Apache-2.0, plus the explicit patent grant and litigation-termination clause.

```diff
  // Before — install declaration
- // BSL-1.1: "may use personally / internally / for contribution; commercial service requires license"
+ // Apache-2.0: "may use for any purpose, including commercial; explicit patent grant"
  npm install -g @motebit/verify
  motebit-verify cred.json
```

CI pipelines that previously paused on BSL license review can proceed without one. Enterprise audit tooling that wants to bundle `motebit-verify` into a commercial product can do so under Apache-2.0 terms. The tool behavior, exit codes, CLI arguments, and programmatic API are unchanged.

Inbound contributions to `packages/verify/` are now Apache-2.0 inbound = outbound — same posture as the rest of the permissive floor. No re-signing required for prior contributors; inbound-equals-outbound does the right thing automatically.

## The new end-state boundary

- **Permissive floor (Apache-2.0):** `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `@motebit/verifier`, `@motebit/verify`, four `@motebit/crypto-*` platform leaves, `create-motebit`, `spec/`, GitHub Action. Ten packages + spec tree.
- **BSL-1.1 (converts to Apache-2.0 at Change Date):** `motebit` (operator console) and everything in the runtime (cognitive architecture, identity, infrastructure, economic layer, apps, services). Where motebit-proprietary judgment actually lives.
- **End state:** one license everywhere at the Change Date.

The drift gate `check-spec-permissive-boundary` has no new role — spec callables were already expected to resolve to a permissive-floor package, and `@motebit/verify` doesn't export spec callables anyway. `check-deps.ts` adds `@motebit/verify` to `PERMISSIVE_PACKAGES` and `PERMISSIVE_IMPORT_ALLOWED`; the MIT-purity / permissive-export gates apply unchanged.
