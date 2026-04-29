# Contributing to Motebit

Thank you for your interest in contributing.

## How to help

- **Report bugs** -- file an [issue](https://github.com/motebit/motebit/issues/new?template=bug_report.yml) using the bug report template
- **Request features** -- file an [issue](https://github.com/motebit/motebit/issues/new?template=feature_request.yml) using the feature request template
- **Ask questions** -- use [GitHub Discussions](https://github.com/motebit/motebit/discussions)
- **Improve docs** -- fix typos, clarify guides, add examples
- **Add tests** -- test coverage is always welcome

**Security vulnerabilities** — do **not** file a public issue. Email `security@motebit.com` per the [security policy](SECURITY.md).

**Community standards** — all participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant v2.1).

## Before you code

Open an issue first. We want to discuss the approach before you invest time writing code. This saves everyone effort and keeps the codebase coherent.

## Development setup

**Prerequisites:** Node.js >= 20, pnpm 9.15

```bash
git clone https://github.com/motebit/motebit.git
cd motebit
pnpm install
pnpm run build
pnpm run test
```

### Project structure

```
apps/        10 surfaces and supporting apps (web, cli, desktop, mobile, spatial, inspector, operator, identity, docs, vscode)
packages/    48 packages on a 7-layer DAG enforced by `pnpm check-deps`
services/    8 backend services (1 relay + 2 molecules + 4 atoms + 1 glue)
spec/        22 open specifications, each `motebit/<name>@1.0`
```

Full directory tree, package roles, and layer breakdown live in [`apps/docs/content/docs/operator/architecture.mdx`](apps/docs/content/docs/operator/architecture.mdx) (the canonical source — gated by `check-docs-tree`).

### Common commands

```bash
pnpm run build              # Build all packages
pnpm run test               # Test all packages
pnpm run typecheck          # Type-check all packages
pnpm run lint               # Lint all packages
pnpm check                  # Run every hard CI gate (43 drift defenses)
pnpm --filter <pkg> build   # Build a single package
pnpm --filter <pkg> test    # Test a single package
```

### Before submitting a PR

- Run `pnpm check` locally — this is the same set of hard drift defenses CI enforces. If it fails, CI will too.
- Add a changeset (see below) if your PR touches a published-package path.
- Read [`CLAUDE.md`](CLAUDE.md) and the relevant per-directory `CLAUDE.md` files. Motebit is doctrine-driven; the `## Principles` section names invariants that, if violated, break CI or the architecture.
- A pre-commit hook runs `prettier` on staged files and requires a changeset entry for changes under any published-package path. This is normal — write the changeset.

## Pull requests

1. Fork the repo and create a branch from `main`
2. If you've added code, add tests
3. Ensure `pnpm run typecheck` and `pnpm run test` pass
4. **Add a changeset** describing your changes (see below)
5. Submit a pull request with a clear description of what and why

### Changesets

We use [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs for published packages. If your PR affects any published package — the canonical list lives in `.changeset/config.json` (the `ignore` field inverts to the published set; today there are 12: 11 Apache-2.0 packages + the `motebit` BSL runtime) — add a changeset:

```bash
pnpm changeset
```

This will prompt you to:

1. Select which packages are affected
2. Choose a bump type (`patch` for fixes, `minor` for features, `major` for breaking changes)
3. Write a summary of the change

The tool creates a markdown file in `.changeset/` — commit it with your PR. When we cut a release, all pending changesets are consumed to automatically bump versions and generate changelogs.

**When you don't need a changeset:** internal-only changes (tests, docs, CI, private packages) that don't affect published packages.

### Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>` on the first line, under 72 characters. Common types: `fix`, `feat`, `docs`, `chore`, `refactor`, `test`. Scope is usually the package or area (`fix(cli):`, `feat(market):`, `docs(trademark):`). Recent commits in `git log` are the working examples.

## What we're not accepting yet

We're in early development. Large architectural changes or new packages will likely be declined -- not because they're bad ideas, but because we need to stabilize the core first. Bug fixes, documentation improvements, and test coverage are always welcome.

## Code style

- TypeScript throughout, strict mode
- Tests in `src/__tests__/` using vitest
- Error rethrows: `throw new Error("description", { cause: err })`
- Error messages: `err instanceof Error ? err.message : String(err)`
- No secrets in code — OS keyring or environment variables only
- Prefer editing existing files over creating new ones
- No unnecessary abstractions — three similar lines is better than a premature helper

The full set of conventions lives in [`CLAUDE.md`](CLAUDE.md) § "Conventions".

## Contributor License Agreement

All contributors must sign our [Contributor License Agreement (CLA)](CLA.md) before their first pull request can be merged. This is a one-time process — comment on your first PR with the signing phrase defined in [CLA.md § "How to sign"](CLA.md#how-to-sign) and you're covered for all future contributions.

The CLA grants Motebit the rights needed to license contributions under our dual-license model. This is standard practice for BSL projects (HashiCorp, Sentry, CockroachDB).

## License

Inbound = outbound. Contributions are licensed under the same terms as the directory you are contributing to:

- **Permissive floor** (`spec/`, `packages/protocol/`, `packages/sdk/`, `packages/crypto/`, `packages/verifier/`, `packages/verify/`, `packages/crypto-appattest/`, `packages/crypto-android-keystore/`, `packages/crypto-play-integrity/`, `packages/crypto-tpm/`, `packages/crypto-webauthn/`, `packages/create-motebit/`, `packages/github-action/`) -- **Apache-2.0** (explicit patent grant + litigation-termination clause)
- **Everything else** -- [BSL 1.1](LICENSE), source-available, converts to Apache-2.0 per-version after 4 years

Both license families converge to Apache-2.0 at the Change Date — one license, one patent posture, one procurement decision in the end state.
