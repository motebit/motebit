---
"motebit": patch
---

Add `motebit migrate-keyring` — recovery path that re-encrypts a plaintext `~/.motebit/dev-keyring.json` private key under a passphrase and writes it as `cli_encrypted_key` in `~/.motebit/config.json`.

## Why

A live golden-path walkthrough turned up a class of users with a valid private key on disk under `~/.motebit/dev-keyring.json` (written by the desktop Tauri app's Keychain-failure fallback in `apps/desktop/src/identity-manager.ts:124`, or by older scaffold flows) but no `cli_encrypted_key` in `config.json`. The CLI's only response in this state was "no private key found" — the path of least resistance was to run the interactive setup again, which silently created a brand new identity and abandoned everything signed under the old `motebit_id`. That's the wrong escape valve for a sovereign-identity product whose moat is accumulated trust.

A check on one real install surfaced **three motebit identities** in `~/.motebit/`, accumulated over a month — each one created because there was no recovery doctrine for "I have the key, I just don't have it where the CLI looks." The CLI was treating identity creation as cheap and recovery as undocumented. Inverted priorities.

## What ships

`motebit migrate-keyring [--force]` does exactly one thing: takes the existing private key on disk, encrypts it under a passphrase you choose, and writes it as `cli_encrypted_key`. The current `motebit_id` is preserved. Nothing else changes.

The load-bearing defense is **fail-closed on key/public mismatch**. Before encrypting, the subcommand re-derives the public key from the private bytes and verifies it byte-equals `config.device_public_key`. If they don't match, the dev-keyring belongs to a different identity than your config — silently binding it would produce signed artifacts under one motebit_id but with a private key for another (the silent-corruption case `loadActiveSigningKey` already defends against at the read path). The error explains the orphaned-key situation and points at three concrete next moves: remove the orphaned keyring, restore from a `~/.motebit/config.json.clobbered-*` backup, or run a fresh `motebit init`.

Honors `MOTEBIT_PASSPHRASE` env for unattended / scripted use, matching the convention in `_helpers.getRelayAuthHeaders`, `register`, and `daemon`. Refuses to overwrite an existing `cli_encrypted_key` without `--force` (rotating the passphrase has a separate intent shape).

After successful migration, the plaintext `dev-keyring.json` is overwritten with zeros and unlinked — leaving plaintext keys on disk after the encrypted version exists is a security regression.

6 unit tests pin: happy path (migrate + remove plaintext), fail-closed on key/public mismatch (the load-bearing case — refuses to bind an orphaned key), refuses overwrite without --force, requires identity in config, refuses on passphrase mismatch, plus a sanity round-trip on `getPublicKeyBySuite` to catch suite-dispatch regressions that would silently break the match check.

## What this leaves on the table

The deeper architectural smell behind the multi-identity drift — `motebit` (no args) silently creating a new identity when config is partial-but-not-empty, scaffold tools and operator tools sharing `~/.motebit/`, no doctor probe for "you have N orphaned identities" — is named in the original audit but not addressed here. That's a sibling pass.
