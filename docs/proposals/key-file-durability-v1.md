# Key-file durability v1

## Lane B: desktop key-store invariants

**What ships:** the desktop keeps its secrets in `~/.motebit/dev-keyring.json`: plaintext, 0600, ssh-key-level protection. Main has always done this, because main's keychain crate had no backend (Finding B-0). **The OS keychain is not used.** Turning it on is its own arc; see [The split](#the-split-file-only-now-the-keychain-as-its-own-arc) below.

Three builds failed on the same question: what to do when a real keychain cannot be read, or answers "not found" when it should not. The laws below (K1 to K6) are the design the keychain arc inherits. The store code in `apps/desktop/src-tauri/src/key_store.rs` is written to them, and every law has a test that fails when the law is removed. Those tests run against an in-memory keychain. In the shipped build the store's keychain is `NoKeychain`, whose every read is _unavailable_, so only rows 1a, 1b and 2 of the state table can occur.

### The split: file-only now, the keychain as its own arc

**Founder decision, 2026-09-25**, after #762 was withdrawn at its decisive round: ship lane B's file-side work now, with the real OS keychain off. Enabling the keychain is a separate arc, gated on testing on real devices: the founder's signed Mac, Linux with gnome-keyring and with KeePassXC, and Windows.

**What ships (default build):**

- `KeyStore::default_for_app()` builds `KeyStore<NoKeychain>`, and so does the Tauri commands' `key_store()` in `main.rs`. The type is the fence: `OsKeychain` does not exist without the `os-keychain` feature, so wiring it in does not compile. Keychain migration does not run at startup.
- `keyring` is an optional dependency, and so are the Linux `secret-service` and `zbus` 4. None of them is in the default dependency tree (`cargo tree -i keyring` finds nothing).
- Everything that held under every review:
  - The strict file store (R1). Only a missing file is absent. A damaged, unreadable, empty or dangling-symlink file is an error, and nothing writes over it.
  - R3. Atomic 0600 writes. Every load narrows the file to 0600, a damaged one included. `USERPROFILE` is honoured.
  - R2. Preserve before replace, in the file, for `device_private_key`, `pending_rotation` and `pending_identity_switch`.
  - The `update_config` compare-and-swap (the desktop never writes `cli_*`).
  - The identity-switch write-ahead.
  - The F4 IPC replay, now also run on the file-only store.
  - `clear()` surfacing a failed set-aside.
  - `config_file.rs`.
- K3's one-way brake stays, because it only ever refuses. Suppose a directory holds `keychain-index.json` or a `dev-keyring.json.migrated-*` copy, which only a pre-release keychain build could have written. Then its key-material names refuse, and are never read as absent. The error names those files. Recovery on such a machine is manual (read the key back with the platform's keychain tool), because this build does not read the keychain.

**Kept behind the `os-keychain` Cargo feature (off by default, not wired into the app):** `OsKeychain`, `classify` and its Linux typed "no provider" match, and `KeyStore::migrate`. The FakeKeychain law tests (K1 to K6, p1/p2, the double faults, Q1, and the table rows) run in the default build. The classifier tests and the ignored real-keychain test run only under `--features os-keychain`.

**Entry criteria for the keychain arc.** These provider behaviours were found by the three withdrawn builds. Each is to be reproduced on a real device, and the design must pass it, before the keychain is enabled for anyone:

| #   | Provider behaviour                                                                                                                                                                   | Found in         | What the design must do                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | A keychain **read can fail while a write succeeds** (a dismissed prompt, then an allowed one).                                                                                       | #760, decisive   | K1: no keychain set or delete without a successful read of that name in the same operation.                                                                                                                                                                                                                             |
| b   | Linux: a session bus with **no Secret Service provider** answers `org.freedesktop.DBus.Error.ServiceUnknown` (or `NameHasNoOwner`), not the crate's `Unavailable`.                   | #762, round 1    | K2: classify it as _unavailable_ on types (`classify`), never on message text. Any other D-Bus error is a read failure.                                                                                                                                                                                                 |
| c   | Linux, KeePassXC: a **locked database answers a search with an empty result**, which keyring maps to `NoEntry`. The dismissed-unlock and `UnlockBeforeSearch`-off paths do the same. | #762, decisive   | **New design law: absence requires agreement.** A name is absent only when the keychain says `NoEntry` **and** there is no evidence it ever lived there (index row, migrated copy, preserved copy). Contradicting evidence refuses, and is never erased. K1's "NotFound is a successful read" is not enough on its own. |
| d   | Windows Credential Manager limits a credential blob to **2560 bytes**.                                                                                                               | lead's inventory | Measure the largest value stored (`pending_rotation`, `pending_identity_switch`). A value that does not fit must refuse or split, never truncate or silently fall back.                                                                                                                                                 |
| e   | macOS: an **ad-hoc-signed** (`tauri dev`) build and a **signed** build see the keychain differently, and the keychain can accept a write and then not return it (a silent drop).     | #760 checklist   | Every write is verified by a fresh read-back. The test runs on both signatures, across a restart, and from a separate process.                                                                                                                                                                                          |

**Signed-build checklist** (the founder's Mac, run by the keychain arc; from #760, updated for rows 8 and 9):

1. **Record the before-state** on the old version:
   - `shasum ~/.motebit/dev-keyring.json`;
   - `jq -r .device_private_key ~/.motebit/dev-keyring.json`;
   - `motebit_id` and `device_public_key` from `config.json`.
2. **Install the keychain build and run it from a terminal.** Expect the `moved N secret(s) … into the OS keychain` line.
3. **Check the key moved.** `security find-generic-password -s com.motebit.desktop -a device_private_key -w` equals the hex from step 1.
4. **Check the files.**
   - `dev-keyring.json` is gone.
   - `keychain-index.json` lists the migrated names.
   - `dev-keyring.json.migrated-*` is mode `600`.
5. **Relaunch.**
   - `motebit_id` is unchanged, with no divergence banner.
   - Sync and relay auth work.
   - `dev-keyring.json` is not recreated.
6. **Deny keychain access** when macOS asks.
   - The app shows "could not be read … not absent".
   - `motebit_id` is unchanged.
   - Allow access and retry.
7. **Rotate the key from Settings.**
   - The new key reads back.
   - `security dump-keychain | grep 'device_private_key.preserved-'` shows the retired one.
8. **Move `~/.motebit` aside** (row 9). The first launch finds the keychain key, preserves it before any new write, and never overwrites it blind.
9. **Rule out silent drops (criterion e).** On both an ad-hoc and the signed build, after a restart, a key the app wrote reads back through `security` from a separate process.
10. **Re-sign with a different identity.** The access prompt appears, and denying it fails closed, as in step 6.
11. **Lock the keychain while the app runs.** The Mac equivalent of criterion c. No read comes back as absent.

The same criteria are run on Linux (gnome-keyring; KeePassXC locked, unlocked and closed; a bus with no provider) and on Windows (criterion d, and a locked or absent logon session).

**Items 21 to 27 (lane B's slice of the inventory):**

| Item | Subject                                                                      | Status                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21   | ⚖ Finding B-0: the keychain is a mock; fix the false comment                 | **Deferred arc: founder split, 2026-09-25.** `dev-keyring.json` is declared the desktop key store. The false comments are fixed: `main.rs`, the `key_store.rs` header, and the desktop TS comments (`identity-manager.ts`, `index.ts`, `ui/settings.ts`). |
| 22   | `dev-keyring.json` reader: only ENOENT is absent (R1)                        | Fixed: `durable_file::read_strict` + `KeyStore::read_dev`. Damage, including an empty file or a dangling symlink, is an error.                                                                                                                            |
| 23   | `dev-keyring.json` writer: atomic, 0600, symlink, narrow, `USERPROFILE` (R3) | Fixed: `write_file_atomic_owner_only`; every load narrows, a damaged file included; `motebit_dir` falls back to `USERPROFILE`.                                                                                                                            |
| 24   | `keyring_set` / `keyring_delete` read-modify-write (R2)                      | Fixed: refuses on damage. A replaced `device_private_key` and a deleted or set-aside `pending_*` are preserved in the file, and verified.                                                                                                                 |
| 25   | `restoreIdentity` / `completePairing` (R2)                                   | Fixed: the identity-switch write-ahead, the config compare-and-swap, and preservation. Proven by the F4 IPC replay on both the in-memory keychain and the file-only store.                                                                                |
| 26   | Desktop `writeAhead.load`: damaged is `"unreadable"`, not `null` (R1)        | Fixed. `clear()` also surfaces a failed set-aside.                                                                                                                                                                                                        |
| 27   | ⚖ Desktop rotation commit (the retired-key ruling, X11)                      | Fixed for the file store: the retired key is kept as `device_private_key.preserved-*` in `dev-keyring.json`.                                                                                                                                              |

The rest of this section is the keychain design, as the arc inherits it.

**Key material** means `device_private_key`, `pending_rotation`, `pending_identity_switch`, and every `*.preserved-*` copy of them.

### Laws

- **K1: no blind keychain mutation.** Within one operation, the store may set or delete name N in the keychain only after a successful keychain read of N. NotFound counts as a successful read that found nothing. A read error means no keychain mutation of N in that operation. The store then either writes the file (K2 "unavailable") or refuses.
- **K2: unavailable is not unreadable.** A failed keychain read is classified by `key_store::classify`, using keyring 3.6.3's own error mapping:
  - **Unavailable** means there is no store to ask. The operation runs in file-only mode (main's behavior). Unavailable is exactly:
    - macOS: `NoStorageAccess` (errSecNotAvailable, ReadOnly, NoSuchKeychain, InvalidKeychain).
    - Windows: `NoStorageAccess` (ERROR_NO_SUCH_LOGON_SESSION).
    - Linux: `PlatformFailure` wrapping either shape of "nothing to ask", both observed live in Docker:
      - no session bus: `secret_service::Error::Unavailable`;
      - a session bus on which nothing owns `org.freedesktop.secrets` (i3, sway or xfce without gnome-keyring; KeePassXC closed): the bus daemon's standard `org.freedesktop.DBus.Error.ServiceUnknown` (or `NameHasNoOwner`), reaching the store as `Zbus(MethodError(..))`, `Zbus(FDO(..))` or `ZbusFdo(..)`.

      Both are matched on types (the downcast `secret_service::Error`, zbus's `fdo::Error` variants, and the D-Bus error name field), never on message text. Every secret-service call goes to `org.freedesktop.secrets`, so "destination has no owner" can only mean that name.
  - **Read failure** means everything else: denied, cancelled, locked, a D-Bus fault, or a Linux `NoStorageAccess` (Locked, Prompt, NoResult). A read failure refuses the whole operation and is never read as "absent".
  - The two platforms use the variants in opposite senses. On Linux, "locked" is `NoStorageAccess`; on macOS, "cancelled" is `PlatformFailure`. So the classification is per platform, never per variant name.
- **K3: the index is a hint, and a one-way brake.** `keychain-index.json` lists names seen in the keychain. It is written after a verified keychain write. It never decides that a key **exists**: the keychain is asked for every name. It can only make the store more conservative.
  - Suppose the keychain is **unavailable** and a key-material name is listed in the index, or appears in a `dev-keyring.json.migrated-*` copy (the migration evidence that survives a lost index).
  - Then `get`, `set` and `delete` of that name **refuse**: "stored in the OS keychain, which is unavailable; unlock or start your keyring". They never read it as absent and never write a file value that would become a second candidate.
  - A damaged index or migrated copy counts as evidence.
- **K4: preserve before replace.** Before key material is overwritten with a different value, deleted, or set aside, the store keeps the old value as `<name>.preserved-<time>` in the store that held it, and reads that copy back to verify it. A write refuses if the keychain holds a value the write neither read (as `previous`) nor is writing.
- **K5: one value or a refusal.** If the keychain and the file hold different values for a key-material name, a read is an error. It never picks one silently.
- **K6: first launch mints only over a proven absence.** A first launch writes a key only through `set`, so K1, K2 and K4 hold. A config that names an identity is checked through `get`, where a read failure is an error, so no new identity is minted over a key that could not be read.

### State table

Below, "kc" is the keychain's read result for the name, "file" is the fallback file's entry, and "cfg" is whether config.json names an identity. A **damaged file** (unreadable, invalid, non-string, or a dangling symlink) is an error in every row, and nothing writes over it.

| #   | kc                                                                | file      | `get`                | `set(NEW)`                                                                         | `delete` / set aside                            | Test                                                                                           |
| --- | ----------------------------------------------------------------- | --------- | -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1a  | unavailable; name never in kc (no index row, no migrated copy)    | absent    | absent               | writes the file; kc untouched                                                      | nothing to remove                               | `k2_unavailable_is_file_only_mode`, `row1a_fresh_file_only_machine_is_unaffected_by_the_brake` |
| 1b  | unavailable; index or a migrated copy lists the key-material name | any       | **error** (K3 brake) | **refuses** (no second candidate)                                                  | **refuses**                                     | `q1_migrated_key_with_keychain_unavailable_refuses_never_absent` (reviewer probe Q1)           |
| 2   | unavailable; name never in kc                                     | holds F   | F                    | preserves F in the file, writes NEW to the file                                    | preserves F in the file, then removes it        | `k2_unavailable_is_file_only_mode`                                                             |
| 3   | empty                                                             | absent    | absent               | writes kc, verifies by read-back, indexes                                          | nothing to remove                               | `row3_available_empty_writes_the_keychain`                                                     |
| 4   | empty                                                             | holds F   | F                    | preserves F (the copy goes to kc, verified), writes kc, then drops F from the file | preserves F, then removes it from the file      | `row4_file_value_is_kept_when_the_keychain_takes_over`                                         |
| 5   | holds K                                                           | absent    | K                    | preserves K in kc, then writes NEW                                                 | preserves K in kc, then deletes it              | `overwriting_a_device_key_preserves_the_old_one_in_the_keychain`, `deleting_or_setting_aside…` |
| 6   | holds K                                                           | holds K   | K                    | as row 5; the file copy is dropped (same bytes are in kc)                          | as row 5                                        | `row6_same_value_in_both_is_one_value`                                                         |
| 7   | holds K                                                           | holds F≠K | **error** (K5)       | refuses                                                                            | refuses                                         | `k5_two_different_values_refuse`                                                               |
| 8   | **read fails**                                                    | any       | **error**            | **refuses; kc not mutated** (reviewer probe p1)                                    | **refuses; kc not deleted** (reviewer probe p2) | `p1_…`, `p2_…`                                                                                 |
| 9   | holds K, index missing (`~/.motebit` moved aside)                 | absent    | K (K3)               | preserves K, then writes NEW                                                       | preserves K                                     | `index_missing_the_keychain_key_is_still_found…`                                               |

Rows 3 to 6 also hold when the keychain accepts a write but does not keep it (a silent drop). The read-back sees nothing, so NEW goes to the file, and no value was in the keychain to lose. Test: `a_keychain_that_silently_drops_writes_falls_back_to_the_file`.

**No row destroys or blindly overwrites a key.** Every keychain mutation follows a successful read (K1). Every replaced value is preserved first (K4). Every uncertain state is an error (rows 1b, 7 and 8).

### Named cases

- **Double fault** (a keychain write refused, then the confirming read errors). If the successful pre-read found K, a refused write returns an error and the file is not written: a file value would conflict with K under K5. If the pre-read found nothing, a refused write falls back to the file, and no second read is needed. If the post-write verify read errors, the operation returns an error and does not touch the file. K was already preserved (K4) before the write, and the keychain holds either K or NEW. Tests: `double_fault_refused_write_with_a_held_value_refuses`, `double_fault_verify_read_error_refuses_and_keeps_the_old_value`.
- **Shared keychain, moved `~/.motebit`.** The keychain belongs to the OS user, not to the directory.
  - With the config gone, first launch mints a new identity. `set` finds the old K (row 9), preserves it as `device_private_key.preserved-*`, then writes the new key.
  - If the old `~/.motebit` (whose config names the old identity) is later restored, the config names one identity while the keychain holds the other's key. Nothing is lost: the old key is preserved. Detecting that mismatch (the private key does not derive the config's `device_public_key`) is lane A's item 1, in core-identity bootstrap. The desktop store does not guess.
- **First-launch mint while unavailable.**
  - **Key known to live in the keychain** (row 1b: the index or a migrated copy lists it). Suppose the config names the identity and the keychain is unavailable. `get` refuses, so `hasPrivateKey` rejects and bootstrap stops with "unlock or start your keyring". No divergence mint happens. When the keychain returns, the key reads normally.
  - **Key only ever in a keychain this directory has no record of** (row 1a with both the index and every `.migrated-*` copy gone, e.g. a fresh `~/.motebit` sharing the OS user's keychain). This is main's behavior: the name reads as absent. A mint writes the file only. K1 guarantees the keychain key is untouched. When the keychain returns, row 7 refuses (K5) instead of silently choosing one. Resolving that is lane A's item 1.

### Documented follow-ups (not built here)

- **Plaintext retention.** `dev-keyring.json.migrated-*` keeps the pre-migration plaintext (0600) indefinitely. R2 requires the bytes to be kept. When to offer deleting them is a founder call.
- **Growth of preserved copies.** Every replaced key-material value adds one `*.preserved-*` entry, which is never pruned. Lane A F2 (`storePrivateKey` runs before the CLI-identity refusal) makes this grow once per launch on a CLI-only machine.
- **K5 in-app resolution.** Rows 7 and 1b refuse, and the app offers no in-app way out beyond "unlock or start your keyring" (1b) or manual repair (7). Detecting which key matches the config (the private key derives `device_public_key`) is lane A's item 1.
- **Public docs repeat the false claim.** `apps/docs` says the desktop key lives in the OS keyring, which is false on main and on this branch. The places: `security.mdx:36`, `developer/identity-crypto.mdx:15,114`, `get-your-agent.mdx:271`, `operator/architecture.mdx:313`. Fix them in a docs change with the `llms-full.txt` regeneration. Until the keychain arc lands, the truth is "0600 plaintext file".
- **Lane A F3.** The CLI's `migrate-keyring` erases a `dev-keyring.json` that may now hold `.preserved-*` entries and `pending_*` write-aheads.
