//! The desktop's secret store: the OS keychain first, `~/.motebit/dev-keyring.json`
//! as the documented fallback.
//!
//! Finding B-0 (build 3): until this change `keyring = "3"` was compiled with
//! NO platform backend, so every `keyring::Entry` was the crate's in-memory
//! mock — `set_password` "succeeded" and nothing persisted — and the
//! plaintext `dev-keyring.json` was the only persistent copy of the device
//! private key on every install, signed or not. The backends are now enabled
//! (`apple-native`, `windows-native`, `async-secret-service` + `crypto-rust` +
//! `async-io` on Linux; see Cargo.toml). The file remains only as the
//! fallback for a machine whose keychain is unavailable (e.g. a Linux session
//! with no Secret Service running).
//!
//! Rules (R1–R3, as for every key-bearing file):
//!
//!  * R1 — absence is not damage. The keychain itself is asked for every
//!    name on every read and write; `keychain-index.json` is only a hint
//!    (a cache of names seen there, written after a verified keychain write)
//!    and never decides existence. A keychain that cannot be read (locked,
//!    prompt cancelled, service down) is an `Err` for key material — never
//!    "no key" — once there is evidence this install keeps keys there (the
//!    index exists, or the config names an identity whose key is not in the
//!    file); a first launch never mints over a key it could not read. A
//!    damaged / unreadable / dangling-symlink `dev-keyring.json` is an `Err`
//!    too, and nothing writes over it.
//!  * R2 — key material (`device_private_key`, `pending_rotation`,
//!    `pending_identity_switch`) is never destroyed: an overwrite with a
//!    different value, a delete, and a set-aside first keep the old value
//!    under `<name>.preserved-<time>` in the same store, verified by reading
//!    it back. Migration out of the file keeps the file (`.migrated-<time>`).
//!  * R3 — the file and the index are written through
//!    `durable_file::write_file_atomic_owner_only` and narrowed on every load.
//!
//! The keychain is behind [`SecretStore`] so the migrate / verify / preserve
//! logic is unit-tested without touching a real keychain.

use crate::durable_file::{preserve_aside, read_strict, write_file_atomic_owner_only, Keep};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// Names whose values are private-key material.
pub const KEY_MATERIAL: [&str; 3] = [
    "device_private_key",
    "pending_rotation",
    "pending_identity_switch",
];

pub fn is_key_material(name: &str) -> bool {
    KEY_MATERIAL.contains(&name)
}

/// The OS keychain, abstracted. `get` → `Ok(None)` ONLY for "no such entry";
/// every other failure is an `Err`. `delete` of a missing entry is `Ok`.
pub trait SecretStore {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// The real keychain via the `keyring` crate. Every call builds a FRESH
/// `Entry`, so a read-back verifies what the platform store holds, not a
/// value cached in this process.
pub struct OsKeychain {
    service: String,
}

impl OsKeychain {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }
    fn entry(&self, name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, name).map_err(|e| format!("keychain: {}", e))
    }
}

impl SecretStore for OsKeychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match self.entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keychain read of {} failed: {}", name, e)),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.entry(name)?
            .set_password(value)
            .map_err(|e| format!("keychain write of {} failed: {}", name, e))
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain delete of {} failed: {}", name, e)),
        }
    }
}

/// What migration did, for the startup log.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    pub migrated: Vec<String>,
    /// Names whose keychain value differs from the file's: left in the file.
    pub conflicts: Vec<String>,
    /// Set when the keychain refused a write: nothing more was attempted.
    pub keychain_unavailable: Option<String>,
    /// The preserved copy of the file taken before it was edited.
    pub preserved_file: Option<PathBuf>,
}

pub struct KeyStore<S: SecretStore> {
    secret: S,
    dir: PathBuf,
    /// Test seam: produces the `<time>` suffix for preserved entries.
    stamp: fn() -> String,
}

type Map = BTreeMap<String, String>;

impl<S: SecretStore> KeyStore<S> {
    pub fn new(secret: S, dir: PathBuf) -> Self {
        Self {
            secret,
            dir,
            stamp: crate::durable_file::now_stamp,
        }
    }

    pub fn dev_path(&self) -> PathBuf {
        self.dir.join("dev-keyring.json")
    }
    fn index_path(&self) -> PathBuf {
        self.dir.join("keychain-index.json")
    }

    // ── the file and the index ───────────────────────────────────────────

    /// `Ok(None)` only when the file does not exist.
    fn read_dev(&self) -> Result<Option<Map>, String> {
        let path = self.dev_path();
        let Some(bytes) = read_strict(&path)? else {
            return Ok(None);
        };
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(serde_json::Value::Object(o)) => {
                let mut map = Map::new();
                for (k, v) in o {
                    match v {
                        serde_json::Value::String(s) => {
                            map.insert(k, s);
                        }
                        _ => {
                            return Err(format!(
                                "{} holds a non-string value for {:?}: damaged. It has NOT been changed; it may hold your device key — move it aside to recover.",
                                path.display(),
                                k
                            ))
                        }
                    }
                }
                Ok(Some(map))
            }
            _ => Err(format!(
                "{} is not a JSON object of strings: damaged. It has NOT been changed; it may hold your device key — move it aside to recover.",
                path.display()
            )),
        }
    }

    fn write_dev(&self, map: &Map) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        write_file_atomic_owner_only(&self.dev_path(), json.as_bytes(), None)
    }

    /// The index is a HINT (a cache of names seen in the keychain), never the
    /// authority for whether a key exists: the keychain itself is asked on
    /// every read and write. A damaged index is ignored (and rewritten), not
    /// an error — it holds names, not keys.
    fn index_hint(&self) -> BTreeSet<String> {
        let path = self.index_path();
        let bytes = match read_strict(&path) {
            Ok(Some(b)) => b,
            Ok(None) => return BTreeSet::new(),
            Err(e) => {
                eprintln!("[motebit] WARNING: ignoring keychain index: {}", e);
                return BTreeSet::new();
            }
        };
        #[derive(serde::Deserialize)]
        struct Index {
            keys: Vec<String>,
        }
        match serde_json::from_slice::<Index>(&bytes) {
            Ok(i) => i.keys.into_iter().collect(),
            Err(e) => {
                eprintln!(
                    "[motebit] WARNING: ignoring damaged keychain index {} ({})",
                    path.display(),
                    e
                );
                BTreeSet::new()
            }
        }
    }

    fn write_index(&self, keys: &BTreeSet<String>) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let json = serde_json::json!({ "keys": keys }).to_string();
        write_file_atomic_owner_only(&self.index_path(), json.as_bytes(), None)
    }

    /// Best-effort cache maintenance; a failure is logged, never fatal (the
    /// keychain, not the index, decides existence).
    fn note_in_keychain(&self, name: &str, present: bool) {
        let mut index = self.index_hint();
        let changed = if present {
            index.insert(name.to_string())
        } else {
            index.remove(name)
        };
        if changed {
            if let Err(e) = self.write_index(&index) {
                eprintln!("[motebit] WARNING: keychain index not updated: {}", e);
            }
        }
    }

    /// Evidence that this install keeps secrets in the OS keychain, so a
    /// keychain that cannot be read is NOT an empty one: the index file
    /// exists (it is only ever written after a verified keychain write), or
    /// the config names an identity whose key is not in the fallback file
    /// (so it can only be in the keychain). Without either — a first launch,
    /// or a machine that has only ever used the file (no Secret Service) —
    /// a keychain error on a name the file lacks is a true absence.
    fn keychain_in_use(&self, dev: &Option<Map>) -> bool {
        if std::fs::symlink_metadata(self.index_path()).is_ok() {
            return true;
        }
        if dev.as_ref().is_some_and(|m| m.contains_key("device_private_key")) {
            return false;
        }
        config_claims_identity(&self.dir.join("config.json"))
    }

    // ── reads ────────────────────────────────────────────────────────────

    /// R1. The keychain is asked for EVERY name, indexed or not:
    ///  * keychain has it → present (and cached in the index);
    ///  * keychain has no such entry → the fallback file decides (a name the
    ///    index lists but the keychain lacks — a crash, an external delete —
    ///    is absent from the keychain, never a permanent error);
    ///  * keychain cannot be read → the file's value if it has one; else, for
    ///    key material (or an indexed name) on an install that uses the
    ///    keychain, an `Err` — never "absent", so nothing mints over it.
    pub fn get(&self, name: &str) -> Result<Option<String>, String> {
        let dev = self.read_dev()?;
        let in_dev = dev.as_ref().and_then(|m| m.get(name)).cloned();
        match self.secret.get(name) {
            Ok(Some(v)) => {
                self.note_in_keychain(name, true);
                Ok(Some(v))
            }
            Ok(None) => {
                self.note_in_keychain(name, false);
                Ok(in_dev)
            }
            Err(e) => match in_dev {
                Some(v) => Ok(Some(v)),
                None => {
                    let guarded = guards_absence(name) || self.index_hint().contains(name);
                    if guarded && self.keychain_in_use(&dev) {
                        Err(format!(
                            "{} could not be read from the OS keychain ({}). It is not absent; nothing was changed.",
                            name, e
                        ))
                    } else {
                        Ok(None)
                    }
                }
            },
        }
    }

    // ── writes ───────────────────────────────────────────────────────────

    /// Store `value` under `name`: the keychain when it accepts and verifies
    /// the write, else the fallback file. The previous value of a
    /// key-material name — wherever it lives, indexed or not — is preserved
    /// first when it differs.
    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let old = self.get(name)?; // asks the keychain; refuses on any uncertainty
        if let Some(old) = old.as_deref() {
            if old != value && is_key_material(name) {
                self.preserve_value(name, old)?;
            }
        }
        self.store_raw(name, value, old.as_deref())
    }

    /// Remove `name`. Key material is preserved first (this is also what
    /// `clear()` of the rotation write-ahead does).
    pub fn delete(&self, name: &str) -> Result<(), String> {
        if is_key_material(name) {
            return self.set_aside(name);
        }
        let _ = self.get(name)?; // a damaged store refuses the delete too
        self.remove_raw(name)
    }

    /// Move `name` out of the active slot WITHOUT destroying its bytes:
    /// the value is kept as `<name>.preserved-<time>` (verified), then the
    /// active entry is removed. Resolves only when durable; any failure is an
    /// `Err` and the active entry is left in place.
    pub fn set_aside(&self, name: &str) -> Result<(), String> {
        let Some(old) = self.get(name)? else {
            return self.remove_raw(name); // nothing held; tidy a stale index row
        };
        self.preserve_value(name, &old)?;
        self.remove_raw(name)
    }

    fn preserve_value(&self, name: &str, value: &str) -> Result<String, String> {
        let stamp = (self.stamp)();
        for n in 0..100u32 {
            let suffix = if n == 0 { String::new() } else { format!("-{}", n) };
            let kept = format!("{}.preserved-{}{}", name, stamp, suffix);
            if self.get(&kept)?.is_some() {
                continue;
            }
            self.store_raw(&kept, value, None)?;
            if self.get(&kept)?.as_deref() != Some(value) {
                return Err(format!(
                    "could not verify the preserved copy of {}; nothing was changed",
                    name
                ));
            }
            return Ok(kept);
        }
        Err(format!("no free name to preserve {}; nothing was changed", name))
    }

    /// Write without the preserve step. `previous` is what `get` returned —
    /// the only value this write is allowed to replace. The keychain is read
    /// again here (never trusting the index): a value there that is neither
    /// `previous` nor `value` would be destroyed, so the write refuses.
    fn store_raw(&self, name: &str, value: &str, previous: Option<&str>) -> Result<(), String> {
        let dev = self.read_dev()?;
        let current = match self.secret.get(name) {
            Ok(v) => v,
            Err(e) => {
                if (guards_absence(name) || self.index_hint().contains(name)) && self.keychain_in_use(&dev) {
                    return Err(format!(
                        "{} could not be read from the OS keychain before writing ({}); refusing to write over what it may hold. Nothing was changed.",
                        name, e
                    ));
                }
                None
            }
        };
        if let Some(cur) = current.as_deref() {
            if cur != value && Some(cur) != previous {
                return Err(format!(
                    "the OS keychain holds a value for {} that this write did not account for; refusing to overwrite it. Nothing was changed.",
                    name
                ));
            }
        }
        // Keychain first, index after: a crash between leaves a keychain
        // entry the index does not list, which `get` still finds (the index
        // is only a hint). The reverse order could leave the index naming an
        // entry that never existed.
        let keychain = self
            .secret
            .set(name, value)
            .and_then(|()| match self.secret.get(name) {
                Ok(Some(v)) if v == value => Ok(()),
                Ok(_) => Err(format!("keychain write of {} did not read back", name)),
                Err(e) => Err(e),
            });
        match keychain {
            Ok(()) => {
                self.note_in_keychain(name, true);
                // The keychain is now authoritative. A different value left in
                // the file for this name is key material we must not drop.
                if let Some(mut map) = dev {
                    if let Some(stale) = map.remove(name) {
                        if stale != value && is_key_material(name) && previous != Some(stale.as_str()) {
                            keep_in_map(&mut map, name, stale, &(self.stamp)());
                        }
                        self.write_dev(&map)?;
                    }
                }
                Ok(())
            }
            Err(keychain_err) => {
                // The keychain still holding a value for this name would make
                // every later read return IT, not the file's: refuse rather
                // than write a value no read would see.
                if let Ok(Some(_)) = self.secret.get(name) {
                    return Err(format!(
                        "the OS keychain refused to replace {} ({}) and still holds the old value; nothing was changed",
                        name, keychain_err
                    ));
                }
                let mut map = dev.unwrap_or_default();
                if let Some(old_in_file) = map.get(name).cloned() {
                    if old_in_file != value && is_key_material(name) && previous != Some(old_in_file.as_str()) {
                        keep_in_map(&mut map, name, old_in_file, &(self.stamp)());
                    }
                }
                map.insert(name.to_string(), value.to_string());
                self.write_dev(&map).map_err(|e| {
                    format!(
                        "could not store {}: keychain ({}) and fallback file ({}) both failed",
                        name, keychain_err, e
                    )
                })?;
                eprintln!(
                    "[motebit] OS keychain unavailable for {} ({}); stored in {} (plaintext, 0600)",
                    name,
                    keychain_err,
                    self.dev_path().display()
                );
                Ok(())
            }
        }
    }

    /// Callers preserve first. Keychain entry deleted first, then the index
    /// hint, then the file entry — a crash leaves at worst an index row
    /// naming a missing entry, which reads as absent-from-keychain.
    fn remove_raw(&self, name: &str) -> Result<(), String> {
        let dev = self.read_dev()?;
        if let Err(e) = self.secret.delete(name) {
            if self.keychain_in_use(&dev) {
                return Err(e);
            }
        }
        self.note_in_keychain(name, false);
        if let Some(mut map) = dev {
            if map.remove(name).is_some() {
                self.write_dev(&map)?;
            }
        }
        Ok(())
    }

    // ── migration ────────────────────────────────────────────────────────

    /// Copy every entry that exists only in `dev-keyring.json` into the
    /// keychain, verify each by reading it back, and only then keep the file
    /// aside (`dev-keyring.json.migrated-<time>`, a byte copy, 0600) and
    /// drop the migrated entries from the live file. A conflict (the
    /// keychain already holds a DIFFERENT value) leaves that entry in the
    /// file. A keychain that refuses stops the migration; nothing is lost.
    pub fn migrate(&self) -> Result<MigrationReport, String> {
        let mut report = MigrationReport::default();
        let Some(dev) = self.read_dev()? else {
            return Ok(report);
        };
        let mut done: Vec<String> = Vec::new();
        for (name, value) in &dev {
            match self.secret.get(name) {
                Ok(Some(existing)) if &existing == value => {
                    self.note_in_keychain(name, true);
                    done.push(name.clone());
                }
                Ok(Some(_)) => report.conflicts.push(name.clone()),
                Ok(None) => {
                    let ok = self.secret.set(name, value).and_then(|()| match self.secret.get(name) {
                        Ok(Some(v)) if &v == value => Ok(()),
                        Ok(_) => Err(format!("{} did not read back from the keychain", name)),
                        Err(e) => Err(e),
                    });
                    match ok {
                        Ok(()) => {
                            self.note_in_keychain(name, true);
                            done.push(name.clone());
                        }
                        Err(e) => {
                            report.keychain_unavailable = Some(e);
                            break;
                        }
                    }
                }
                Err(e) => {
                    report.keychain_unavailable = Some(e);
                    break;
                }
            }
        }
        if done.is_empty() {
            return Ok(report);
        }
        // Every migrated entry is verified in the keychain. Keep the file's
        // bytes before editing it (never deleted blind).
        report.preserved_file = Some(preserve_aside(&self.dev_path(), "migrated", Keep::CopyBytes)?);
        let mut remaining = dev.clone();
        for name in &done {
            remaining.remove(name);
        }
        if remaining.is_empty() {
            std::fs::remove_file(self.dev_path()).map_err(|e| e.to_string())?;
            crate::durable_file::fsync_dir(&self.dir)?;
        } else {
            self.write_dev(&remaining)?;
        }
        report.migrated = done;
        Ok(report)
    }
}

/// Names whose absence must be proven, not assumed: key material and every
/// preserved copy of it.
fn guards_absence(name: &str) -> bool {
    is_key_material(name) || name.contains(".preserved-")
}

/// Does `config.json` name an identity? A damaged or unreadable config
/// counts as yes (it cannot prove there is none).
fn config_claims_identity(path: &Path) -> bool {
    match read_strict(path) {
        Ok(None) => false,
        Ok(Some(bytes)) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(serde_json::Value::Object(o)) => o
                .get("motebit_id")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty()),
            _ => true,
        },
        Err(_) => true,
    }
}

/// Keep `value` in the fallback map under a free `<name>.preserved-<stamp>`.
fn keep_in_map(map: &mut Map, name: &str, value: String, stamp: &str) {
    let kept = (0..)
        .map(|n: u32| {
            if n == 0 {
                format!("{}.preserved-{}", name, stamp)
            } else {
                format!("{}.preserved-{}-{}", name, stamp, n)
            }
        })
        .find(|k| !map.contains_key(k))
        .unwrap_or_default();
    map.insert(kept, value);
}

/// Where a preserved key lives, for the report; exposed for callers that
/// want to name it.
pub fn describe(dir: &Path) -> String {
    format!(
        "OS keychain (service com.motebit.desktop; names listed in {}), fallback {}",
        dir.join("keychain-index.json").display(),
        dir.join("dev-keyring.json").display()
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// An in-memory keychain with switchable failure modes.
    #[derive(Default)]
    pub struct FakeKeychain {
        pub entries: RefCell<HashMap<String, String>>,
        pub fail_get: RefCell<bool>,
        pub fail_set: RefCell<bool>,
        /// Accepts writes but does not persist them (the silent-drop shape).
        pub drop_writes: RefCell<bool>,
    }
    impl SecretStore for &FakeKeychain {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            if *self.fail_get.borrow() {
                return Err("keychain locked".into());
            }
            Ok(self.entries.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            if *self.fail_set.borrow() {
                return Err("no secret service".into());
            }
            if !*self.drop_writes.borrow() {
                self.entries.borrow_mut().insert(name.into(), value.into());
            }
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            self.entries.borrow_mut().remove(name);
            Ok(())
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "motebit-keystore-{}-{}-{}",
            tag,
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn store<'a>(kc: &'a FakeKeychain, dir: &Path) -> KeyStore<&'a FakeKeychain> {
        let mut s = KeyStore::new(kc, dir.to_path_buf());
        s.stamp = || "T".to_string();
        s
    }

    fn dev_json(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("dev-keyring.json")).unwrap()).unwrap()
    }

    #[test]
    fn absent_everywhere_is_none() {
        let dir = scratch("absent");
        let kc = FakeKeychain::default();
        assert_eq!(store(&kc, &dir).get("device_private_key").unwrap(), None);
        // A keychain that errors on an install with no evidence of using it
        // (no index, no identity in the config) is a first launch: absent.
        *kc.fail_get.borrow_mut() = true;
        assert_eq!(store(&kc, &dir).get("device_private_key").unwrap(), None);
    }

    #[test]
    fn a_damaged_fallback_file_is_an_error_and_is_never_written_over() {
        let dir = scratch("damaged");
        let kc = FakeKeychain::default();
        *kc.fail_set.borrow_mut() = true; // force the file path
        for body in ["{ \"device_private_key\": \"ab", "[]", "{\"device_private_key\": 7}"] {
            std::fs::write(dir.join("dev-keyring.json"), body).unwrap();
            let s = store(&kc, &dir);
            assert!(s.get("device_private_key").is_err(), "{body}");
            // BYOK save / operator PIN / first-launch store must not destroy it.
            assert!(s.set("anthropic_api_key", "sk").is_err(), "{body}");
            assert!(s.delete("anthropic_api_key").is_err(), "{body}");
            assert_eq!(
                std::fs::read_to_string(dir.join("dev-keyring.json")).unwrap(),
                body
            );
        }
    }

    #[test]
    fn an_indexed_name_the_keychain_cannot_read_is_an_error_not_absence() {
        let dir = scratch("locked");
        let kc = FakeKeychain::default();
        let s = store(&kc, &dir);
        s.set("device_private_key", "K1").unwrap();
        assert!(!dir.join("dev-keyring.json").exists(), "keychain held it");
        *kc.fail_get.borrow_mut() = true;
        let err = s.get("device_private_key").unwrap_err();
        assert!(err.contains("not absent"), "{err}");
        // F1: an entry the index lists but the keychain no longer has (an
        // external delete; a crash between the keychain delete and the index
        // update) is absent-from-keychain — the file decides — never a
        // permanent error. It is a real absence; nothing is fabricated.
        *kc.fail_get.borrow_mut() = false;
        kc.entries.borrow_mut().clear();
        assert_eq!(s.get("device_private_key").unwrap(), None);
    }

    // ── #760 review: the index is a hint, never the authority ─────────────

    #[test]
    fn index_missing_the_keychain_key_is_still_found_and_preserved_on_overwrite() {
        // The reviewer's probe: a key written from one ~/.motebit, then read
        // and overwritten from another that has no index (moved aside,
        // restored from an older backup, or the index deleted).
        let kc = FakeKeychain::default();
        let dir_a = scratch("index-a");
        store(&kc, &dir_a).set("device_private_key", "K2").unwrap();
        let dir_b = scratch("index-b");
        let s = store(&kc, &dir_b);
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("K2"));
        s.set("device_private_key", "K3").unwrap();
        let entries = kc.entries.borrow();
        assert_eq!(entries["device_private_key"], "K3");
        assert!(
            entries.values().any(|v| v == "K2"),
            "K2 destroyed: {entries:?}"
        );
    }

    #[test]
    fn a_migration_conflict_then_a_set_preserves_both_differing_values() {
        let dir = scratch("conflict-set");
        std::fs::write(dir.join("dev-keyring.json"), "{\"device_private_key\":\"FILE\"}").unwrap();
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("device_private_key".into(), "KEYCHAIN".into());
        let s = store(&kc, &dir);
        assert_eq!(s.migrate().unwrap().conflicts, vec!["device_private_key".to_string()]);
        s.set("device_private_key", "NEW").unwrap();
        assert_eq!(kc.entries.borrow()["device_private_key"], "NEW");
        let mut kept: Vec<String> = kc
            .entries
            .borrow()
            .iter()
            .filter(|(k, _)| k.contains(".preserved-"))
            .map(|(_, v)| v.clone())
            .collect();
        if dir.join("dev-keyring.json").exists() {
            if let serde_json::Value::Object(o) = dev_json(&dir) {
                kept.extend(o.into_iter().filter(|(k, _)| k.contains(".preserved-")).filter_map(|(_, v)| v.as_str().map(String::from)));
            }
        }
        assert!(kept.contains(&"KEYCHAIN".to_string()), "{kept:?}");
        assert!(kept.contains(&"FILE".to_string()), "{kept:?}");
    }

    #[test]
    fn a_keychain_read_error_refuses_writes_and_reads_of_key_material_once_the_keychain_is_in_use() {
        let dir = scratch("kc-error");
        let kc = FakeKeychain::default();
        // In use by evidence of the config alone (no index, key not in the file).
        std::fs::write(dir.join("config.json"), "{\"motebit_id\":\"m-1\"}").unwrap();
        kc.entries.borrow_mut().insert("device_private_key".into(), "K".into());
        *kc.fail_get.borrow_mut() = true;
        let s = store(&kc, &dir);
        assert!(s.get("device_private_key").is_err());
        assert!(s.set("device_private_key", "NEW").is_err());
        assert!(s.set_aside("pending_rotation").is_err());
        // The write path's own re-read refuses too (not only `set`'s get).
        assert!(s.store_raw("device_private_key", "NEW", Some("K")).is_err());
        *kc.fail_get.borrow_mut() = false;
        assert_eq!(kc.entries.borrow()["device_private_key"], "K");
        assert!(!dir.join("dev-keyring.json").exists());
    }

    #[test]
    fn a_keychain_that_never_worked_is_a_file_only_install_not_an_error() {
        // Linux with no Secret Service: every keychain call errors, the file
        // is the store, and absent names are absent (a first launch works).
        let dir = scratch("file-only");
        let kc = FakeKeychain::default();
        *kc.fail_get.borrow_mut() = true;
        *kc.fail_set.borrow_mut() = true;
        let s = store(&kc, &dir);
        assert_eq!(s.get("device_private_key").unwrap(), None);
        s.set("device_private_key", "K").unwrap();
        std::fs::write(dir.join("config.json"), "{\"motebit_id\":\"m-1\"}").unwrap();
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("K"));
        assert_eq!(s.get("pending_rotation").unwrap(), None);
        s.set("pending_rotation", "P").unwrap();
        s.set_aside("pending_rotation").unwrap();
        assert_eq!(dev_json(&dir)["pending_rotation.preserved-T"], "P");
    }

    #[test]
    fn a_write_never_replaces_a_keychain_value_it_did_not_read() {
        let dir = scratch("unaccounted");
        let kc = FakeKeychain::default();
        let s = store(&kc, &dir);
        kc.entries.borrow_mut().insert("device_private_key".into(), "THEIRS".into());
        // store_raw with a stale `previous` (as if get had raced another writer).
        assert!(s.store_raw("device_private_key", "MINE", Some("STALE")).is_err());
        assert_eq!(kc.entries.borrow()["device_private_key"], "THEIRS");
    }

    #[test]
    fn overwriting_a_device_key_preserves_the_old_one_in_the_keychain() {
        let dir = scratch("overwrite-kc");
        let kc = FakeKeychain::default();
        let s = store(&kc, &dir);
        s.set("device_private_key", "OLD").unwrap();
        s.set("device_private_key", "NEW").unwrap();
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("NEW"));
        assert_eq!(
            s.get("device_private_key.preserved-T").unwrap().as_deref(),
            Some("OLD")
        );
        // Re-setting the same value (an idempotent commit retried) keeps nothing new.
        s.set("device_private_key", "NEW").unwrap();
        assert_eq!(s.get("device_private_key.preserved-T-1").unwrap(), None);
        // A non-key name is overwritten plainly.
        s.set("anthropic_api_key", "a").unwrap();
        s.set("anthropic_api_key", "b").unwrap();
        assert_eq!(s.get("anthropic_api_key.preserved-T").unwrap(), None);
    }

    #[test]
    fn overwriting_a_device_key_preserves_the_old_one_in_the_fallback_file() {
        let dir = scratch("overwrite-file");
        let kc = FakeKeychain::default();
        *kc.fail_set.borrow_mut() = true;
        let s = store(&kc, &dir);
        s.set("device_private_key", "OLD").unwrap();
        s.set("device_private_key", "NEW").unwrap();
        let j = dev_json(&dir);
        assert_eq!(j["device_private_key"], "NEW");
        assert_eq!(j["device_private_key.preserved-T"], "OLD");
    }

    #[test]
    fn a_keychain_that_silently_drops_writes_falls_back_to_the_file() {
        let dir = scratch("silent-drop");
        let kc = FakeKeychain::default();
        *kc.drop_writes.borrow_mut() = true;
        let s = store(&kc, &dir);
        s.set("device_private_key", "K").unwrap();
        assert_eq!(dev_json(&dir)["device_private_key"], "K");
        // Not left indexed: the read goes to the file, not to a missing entry.
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("K"));
    }

    #[test]
    fn deleting_or_setting_aside_the_write_ahead_keeps_its_bytes() {
        for keychain_works in [true, false] {
            let dir = scratch("set-aside");
            let kc = FakeKeychain::default();
            *kc.fail_set.borrow_mut() = !keychain_works;
            let s = store(&kc, &dir);
            s.set("pending_rotation", "{\"new_private_key_hex\":\"NN\"}").unwrap();
            s.delete("pending_rotation").unwrap(); // the kit's clear()
            assert_eq!(s.get("pending_rotation").unwrap(), None);
            assert_eq!(
                s.get("pending_rotation.preserved-T").unwrap().as_deref(),
                Some("{\"new_private_key_hex\":\"NN\"}")
            );
            s.set("pending_rotation", "SECOND").unwrap();
            s.set_aside("pending_rotation").unwrap();
            assert_eq!(s.get("pending_rotation").unwrap(), None);
            assert_eq!(
                s.get("pending_rotation.preserved-T-1").unwrap().as_deref(),
                Some("SECOND")
            );
            // Setting aside nothing is a no-op, not an error.
            s.set_aside("pending_rotation").unwrap();
        }
    }

    #[test]
    fn set_aside_fails_closed_when_the_store_cannot_be_read() {
        let dir = scratch("set-aside-fail");
        let kc = FakeKeychain::default();
        let s = store(&kc, &dir);
        s.set("pending_rotation", "HELD").unwrap();
        *kc.fail_get.borrow_mut() = true;
        assert!(s.set_aside("pending_rotation").is_err());
        *kc.fail_get.borrow_mut() = false;
        assert_eq!(s.get("pending_rotation").unwrap().as_deref(), Some("HELD"));
    }

    #[test]
    fn migration_copies_verifies_then_keeps_the_file_aside() {
        let dir = scratch("migrate");
        std::fs::write(
            dir.join("dev-keyring.json"),
            "{\"device_private_key\":\"DK\",\"anthropic_api_key\":\"sk\"}",
        )
        .unwrap();
        let kc = FakeKeychain::default();
        let s = store(&kc, &dir);
        let report = s.migrate().unwrap();
        assert_eq!(report.migrated.len(), 2);
        assert_eq!(kc.entries.borrow().get("device_private_key").map(String::as_str), Some("DK"));
        // The live file is gone only because its bytes were kept first.
        assert!(!dir.join("dev-keyring.json").exists());
        let kept = report.preserved_file.expect("file kept aside");
        assert!(kept.file_name().unwrap().to_string_lossy().starts_with("dev-keyring.json.migrated-"));
        assert!(std::fs::read_to_string(&kept).unwrap().contains("\"DK\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&kept).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // And reads now come from the keychain.
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("DK"));
    }

    #[test]
    fn migration_that_cannot_verify_leaves_the_file_untouched() {
        let dir = scratch("migrate-drop");
        let body = "{\"device_private_key\":\"DK\"}";
        std::fs::write(dir.join("dev-keyring.json"), body).unwrap();
        let kc = FakeKeychain::default();
        *kc.drop_writes.borrow_mut() = true; // set Ok, read-back empty
        let report = store(&kc, &dir).migrate().unwrap();
        assert!(report.migrated.is_empty());
        assert!(report.keychain_unavailable.is_some());
        assert_eq!(std::fs::read_to_string(dir.join("dev-keyring.json")).unwrap(), body);
        assert!(report.preserved_file.is_none());
        // Still readable (not indexed ⇒ served from the file).
        assert_eq!(store(&kc, &dir).get("device_private_key").unwrap().as_deref(), Some("DK"));
    }

    #[test]
    fn migration_never_overwrites_a_different_keychain_value() {
        let dir = scratch("migrate-conflict");
        std::fs::write(dir.join("dev-keyring.json"), "{\"device_private_key\":\"FILE\"}").unwrap();
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("device_private_key".into(), "KEYCHAIN".into());
        let report = store(&kc, &dir).migrate().unwrap();
        assert_eq!(report.conflicts, vec!["device_private_key".to_string()]);
        assert_eq!(kc.entries.borrow()["device_private_key"], "KEYCHAIN");
        assert_eq!(dev_json(&dir)["device_private_key"], "FILE");
    }

    #[test]
    fn migration_refuses_a_damaged_file() {
        let dir = scratch("migrate-damaged");
        std::fs::write(dir.join("dev-keyring.json"), "{ torn").unwrap();
        let kc = FakeKeychain::default();
        assert!(store(&kc, &dir).migrate().is_err());
        assert_eq!(std::fs::read_to_string(dir.join("dev-keyring.json")).unwrap(), "{ torn");
    }

    #[cfg(unix)]
    #[test]
    fn the_fallback_file_is_written_owner_only_and_narrowed_on_load() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("mode");
        let kc = FakeKeychain::default();
        *kc.fail_set.borrow_mut() = true;
        let s = store(&kc, &dir);
        s.set("device_private_key", "K").unwrap();
        let p = dir.join("dev-keyring.json");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        s.get("device_private_key").unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        // Damaged AND 0644: narrowed, then refused.
        std::fs::write(&p, "{ torn").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(s.get("device_private_key").is_err());
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }

    /// The REAL platform keychain (run explicitly:
    /// `cargo test real_keychain -- --ignored`). Proves the backend is
    /// compiled in: the crate's mock store would fail the fresh-Entry read.
    #[test]
    #[ignore]
    fn real_keychain_persists_across_fresh_entries() {
        let service = format!("com.motebit.desktop.test-{}", std::process::id());
        let kc = OsKeychain::new(&service);
        kc.set("probe", "persisted").unwrap();
        // A FRESH OsKeychain/Entry — nothing shared in-process.
        let again = OsKeychain::new(&service);
        let got = again.get("probe");
        again.delete("probe").unwrap();
        assert_eq!(got.unwrap().as_deref(), Some("persisted"));
        assert_eq!(OsKeychain::new(&service).get("probe").unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlinked_fallback_file_is_damage() {
        let dir = scratch("dangling");
        std::os::unix::fs::symlink(dir.join("gone.json"), dir.join("dev-keyring.json")).unwrap();
        let kc = FakeKeychain::default();
        *kc.fail_set.borrow_mut() = true;
        let s = store(&kc, &dir);
        assert!(s.get("device_private_key").is_err());
        assert!(s.set("device_private_key", "NEW").is_err());
        assert!(std::fs::symlink_metadata(dir.join("dev-keyring.json")).unwrap().file_type().is_symlink());
    }
}
