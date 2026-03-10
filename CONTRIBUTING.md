# Contributing to Motebit

Thank you for your interest in contributing.

## How to help

- **Report bugs** — file an issue using the bug report template
- **Request features** — file an issue using the feature request template
- **Ask questions** — use GitHub Discussions

## Before you code

Open an issue first. We want to discuss the approach before you invest time writing code. This saves everyone effort and keeps the codebase coherent.

## Pull requests

1. Fork the repo and create a branch from `main`
2. If you've added code, add tests
3. Ensure `pnpm run typecheck` and `pnpm run test` pass
4. Submit a pull request with a clear description of what and why

By submitting a pull request, you agree that your contributions are licensed under the same terms as the project (BSL 1.1 for platform code, MIT for protocol packages in `spec/`, `packages/verify/`, `packages/create-motebit/`).

## What we're not accepting yet

We're in early development. Large architectural changes or new packages will likely be declined — not because they're bad ideas, but because we need to stabilize the core first. Bug fixes, documentation improvements, and test coverage are always welcome.

## Code style

- TypeScript throughout, strict mode
- Tests in `src/__tests__/` using vitest
- Error handling: `catch (err: unknown) { const msg = err instanceof Error ? err.message : String(err); }`
- No secrets in code — OS keyring or environment variables only

## License

The protocol layer (`spec/`, `packages/verify/`, `packages/create-motebit/`) is MIT licensed. Everything else is [BSL 1.1](LICENSE) — source-available, free to use, converts to MIT per-version after 4 years.
