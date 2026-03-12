# Changelog

All notable changes to the published packages are documented here. This project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- W3C `did:key` DID interoperability across all identity surfaces — every Ed25519 public key now derives a self-resolving Decentralized Identifier
- `motebit id` CLI subcommand — display identity card (motebit_id, did:key, public key, device) without file verification
- `did` field in `VerifyResult` (verify), `AgentCapabilities` (SDK), MCP `motebit_identity` tool, and API capabilities/discover endpoints
- DID display in desktop settings, mobile settings, and admin dashboard
- Spec §10: DID Interoperability section in `identity-v1.md`

### Fixed

- Dead `hasExplicitChoice` variable in web and desktop theme (sibling boundary)

## [0.2.2] - 2026-03-12

### Fixed

- Desktop build: removed unused variable that broke CI typecheck

## [0.2.0] - 2026-03-10

### Added

- `motebit` CLI published to npm — REPL, daemon mode, operator console, MCP server mode
- `@motebit/sdk` published to npm — core protocol types (MIT)
- Documentation site at docs.motebit.com — 13 guide pages covering identity, governance, memory, delegation, architecture
- Social preview banner for GitHub repository
- Public repo infrastructure: CONTRIBUTING.md, SECURITY.md, issue templates, CODEOWNERS

### Fixed

- Three security bugs: salted PIN hash, stale caller identity cache, WebSocket fan-out guard
- Mobile app entry point and Metro config
- Sync relay Docker deployment (sql.js fallback)
- GitHub URLs unified under motebit org after repo transfer

### Changed

- Dual-license structure: BSL 1.1 (implementation) + MIT (protocol layer)
- Full codebase formatted with Prettier
- All lint errors resolved (down to ~466 warnings)

## [0.1.2] - 2026-03-09

### Fixed

- `create-motebit`: fixed dependency on unpublished package; use `@motebit/verify` directly

## [0.1.1] - 2026-03-09

### Fixed

- `create-motebit`: corrected license from Community License to MIT

## [0.1.0] - 2026-03-08

### Added

- `@motebit/verify`: Ed25519 signature verification for `motebit.md` identity files
- `create-motebit`: CLI scaffolder (`npm create motebit`) for generating signed agent identities
- `spec/identity-v1.md`: open specification for the `motebit/identity@1.0` file format
- npm provenance enabled for supply chain transparency
