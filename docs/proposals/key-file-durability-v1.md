# Key-file durability v1

## Lane B: desktop key-store invariants

The desktop keeps secrets in the OS keychain. `~/.motebit/dev-keyring.json` (plaintext, 0600) is used only when the keychain is unavailable. Two builds failed on the same question: what to do when the keychain cannot be read. These laws answer it. The code is `apps/desktop/src-tauri/src/key_store.rs`, and every law has a test that fails when the law is removed.

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
- **Lane A F3.** The CLI's `migrate-keyring` erases a `dev-keyring.json` that may now hold `.preserved-*` entries and `pending_*` write-aheads.
