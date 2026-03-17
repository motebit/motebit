# create-motebit Changelog

## 0.3.1

### Patch Changes

- [`cc5faa4`](https://github.com/motebit/motebit/commit/cc5faa4044e3c441a40c2da8a56eebcdd8a9994c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - Harden build: switch to tsup for robust shebang injection, inject version strings at build time to eliminate drift, bundle all dependencies into single zero-dep output.

All notable changes to `create-motebit` are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.3.0] - 2026-03-13

### Changed

- Uses `@motebit/verify@0.3.0` with DID and bundle verification support

## [0.2.0] - 2026-03-10

### Changed

- Published to npm with provenance

## [0.1.2] - 2026-03-09

### Fixed

- Dependency on unpublished package; use `@motebit/verify` directly

## [0.1.1] - 2026-03-09

### Fixed

- License corrected from Community License to MIT

## [0.1.0] - 2026-03-08

### Added

- `npm create motebit` CLI scaffolder for generating signed agent identities
- Ed25519 keypair generation and `motebit.md` file creation
- Interactive prompts for agent name, description, and capabilities
- MIT licensed
