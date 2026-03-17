# @motebit/verify Changelog

All notable changes to `@motebit/verify` are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.4.0] - 2026-03-17

### Added

- Polymorphic `verify(artifact, options?)` — verifies any Motebit artifact: identity files, execution receipts, verifiable credentials, and verifiable presentations
- Discriminated union result types: `IdentityVerifyResult`, `ReceiptVerifyResult`, `CredentialVerifyResult`, `PresentationVerifyResult`
- Optional `expectedType` for fail-fast type checking
- Execution receipt verification: Ed25519 signature over canonical JSON, recursive delegation chain verification, embedded public key support
- Verifiable credential verification: eddsa-jcs-2022 Data Integrity proof, expiry checking
- Verifiable presentation verification: envelope proof + each contained credential verified independently
- `verifyIdentityFile()` legacy function for backward compatibility

### Changed

- `verify()` now accepts any artifact type (string or object), not just identity file strings
- Identity results include both `.error` (string, backward compat) and `.errors` (array, new)

## [0.3.0] - 2026-03-13

### Added

- `did` field in `VerifyResult` — every verified identity now includes its W3C `did:key` Decentralized Identifier
- Bundle directory verification: validates identity + credentials + presentations as a unit

## [0.2.0] - 2026-03-10

### Added

- Published to npm with provenance

## [0.1.0] - 2026-03-08

### Added

- Ed25519 signature verification for `motebit.md` identity files
- `verifyIdentityFile(content)` — parse, validate, and verify signed agent identities
- MIT licensed, zero monorepo dependencies
