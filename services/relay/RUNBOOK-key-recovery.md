# Runbook — relay trust-root key backup & recovery

The relay's Ed25519 **identity key is the trust root.** It signs every
credential anchor, the operator-transparency declaration at
`/.well-known/motebit-transparency.json`, the federation handshake, and
every signed state-export bundle (`X-Motebit-Content-Manifest`). Third
parties pin this **public** key from the transparency declaration and
verify all of it offline, without ever contacting the relay.

The **private** key lives in exactly one place: the `relay_identity` row
in the relay's SQLite database on the Fly volume. If that volume is lost
and you have no backup, the identity is gone — and minting a fresh key
**invalidates every signature the relay ever issued** and breaks the
transparency-anchor chain. This is unrecoverable. Back it up.

The `relay-key` CLI (`services/relay/src/cli.ts`) does backup, verify, and
restore. **The private key never crosses the network** — these are
local-DB operations you run on the box via `fly ssh console`, never an
HTTP endpoint.

## Environment

| Variable                          | Meaning                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MOTEBIT_DB_PATH`                 | Path to the relay SQLite DB (the live volume path).                                                                    |
| `MOTEBIT_RELAY_KEY_PASSPHRASE`    | At-rest key passphrase. Required if the stored key is encrypted (it is in prod).                                       |
| `MOTEBIT_RELAY_BACKUP_PASSPHRASE` | Passphrase protecting the **backup artifact itself** — choose a NEW strong passphrase, independent of the at-rest one. |

The backup artifact encrypts the private key under
`MOTEBIT_RELAY_BACKUP_PASSPHRASE` (AES-256-GCM, PBKDF2-600K). Its
`public_key_hex` / `did` / `relay_motebit_id` are stored in the clear so
you can cross-check the artifact against the published transparency
declaration without decrypting it.

## 1. Back up (do this now, then quarterly)

```sh
fly ssh console -a <relay-app>
export MOTEBIT_RELAY_BACKUP_PASSPHRASE='<a new strong passphrase>'
pnpm --filter @motebit/relay relay-key export --out /tmp/relay-key-backup.json
```

Then get the file off the box and **store it offsite, in at least two
locations** (e.g. an encrypted password manager + an offline encrypted
drive). **Store `MOTEBIT_RELAY_BACKUP_PASSPHRASE` separately from the
artifact** — the artifact is useless without it, and co-locating them
defeats the encryption. The passphrase is itself unrecoverable; if you
lose it, the backup is inert.

## 2. Verify (touches no DB — run on the schedule)

Prove a backup is restorable and still matches what verifiers pin,
without going near the live database:

```sh
export MOTEBIT_RELAY_BACKUP_PASSPHRASE='<the backup passphrase>'
pnpm --filter @motebit/relay relay-key verify --in /path/to/relay-key-backup.json
```

It decrypts the key, re-derives the public key from it, and asserts the
match. **Cross-check the printed public key against
`https://<relay>/.well-known/motebit-transparency.json`.** Run this
quarterly — an unverified backup is a hope, not a backup.

## 3. Restore (after a volume loss, into a fresh DB)

```sh
fly ssh console -a <relay-app>
export MOTEBIT_DB_PATH='<the volume DB path>'
export MOTEBIT_RELAY_KEY_PASSPHRASE='<the at-rest passphrase to re-encrypt with>'
export MOTEBIT_RELAY_BACKUP_PASSPHRASE='<the backup passphrase>'
pnpm --filter @motebit/relay relay-key import --in /path/to/relay-key-backup.json
```

Restore verifies the backup cryptographically **before** any DB write, so
a corrupt or wrong-passphrase artifact can never reach the database.

- Into an **empty** DB → `Restored` (the normal recovery path).
- The DB already holds the **same** identity → `Re-imported` (idempotent;
  safe to re-run).
- The DB holds a **different** identity → **blocked.** Replacing it
  invalidates the current identity's signatures and breaks the
  transparency chain. Only if you are certain this DB should adopt the
  backup's identity, pass `--force-replace`. After a forced replace you
  MUST re-publish the transparency declaration for the restored key.

## Failure modes

| Symptom                                               | Cause / action                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `wrong backup passphrase, or the artifact is corrupt` | `MOTEBIT_RELAY_BACKUP_PASSPHRASE` is wrong, or the file is damaged. No DB write happened. |
| `backup checksum mismatch`                            | The artifact was edited or corrupted in transit. Use another copy.                        |
| `backup integrity failure: private key derives …`     | The artifact's private key doesn't match its claimed public key — do not use it.          |
| `refusing to replace a DIFFERENT relay identity`      | Intended safety stop. Confirm the target DB, then `--force-replace` if correct.           |
| `no relay identity found`                             | `MOTEBIT_DB_PATH` isn't pointing at the live relay DB.                                    |

## Threat model & future hardening

- v1 protects the artifact with a single passphrase. Splitting custody
  (Shamir secret sharing across operators) is a future hardening, not yet
  shipped — track alongside the phase-2 treasury-custody work in
  `docs/doctrine/treasury-custody.md`.
- The backup contains the full private key. Treat the artifact and its
  passphrase with the same care as the live key.
