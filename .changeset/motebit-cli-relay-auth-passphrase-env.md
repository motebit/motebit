---
"motebit": patch
---

`motebit` CLI now honors `MOTEBIT_PASSPHRASE` for relay-auth token minting.

**Bump level**: patch. This is a repaired promise, not an expanded one — `MOTEBIT_PASSPHRASE` is a generic-sounding env var the user reasonably expects to work everywhere a passphrase is needed. The previous behavior (env var works for `--yes` and rotate/export/attest, silently ignored by relay-auth) was internal inconsistency, not a deliberate restriction. Fixing it brings behavior in line with the env var's documented role.

Gap #6 from the 2026-04-25 first-time-user walkthrough. `getRelayAuthHeaders()` (the function that mints a signed device token when no `MOTEBIT_API_TOKEN` master token is present) called `promptPassphrase()` unconditionally — it didn't read `MOTEBIT_PASSPHRASE` the way every other unlock prompt in the CLI does. Result: any scripted use of `motebit credentials`, `motebit export`, `motebit attest`, etc. silently hung waiting on a hidden TTY prompt. The exact reproduction was running `MOTEBIT_PASSPHRASE=x npx motebit credentials` and watching it block on `Passphrase (for relay auth):` despite the env var being set.

What changed:

- `apps/cli/src/subcommands/_helpers.ts::getRelayAuthHeaders()` now reads `process.env["MOTEBIT_PASSPHRASE"]` before falling back to the interactive prompt. Same pattern as `apps/cli/src/index.ts:401`, `subcommands/rotate.ts:104`, `subcommands/export.ts:44`, `subcommands/attest.ts:97` — those already honored the env var; only `getRelayAuthHeaders` didn't.
- The prompt label drops the `(for relay auth)` parenthetical and is now just `Passphrase: ` to match every other unlock prompt. The previous label implied a separate passphrase concept that doesn't exist — the relay-auth token is signed by the same Ed25519 private key encrypted under `cli_encrypted_key`, unlocked by the same passphrase the user set during `create-motebit`.
- New `apps/cli/src/__tests__/relay-auth-passphrase.test.ts` regression test asserts: env var skips the prompt, no env var falls back to prompting with the new `Passphrase: ` label, and `MOTEBIT_API_TOKEN` master token shortcuts the passphrase path entirely (existing behavior preserved).

Migration: scripts that piped a passphrase via stdin to `motebit` commands as a workaround for the silent prompt no longer need the workaround — set `MOTEBIT_PASSPHRASE` in the environment instead. Interactive use is unchanged except for the simpler prompt text.

Architectural note for future readers: the auth strategy in `getRelayAuthHeaders` is a 2-tier fallback — `MOTEBIT_API_TOKEN`/`MOTEBIT_SYNC_TOKEN` master token first, signed device token second. The signed device token is JWT-shaped (5-minute expiry, audience-scoped) and minted from the local key. There is no third "relay auth secret" concept; that misimpression was created by the prompt label.
