---
"motebit": patch
---

First-run UX repair: canonical signing-key resolver + actionable doctor probes.

## Why

A live walkthrough of the golden path (`fund → delegate → settle`) on a real install surfaced that the CLI fails silently on every common first-run gap:

- `~/.motebit/config.json` with no `cli_encrypted_key` (clobber, partial setup, fresh install) → `motebit balance` errors with "no relay URL", `motebit wallet` errors with "No private key found", `motebit fund` never gets that far. None of these messages tell the user what to do.
- Identity not registered with the relay (`/agent/{id}/capabilities` → 404) → discovery, peer-trust pulls, and capability advertisement silently miss the user. Doctor reports all-ok.
- `sync_url` missing from config → every economic flow short-circuits before its first network call. Doctor reports all-ok.
- The same `if (config.cli_encrypted_key) { try / catch passphrase decrypt }` block was inlined across **five** call sites (register, daemon × 2, \_helpers, wallet) with subtly different error handling and prompt labels. Future contributors had no guard against adding a sixth.

None of this was hypothetical — it's exactly what a live `motebit doctor; motebit fund 1.00` run produced on a real installed identity that had been through the 2026-04-25 config-clobber-refusal flow (`85fb31f0`).

## What ships

### `loadActiveSigningKey(config, options?)` — canonical signing-key resolver

`apps/cli/src/identity.ts`. Single read site for `cli_encrypted_key` and the deprecated `cli_private_key`. Replaces five inline blocks; wires register, daemon (× 2), `getRelayAuthHeaders`, and `motebit wallet` through one helper.

Resolution order:

```text
1. cli_encrypted_key — passphrase from MOTEBIT_PASSPHRASE env or interactive prompt
2. cli_private_key — legacy plaintext (deprecated since 1.0.0, removed at 2.0.0); warns on use
```

**Defense the inline copies didn't have:** the helper re-derives the public key from the private bytes and verifies it byte-equals `config.device_public_key`. Fail-closed on mismatch. Inline copies would silently sign under the wrong identity — a downstream verifier rejecting the signature is an obvious failure, but signing as someone else is a silent one. The mismatch case is the load-bearing test.

Sources NOT supported (deliberate):

- **`~/.motebit/dev-keyring.json`.** Written by the desktop Tauri app's Keychain-failure fallback (`apps/desktop/src/identity-manager.ts:124`). Cross-surface keystore unification is a real architectural pass; a silent fallback chain is the wrong shape for it. The right shape is an explicit `IdentityKeyAdapter` per surface, same family as the storage adapter pattern. That's a separate commit.
- **Raw private-key bytes from environment variables.** Sovereign identity is not an env-friendly secret — env leaks through shell history, CI logs, process inspection, debug dumps. The passphrase env IS supported because the on-disk ciphertext is the actual secret; the passphrase is a scrypt-stretching factor, not the secret itself.

`IdentityKeyError` is a structured failure type carrying `kind` (`missing` / `decrypt-failed` / `malformed-private-key` / `public-key-mismatch`) and `remedy` (a one-line actionable next-step). Each call site catches the error and surfaces the remedy — `register` and `daemon` downgrade to unsigned / disabled with a warning that names the kind; `wallet` exits with the remedy printed; `_helpers.getRelayAuthHeaders` proceeds unauthenticated for read-only flows.

### `motebit doctor` — first-run actionable probes

Pre-1.0 doctor checked structural readiness only (Node, sqlite, identity-id-present). All-green doctor + every economic flow failing was the wrong signal. The expanded doctor adds three probes that run unconditionally and three that run when `sync_url` is set:

```text
Identity key         present + shape (cli_encrypted_key | cli_private_key | missing)
Public key           device_public_key present + 32-byte hex
Sync URL             configured in config or MOTEBIT_SYNC_URL env
Relay reachable      GET /health/ready returns 2xx (5s timeout)
Identity registered  GET /agent/:id/capabilities returns 200 (5s timeout)
```

Each failure carries a concrete remedy: `restore from ~/.motebit/config.json.clobbered-{date}` (when a clobbered backup is detected on disk), `run motebit init`, `run motebit register`, etc. Probes are best-effort with timeouts so doctor stays unattended-friendly — a misconfigured URL or network failure doesn't hang the command.

### Promoted `getPublicKeyBySuite` to `@motebit/encryption`

The helper needed to derive a public key from a private seed to verify the device-public match. Per `check-app-primitives` doctrine, apps consume product vocabulary (`@motebit/encryption`), not Layer-0 protocol primitives (`@motebit/crypto`). `getPublicKeyBySuite` was already exported from `@motebit/crypto`'s `signing.ts` re-exports; this commit re-exports it from `@motebit/encryption`'s barrel as the product-vocabulary pair to `generateKeypair` for "I have a private seed, give me the public."

## What's deliberately NOT in this commit

- **Cross-surface keystore unification.** `IdentityKeyAdapter` interface across CLI / desktop / mobile / web. The dev-keyring fallback question feeds into this; the right answer is per-surface adapters with explicit type, not a fallback chain at any single read site. Separate architectural pass.
- **Restoring Daniel's specific environment.** This commit fixes the code so that future first-run users hit `doctor` and see what to do. Daniel's existing `~/.motebit/config.json` still needs `cli_encrypted_key` restored from the clobbered backup (or a fresh `motebit init`); doctor now points at that exact remedy.
- **Running real `motebit fund` / `delegate` / `settle`.** Those require Daniel's Stripe interaction and decrypted signing key; doctor's job is to surface gaps, not move money.

## Verification

- 9 new unit tests in `identity-load-active-signing-key.test.ts` — happy path, env passphrase, legacy plaintext (with deprecation warn), missing key, wrong passphrase, public-key mismatch (fail-closed), skipped-mismatch escape hatch, malformed bytes, missing-public-key edge.
- 3 boundary tests in `relay-auth-passphrase.test.ts` (rewritten to match new helper boundary): resolver invoked when no master token, master token shortcuts resolver entirely, resolver throw downgrades to unauthenticated.
- All 199 CLI tests pass; all 42 drift defenses pass.
- Live run on a real broken config produced two clear `FAIL` lines with correct remedies pointing at a clobbered backup that exists on disk and at `motebit register`.

Operator-facing surface unchanged: subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes all preserve their 1.0.0 contract.
