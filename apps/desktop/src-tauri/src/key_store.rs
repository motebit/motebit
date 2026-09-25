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
//!  * R1 — absence is not damage. `keychain-index.json` records which names
//!    live in the keychain, so a keychain that errors (locked, prompt
//!    cancelled, service down) for a name it is supposed to hold is an `Err`,
//!    never "no key" — and a first launch never mints over a key it could not
//!    read. A damaged / unreadable / dangling-symlink `dev-keyring.json` is an
//!    `Err` too, and nothing writes over it.
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

    fn read_index(&self) -> Result<BTreeSet<String>, String> {
        let path = self.index_path();
        let Some(bytes) = read_strict(&path)? else {
            return Ok(BTreeSet::new());
        };
        #[derive(serde::Deserialize)]
        struct Index {
            keys: Vec<String>,
        }
        serde_json::from_slice::<Index>(&bytes)
            .map(|i| i.keys.into_iter().collect())
            .map_err(|e| {
                format!(
                    "{} is damaged ({}); it records which secrets live in the OS keychain. It has NOT been changed.",
                    path.display(),
                    e
                )
            })
    }

    fn write_index(&self, keys: &BTreeSet<String>) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let json = serde_json::json!({ "keys": keys }).to_string();
        write_file_atomic_owner_only(&self.index_path(), json.as_bytes(), None)
    }

    // ── reads ────────────────────────────────────────────────────────────

    /// R1. `Ok(None)` means: not indexed in the keychain AND the fallback file
    /// is absent or has no such entry. Everything uncertain is an `Err`.
    pub fn get(&self, name: &str) -> Result<Option<String>, String> {
        let index = self.read_index()?;
        let dev = self.read_dev()?;
        let in_dev = dev.as_ref().and_then(|m| m.get(name)).cloned();
        if index.contains(name) {
            return match self.secret.get(name) {
                Ok(Some(v)) => Ok(Some(v)),
                Ok(None) => match in_dev {
                    Some(v) => Ok(Some(v)),
                    None => Err(format!(
                        "{} is recorded as stored in the OS keychain but the keychain has no such entry. Treating that as damage, not absence; nothing was changed.",
                        name
                    )),
                },
                Err(e) => match in_dev {
                    Some(v) => Ok(Some(v)),
                    None => Err(format!(
                        "{} could not be read from the OS keychain ({}). It is not absent; nothing was changed.",
                        name, e
                    )),
                },
            };
        }
        Ok(in_dev)
    }

    // ── writes ───────────────────────────────────────────────────────────

    /// Store `value` under `name`: the keychain when it accepts and verifies
    /// the write, else the fallback file. The previous value of a
    /// key-material name is preserved first when it differs.
    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let old = self.get(name)?; // refuses on any uncertainty
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

    /// Write without the preserve step. `previous` is what `get` returned.
    fn store_raw(&self, name: &str, value: &str, previous: Option<&str>) -> Result<(), String> {
        let mut index = self.read_index()?;
        let dev = self.read_dev()?;
        // Record the name BEFORE writing the keychain, so a crash after the
        // keychain write still finds it (R1: listed-but-missing is damage).
        let newly_indexed = index.insert(name.to_string());
        if newly_indexed {
            self.write_index(&index)?;
        }
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
                // The keychain is now authoritative. A different value left in
                // the file for this name is key material we must not drop.
                if let Some(mut map) = dev {
                    if let Some(stale) = map.remove(name) {
                        if stale != value && is_key_material(name) && previous != Some(stale.as_str()) {
                            let stamp = (self.stamp)();
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
                            map.insert(kept, stale);
                        }
                        self.write_dev(&map)?;
                    }
                }
                Ok(())
            }
            Err(keychain_err) => {
                // Fallback: the file. The keychain may still hold an OLD
                // value for this name; un-index it so reads go to the file
                // (the old keychain value is left in place, never deleted).
                let mut map = dev.unwrap_or_default();
                map.insert(name.to_string(), value.to_string());
                self.write_dev(&map).map_err(|e| {
                    format!(
                        "could not store {}: keychain ({}) and fallback file ({}) both failed",
                        name, keychain_err, e
                    )
                })?;
                if index.remove(name) {
                    self.write_index(&index)?;
                }
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

    fn remove_raw(&self, name: &str) -> Result<(), String> {
        let mut index = self.read_index()?;
        if index.contains(name) {
            self.secret.delete(name)?;
            index.remove(name);
            self.write_index(&index)?;
        }
        if let Some(mut map) = self.read_dev()? {
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
        let mut index = self.read_index()?;
        let mut done: Vec<String> = Vec::new();
        for (name, value) in &dev {
            match self.secret.get(name) {
                Ok(Some(existing)) if &existing == value => {
                    if index.insert(name.clone()) {
                        self.write_index(&index)?;
                    }
                    done.push(name.clone());
                }
                Ok(Some(_)) => report.conflicts.push(name.clone()),
                Ok(None) => {
                    if index.insert(name.clone()) {
                        self.write_index(&index)?;
                    }
                    let ok = self.secret.set(name, value).and_then(|()| match self.secret.get(name) {
                        Ok(Some(v)) if &v == value => Ok(()),
                        Ok(_) => Err(format!("{} did not read back from the keychain", name)),
                        Err(e) => Err(e),
                    });
                    match ok {
                        Ok(()) => done.push(name.clone()),
                        Err(e) => {
                            index.remove(name);
                            self.write_index(&index)?;
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
        // Not indexed ⇒ the keychain is not even asked (a locked keychain
        // cannot turn a true absence into an error, nor the reverse).
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
        *kc.fail_get.borrow_mut() = false;
        kc.entries.borrow_mut().clear(); // deleted outside the app
        assert!(s.get("device_private_key").is_err());
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
