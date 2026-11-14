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

## 4. Before any destructive key replacement

A `--force-replace` import, or a relay that mints a fresh identity after its
database is lost, changes the **treasury** as well as the trust root: the
treasury wallet derives from the relay identity key (wallet-solana rule 2).
Relay acceptance of the new key says nothing about what the old key still
controls. Nothing in the relay checks the old treasury before a replacement,
so this section is the check. Do every step, in order, while the **old** key
is still loaded.

1. **Freeze.** `POST /api/v1/admin/freeze` (§ "Emergency Freeze" in
   `docs/ops/RUNBOOK.md`). Confirm with `GET /api/v1/admin/freeze-status`.
   No new withdrawal or payout may start from here on.
2. **Drain the payout queue.** `GET /api/v1/admin/withdrawals/pending` and
   `GET /api/v1/admin/withdrawals/pre-claim` must both be empty. A queued or
   processing Path-0 payout is a durable-nonce transaction signed by the old
   key; the new key cannot kill it. Never mark one failed by hand while its
   signed transaction could still land — that can pay twice. Reconcile each
   one (`POST /api/v1/admin/withdrawals/:id/reconcile`) until it is finalized
   or provably dead.
3. **Record the old treasury.** Note the old treasury address, its SOL and
   USDC balances, and `GET /api/v1/admin/treasury-reconciliation`. Every fee
   leg already paid to this address is real money the operator owns.
4. **Sweep the treasury** to the operator's hardware-wallet receive address
   (treasury-custody phase 1), using the old key. Leave enough SOL for step 5.
5. **Withdraw the durable-nonce account.** Its address is
   `PublicKey.createWithSeed(<old treasury>, "motebit-payout-nonce-v1",
SystemProgram)` (`NONCE_ACCOUNT_SEED`, `packages/wallet-solana/src/web3js-adapter.ts`),
   and its authority is the old key. Withdraw its lamports to the old
   treasury, then sweep again. After the replacement the lane re-derives
   under the new key; an un-withdrawn old account is orphaned rent and an
   authority the new key cannot use.
6. **Only now replace the key** (§ 3, `--force-replace`), re-publish the
   transparency declaration, and unfreeze.
7. **Afterwards:** fee legs paid to the old treasury before the replacement
   may be marked `failed (fee_leg)` by the P2P verifier, which holds the
   treasury address it read at startup. Restart the relay so it reads the new
   address, and treat any such failure dated before the replacement as an
   operator-side artifact, not the payer's fault.

**Not built (named gap):** there is no relay-key succession tool that does
steps 2–5 automatically, and no relay-side succession record for the relay's
own key. Until one exists, this checklist is the only safeguard. If the old
key is lost (volume loss with no backup), steps 2–5 are impossible: funds at
the old treasury and its nonce account are unrecoverable, which is why § 1
(back up now, then quarterly) comes first.

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
