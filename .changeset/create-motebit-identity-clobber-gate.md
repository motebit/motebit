---
"create-motebit": minor
---

`create-motebit` refuses to clobber an existing identity in `--yes` mode without explicit `--force`.

Previously, `npx create-motebit my-agent --yes` silently overwrote the top-level fields of `~/.motebit/config.json` (`motebit_id`, `device_id`, `device_public_key`, `cli_encrypted_key`) if a motebit identity already existed there. The interactive path prompts about this; the non-interactive path did not. Discovered as gap #2 of the 2026-04-25 first-time-user walkthrough — running the CI-style smoke on a developer machine clobbered the user's real identity.

What changed:

- `--yes` mode now calls `assertNoExistingIdentity()` before generating; if `motebit_id` is populated in the resolved config (`MOTEBIT_CONFIG_DIR` or `~/.motebit/`), it errors with a message naming both escape hatches.
- New `--force` flag for explicit replacement.
- Error message points at `MOTEBIT_CONFIG_DIR=/tmp/foo` for isolated smoke runs and `--force` for intentional re-scaffolding.
- The gate applies to both the default scaffold and `--agent` mode.
- Interactive mode is unchanged — it already prompts the user about existing identities and that path was correct.

Three new regression tests in `index.test.ts` assert: the gate fires and the existing config file is unchanged byte-for-byte; `--force` overrides and merges the new identity over preserved non-identity fields; `--agent --yes` also enforces the gate.

Migration: automation that relied on `--yes` silently overwriting must add `--force`. CI smokes that run in fresh containers (no pre-existing config) are unaffected — release.yml's smoke test path is one such consumer and continues to work without changes.

Also: the scaffold's "Next steps" output now points users at `npx -p @motebit/verify motebit-verify motebit.md` (gap #4 from the same walkthrough — the unscoped `npx motebit-verify` returns 404 because the package is published as `@motebit/verify`).
