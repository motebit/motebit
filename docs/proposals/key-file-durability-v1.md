# Key-file durability v1

## Lane B: desktop key-store invariants

The desktop keeps secrets in the OS keychain. `~/.motebit/dev-keyring.json` (plaintext, 0600) is used only when the keychain is unavailable. Two builds failed on the same question: what to do when the keychain cannot be read. These laws answer it. The code is `apps/desktop/src-tauri/src/key_store.rs`, and every law has a test that fails when the law is removed.

**Key material** means `device_private_key`, `pending_rotation`, `pending_identity_switch`, and every `*.preserved-*` copy of them.

### Laws

- **K1: no blind keychain mutation.** Within one operation, the store may set or delete name N in the keychain only after a successful keychain read of N. NotFound counts as a successful read that found nothing. A read error means no keychain mutation of N in that operation. The store then either writes the file (K2 "unavailable") or refuses.
- **K2: unavailable is not unreadable.** A failed keychain read is classified by `OsKeychain::classify`, using keyring 3.6.3's own error mapping:
  - **Unavailable** means there is no store to ask. The operation runs in file-only mode (main's behavior). Unavailable is exactly:
    - macOS: `NoStorageAccess` (errSecNotAvailable, ReadOnly, NoSuchKeychain, InvalidKeychain).
    - Windows: `NoStorageAccess` (ERROR_NO_SUCH_LOGON_SESSION).
    - Linux: `PlatformFailure` wrapping `secret_service::Error::Unavailable`, meaning no provider or no D-Bus session.
  - **Read failure** means everything else: denied, cancelled, locked, a D-Bus fault, or a Linux `NoStorageAccess` (Locked, Prompt, NoResult). A read failure refuses the whole operation and is never read as "absent".
  - The two platforms use the variants in opposite senses. On Linux, "locked" is `NoStorageAccess`; on macOS, "cancelled" is `PlatformFailure`. So the classification is per platform, never per variant name.
- **K3: the index is a hint.** `keychain-index.json` lists names seen in the keychain. It is written after a verified keychain write and is never read to decide whether a key exists.
- **K4: preserve before replace.** Before key material is overwritten with a different value, deleted, or set aside, the store keeps the old value as `<name>.preserved-<time>` in the store that held it, and reads that copy back to verify it. A write refuses if the keychain holds a value the write neither read (as `previous`) nor is writing.
- **K5: one value or a refusal.** If the keychain and the file hold different values for a key-material name, a read is an error. It never picks one silently.
- **K6: first launch mints only over a proven absence.** A first launch writes a key only through `set`, so K1, K2 and K4 hold. A config that names an identity is checked through `get`, where a read failure is an error, so no new identity is minted over a key that could not be read.

### State table

Below, "kc" is the keychain's read result for the name, "file" is the fallback file's entry, and "cfg" is whether config.json names an identity. A **damaged file** (unreadable, invalid, non-string, or a dangling symlink) is an error in every row, and nothing writes over it.

| #   | kc                                                | file      | `get`          | `set(NEW)`                                                                         | `delete` / set aside                            | Test                                                                                           |
| --- | ------------------------------------------------- | --------- | -------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | unavailable                                       | absent    | absent         | writes the file; kc untouched                                                      | nothing to remove                               | `k2_unavailable_is_file_only_mode`                                                             |
| 2   | unavailable                                       | holds F   | F              | preserves F in the file, writes NEW to the file                                    | preserves F in the file, then removes it        | `k2_unavailable_is_file_only_mode`                                                             |
| 3   | empty                                             | absent    | absent         | writes kc, verifies by read-back, indexes                                          | nothing to remove                               | `row3_available_empty_writes_the_keychain`                                                     |
| 4   | empty                                             | holds F   | F              | preserves F (the copy goes to kc, verified), writes kc, then drops F from the file | preserves F, then removes it from the file      | `row4_file_value_is_kept_when_the_keychain_takes_over`                                         |
| 5   | holds K                                           | absent    | K              | preserves K in kc, then writes NEW                                                 | preserves K in kc, then deletes it              | `overwriting_a_device_key_preserves_the_old_one_in_the_keychain`, `deleting_or_setting_aside…` |
| 6   | holds K                                           | holds K   | K              | as row 5; the file copy is dropped (same bytes are in kc)                          | as row 5                                        | `row6_same_value_in_both_is_one_value`                                                         |
| 7   | holds K                                           | holds F≠K | **error** (K5) | refuses                                                                            | refuses                                         | `k5_two_different_values_refuse`                                                               |
| 8   | **read fails**                                    | any       | **error**      | **refuses; kc not mutated** (reviewer probe p1)                                    | **refuses; kc not deleted** (reviewer probe p2) | `p1_…`, `p2_…`                                                                                 |
| 9   | holds K, index missing (`~/.motebit` moved aside) | absent    | K (K3)         | preserves K, then writes NEW                                                       | preserves K                                     | `index_missing_the_keychain_key_is_still_found…`                                               |

Rows 3 to 6 also hold when the keychain accepts a write but does not keep it (a silent drop). The read-back sees nothing, so NEW goes to the file, and no value was in the keychain to lose. Test: `a_keychain_that_silently_drops_writes_falls_back_to_the_file`.

**No row destroys or blindly overwrites a key.** Every keychain mutation follows a successful read (K1). Every replaced value is preserved first (K4). Every uncertain state is an error (rows 7 and 8).

### Named cases

- **Double fault** (a keychain write refused, then the confirming read errors). If the successful pre-read found K, a refused write returns an error and the file is not written: a file value would conflict with K under K5. If the pre-read found nothing, a refused write falls back to the file, and no second read is needed. If the post-write verify read errors, the operation returns an error and does not touch the file. K was already preserved (K4) before the write, and the keychain holds either K or NEW. Tests: `double_fault_refused_write_with_a_held_value_refuses`, `double_fault_verify_read_error_refuses_and_keeps_the_old_value`.
- **Shared keychain, moved `~/.motebit`.** The keychain belongs to the OS user, not to the directory.
  - With the config gone, first launch mints a new identity. `set` finds the old K (row 9), preserves it as `device_private_key.preserved-*`, then writes the new key.
  - If the old `~/.motebit` (whose config names the old identity) is later restored, the config names one identity while the keychain holds the other's key. Nothing is lost: the old key is preserved. Detecting that mismatch (the private key does not derive the config's `device_public_key`) is lane A's item 1, in core-identity bootstrap. The desktop store does not guess.
- **First-launch mint while unavailable.** Suppose a keychain is transiently unavailable but actually holds the key (row 1 with cfg naming the identity). Core-identity then takes the divergence path, and the new key goes to the file only. K1 guarantees the keychain key is untouched. When the keychain returns, the name has a value in both places, so row 7 refuses (K5) instead of silently choosing one. Resolving that is again lane A's item 1.
