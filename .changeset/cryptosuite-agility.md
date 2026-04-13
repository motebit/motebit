---
"@motebit/protocol": major
"@motebit/crypto": major
"@motebit/sdk": major
"create-motebit": major
"motebit": major
---

Add cryptosuite discriminator to every signed wire-format artifact.

`@motebit/protocol` now exports `SuiteId`, `SuiteEntry`, `SuiteStatus`,
`SuiteAlgorithm`, `SuiteCanonicalization`, `SuiteSignatureEncoding`,
`SuitePublicKeyEncoding`, `SUITE_REGISTRY`, `ALL_SUITE_IDS`, `isSuiteId`,
`getSuiteEntry`. Every signed artifact type gains a required `suite:
SuiteId` field alongside `signature`. Four Ed25519 suites enumerated
(`motebit-jcs-ed25519-b64-v1`, `motebit-jcs-ed25519-hex-v1`,
`motebit-jwt-ed25519-v1`, `motebit-concat-ed25519-hex-v1`) plus the
existing W3C `eddsa-jcs-2022` for Verifiable Credentials.

Verifiers reject missing or unknown `suite` values fail-closed. No
legacy compatibility path. Signers emit `suite` on every new artifact.

Identity file signature format changed:

- Old: `<!-- motebit:sig:Ed25519:{hex} -->`
- New: `<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:{hex} -->`

The `identity.algorithm` frontmatter field is deprecated (ignored with
a warning when present; no longer emitted on export).

Post-quantum migration becomes a new `SuiteId` entry + dispatch arm in
`@motebit/crypto/suite-dispatch.ts`, not a wire-format change.

## Migration

This release is breaking for every consumer that constructs, signs, or verifies a motebit signed artifact. The change is mechanical — add one field on construction, pass one argument on sign, re-sign identity files once — but there is no legacy acceptance path, so every caller must update in lockstep. Verifiers reject unsuited or unknown-suite artifacts fail-closed. Migration steps follow, grouped by the consumer surface.

### For consumers of `@motebit/protocol` types

Every signed-artifact type now has a required `suite: SuiteId` field.
Anywhere you construct one (tests, mocks, fixtures), add the correct
suite value for that artifact class — see `SUITE_REGISTRY`'s
`description` field for the per-artifact assignment, or consult
`spec/<artifact>-v1.md §N.N` for the binding wire format.

```ts
// Before
const receipt: ExecutionReceipt = {
  task_id, motebit_id, ...,
  signature: sigHex,
};

// After
import type { SuiteId } from "@motebit/protocol";
const receipt: ExecutionReceipt = {
  task_id, motebit_id, ...,
  suite: "motebit-jcs-ed25519-b64-v1" satisfies SuiteId,
  signature: sigHex,
};
```

### For consumers of `@motebit/crypto` sign/verify helpers

Sign helpers that previously accepted just keys now require a `suite`
parameter constrained to the suites valid for the artifact class:

```ts
// Before
const receipt = await signExecutionReceipt(body, privateKey);

// After
const receipt = await signExecutionReceipt(body, privateKey, {
  suite: "motebit-jcs-ed25519-b64-v1",
});
```

Verify helpers route through the internal `verifyBySuite` dispatcher;
direct calls are unchanged at the boundary, but behavior now rejects
artifacts without a `suite` field (legacy-no-suite path is deleted).

### For consumers of `motebit.md` identity files

Identity files signed before this release will fail to parse. Re-sign
by running `motebit export --regenerate` (or the CLI equivalent) after
upgrading. The `identity.algorithm` YAML field is ignored on new
parses and no longer emitted on export.

### For consumers of `DelegationToken` (`@motebit/crypto`)

`DelegationToken` carries two breaking changes beyond the suite addition.
Public keys are now **hex-encoded** (64 chars, lowercase) instead of
base64url — consistent with every other Ed25519-key-carrying motebit
artifact. And `signDelegation` takes `Omit<DelegationToken, "signature"
| "suite">` (the signer stamps the suite).

```ts
// Before
const token = await signDelegation(
  {
    delegator_id,
    delegator_public_key: toBase64Url(kp.publicKey),
    delegate_id,
    delegate_public_key: toBase64Url(otherKp.publicKey),
    scope,
    issued_at,
    expires_at,
  },
  kp.privateKey,
);

// After
const token = await signDelegation(
  {
    delegator_id,
    delegator_public_key: bytesToHex(kp.publicKey),
    delegate_id,
    delegate_public_key: bytesToHex(otherKp.publicKey),
    scope,
    issued_at,
    expires_at,
  },
  kp.privateKey,
);
// token.suite is stamped as "motebit-jcs-ed25519-b64-v1"
```

Verifiers reject tokens without `suite` (or with any value other than
`"motebit-jcs-ed25519-b64-v1"`) fail-closed, and decode `delegator_public_key`
from hex. Base64url-encoded tokens issued before this release do not
verify — pre-launch, no migration tool is provided; re-issue tokens
after upgrading.

### Running the new drift gates locally

`pnpm run check` now runs ten drift gates (previously eight). Two new
gates — `check-suite-declared` and `check-suite-dispatch` — enforce
that every signed Wire-format spec section names a `suite` field and
that every verifier in `@motebit/crypto` dispatches via the shared
`verifyBySuite` function (no direct primitive calls).
