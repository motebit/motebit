# @motebit/verify Changelog

## 0.5.1

### Patch Changes

- [`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

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
