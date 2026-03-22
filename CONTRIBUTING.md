# Contributing to Motebit

Thank you for your interest in contributing.

## How to help

- **Report bugs** -- file an [issue](https://github.com/motebit/motebit/issues/new?template=bug_report.yml) using the bug report template
- **Request features** -- file an [issue](https://github.com/motebit/motebit/issues/new?template=feature_request.yml) using the feature request template
- **Ask questions** -- use [GitHub Discussions](https://github.com/motebit/motebit/discussions)
- **Improve docs** -- fix typos, clarify guides, add examples
- **Add tests** -- test coverage is always welcome

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
apps/           Desktop (Tauri), CLI, Mobile (Expo), Web, Admin, Spatial
packages/       Shared libraries (runtime, crypto, identity, persistence, etc.)
services/       Backend services (sync relay, web-search)
spec/           Open specifications (identity-v1.md)
```

### Common commands

```bash
pnpm run build              # Build all packages
pnpm run test               # Test all packages
pnpm run typecheck          # Type-check all packages
pnpm run lint               # Lint all packages
pnpm --filter <pkg> build   # Build a single package
pnpm --filter <pkg> test    # Test a single package
```

## Pull requests

1. Fork the repo and create a branch from `main`
2. If you've added code, add tests
3. Ensure `pnpm run typecheck` and `pnpm run test` pass
4. **Add a changeset** describing your changes (see below)
5. Submit a pull request with a clear description of what and why

### Changesets

We use [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs for published packages. If your PR affects any published package (`@motebit/sdk`, `@motebit/verify`, `create-motebit`, or `motebit`), add a changeset:

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

Write clear, descriptive commit messages. Start with a verb: `Fix`, `Add`, `Update`, `Remove`, `Refactor`. Keep the first line under 72 characters.

## What we're not accepting yet

We're in early development. Large architectural changes or new packages will likely be declined -- not because they're bad ideas, but because we need to stabilize the core first. Bug fixes, documentation improvements, and test coverage are always welcome.

## Code style

- TypeScript throughout, strict mode
- Tests in `src/__tests__/` using vitest
- Error handling: `catch (err: unknown) { const msg = err instanceof Error ? err.message : String(err); }`
- No secrets in code -- OS keyring or environment variables only
- Prefer editing existing files over creating new ones
- No unnecessary abstractions -- three similar lines is better than a premature helper

## Contributor License Agreement

All contributors must sign our [Contributor License Agreement (CLA)](CLA.md) before their first pull request can be merged. This is a one-time process -- comment on your PR with the signing phrase and you're covered for all future contributions.

The CLA grants Motebit the rights needed to license contributions under our dual-license model. This is standard practice for BSL projects (HashiCorp, Sentry, CockroachDB).

## License

Contributions are licensed under the same terms as the project:

- **Protocol layer** (`spec/`, `packages/verify/`, `packages/create-motebit/`, `packages/sdk/`, `packages/github-action/`) -- MIT
- **Everything else** -- [BSL 1.1](LICENSE), source-available, converts to Apache 2.0 per-version after 4 years
