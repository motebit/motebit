# @motebit/verify Changelog

All notable changes to `@motebit/verify` are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [Unreleased]

### Added

- `did` field in `VerifyResult` — every verified identity now includes its W3C `did:key` Decentralized Identifier

## [0.2.0] - 2026-03-10

### Added

- Published to npm with provenance

## [0.1.0] - 2026-03-08

### Added

- Ed25519 signature verification for `motebit.md` identity files
- `verifyIdentityFile(content)` — parse, validate, and verify signed agent identities
- MIT licensed, zero monorepo dependencies
