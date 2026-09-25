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
//!  * The keychain laws K1–K6 (docs/proposals/key-file-durability-v1.md,
//!    lane B): no keychain set/delete of a name without a SUCCESSFUL read of
//!    it in the same operation (K1); a failed read is classified — an
//!    UNAVAILABLE keychain (no provider) is file-only mode, a read FAILURE on
//!    an available one refuses and is never "absent" (K2, [`classify`]); the
//!    index is a hint (K3); key material is preserved before any overwrite
//!    or delete (K4); two different values are an error, never a silent pick
//!    (K5). A damaged / unreadable / dangling-symlink `dev-keyring.json` is
//!    an `Err`, and nothing writes over it.
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

/// A keychain read that did not succeed, classified (law K2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// There is no store to ask (no provider / no keychain / no logon
    /// session): file-only mode, main's behavior.
    Unavailable(String),
    /// The store exists but this read failed (denied, cancelled, locked, a
    /// transport fault): the operation refuses; never "absent".
    Failed(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Unavailable(m) => write!(f, "OS keychain unavailable: {}", m),
            ReadError::Failed(m) => write!(f, "OS keychain read failed: {}", m),
        }
    }
}

/// The OS keychain, abstracted. `get` → `Ok(None)` ONLY for "no such entry"
/// (a successful read that found nothing); every other outcome is a
/// classified [`ReadError`]. `delete` of a missing entry is `Ok`.
pub trait SecretStore {
    fn get(&self, name: &str) -> Result<Option<String>, ReadError>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// K2 for the real keychain, decided from keyring 3.6.3's own mapping
/// (`src/{macos,windows,secret_service}.rs::decode_error`). The variants
/// mean opposite things per platform — Linux maps Locked/Prompt/NoResult to
/// `NoStorageAccess`, macOS maps a cancelled or denied prompt to
/// `PlatformFailure` — so this is per platform, never per variant name.
pub fn classify(err: keyring::Error) -> Result<Option<String>, ReadError> {
    match err {
        keyring::Error::NoEntry => Ok(None),
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        keyring::Error::NoStorageAccess(e) => Err(ReadError::Unavailable(e.to_string())),
        #[cfg(target_os = "linux")]
        keyring::Error::PlatformFailure(e) if is_no_secret_service(e.as_ref()) => {
            Err(ReadError::Unavailable(e.to_string()))
        }
        other => Err(ReadError::Failed(other.to_string())),
    }
}

/// Linux: "there is no Secret Service to ask", decided on TYPES, never on
/// message text. Two shapes, both observed live (see the Docker probes in
/// the #762 report):
///  * no session bus at all ⇒ `secret_service::Error::Unavailable` (the
///    crate maps zbus `Address`/`InterfaceNotFound` to it);
///  * a session bus on which NOTHING owns `org.freedesktop.secrets` (i3 /
///    sway / xfce without gnome-keyring; KeePassXC closed) ⇒ the bus daemon
///    answers the first call with the standard D-Bus error
///    `org.freedesktop.DBus.Error.ServiceUnknown` (or `NameHasNoOwner`),
///    reaching us as `Zbus(MethodError(name, ..))`, `Zbus(FDO(..))` or
///    `ZbusFdo(..)`. Every secret-service call is addressed to
///    `org.freedesktop.secrets`, so "the destination has no owner" can only
///    mean that name.
/// Any other D-Bus error is a read failure (fail closed).
#[cfg(target_os = "linux")]
fn is_no_secret_service(e: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    match e.downcast_ref::<secret_service::Error>() {
        Some(secret_service::Error::Unavailable) => true,
        Some(secret_service::Error::Zbus(z)) => zbus_no_owner(z),
        Some(secret_service::Error::ZbusFdo(f)) => fdo_no_owner(f),
        _ => false,
    }
}

#[cfg(target_os = "linux")]
fn zbus_no_owner(z: &zbus::Error) -> bool {
    match z {
        zbus::Error::MethodError(name, _, _) => matches!(
            name.as_str(),
            "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner"
        ),
        zbus::Error::FDO(f) => fdo_no_owner(f),
        _ => false,
    }
}

#[cfg(target_os = "linux")]
fn fdo_no_owner(f: &zbus::fdo::Error) -> bool {
    matches!(
        f,
        zbus::fdo::Error::ServiceUnknown(_) | zbus::fdo::Error::NameHasNoOwner(_)
    )
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
    fn get(&self, name: &str) -> Result<Option<String>, ReadError> {
        let entry = self.entry(name).map_err(ReadError::Failed)?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(e) => classify(e),
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

    /// K3's one-way use of the index: it can only make the store MORE
    /// conservative. Key material the index lists — or that a
    /// `dev-keyring.json.migrated-*` copy shows was moved into the keychain —
    /// lives in the keychain; while the keychain is unavailable such a name
    /// is refused, never read as absent (so no first launch mints over it)
    /// and never written to the file (so no second candidate appears). A
    /// damaged index or migrated copy counts as evidence. The index never
    /// makes anything exist; it only withholds "absent".
    fn refuse_if_keychain_held(&self, name: &str, why: &str) -> Result<(), String> {
        if !guards_absence(name) {
            return Ok(());
        }
        if self.index_may_list(name) || self.migrated_copy_may_hold(name) {
            return Err(format!(
                "{} is stored in the OS keychain, which is unavailable right now ({}). Unlock or start your keyring (e.g. gnome-keyring, or KeePassXC with its Secret Service enabled) and retry. Nothing was changed.",
                name, why
            ));
        }
        Ok(())
    }

    fn index_may_list(&self, name: &str) -> bool {
        match read_strict(&self.index_path()) {
            Ok(None) => false,
            Ok(Some(bytes)) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(v) => v["keys"]
                    .as_array()
                    .map_or(true, |keys| keys.iter().any(|k| k.as_str() == Some(name))),
                Err(_) => true,
            },
            Err(_) => true,
        }
    }

    fn migrated_copy_may_hold(&self, name: &str) -> bool {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return false;
        };
        entries.filter_map(|e| e.ok()).any(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            if !file.starts_with("dev-keyring.json.migrated-") {
                return false;
            }
            match read_strict(&e.path()) {
                Ok(Some(bytes)) => serde_json::from_slice::<serde_json::Value>(&bytes)
                    .map_or(true, |v| v.get(name).is_some()),
                _ => true,
            }
        })
    }

    // ── reads ────────────────────────────────────────────────────────────

    /// The value held for `name`, per the laws in
    /// docs/proposals/key-file-durability-v1.md (lane B):
    ///  * K2 — the keychain is asked for EVERY name (K3: the index decides
    ///    nothing). Unavailable ⇒ the file alone answers (file-only mode). A
    ///    read failure ⇒ `Err`, never "absent".
    ///  * K5 — for key material, a keychain value and a DIFFERENT file value
    ///    is an `Err`: two candidates, and no guess between them.
    pub fn get(&self, name: &str) -> Result<Option<String>, String> {
        let dev = self.read_dev()?;
        let in_dev = dev.as_ref().and_then(|m| m.get(name)).cloned();
        match self.secret.get(name) {
            Ok(Some(k)) => {
                self.note_in_keychain(name, true);
                if let Some(f) = in_dev.as_deref() {
                    if f != k && guards_absence(name) {
                        return Err(format!(
                            "{} holds two different values — one in the OS keychain, one in {}. Refusing to choose between them; nothing was changed.",
                            name,
                            self.dev_path().display()
                        ));
                    }
                }
                Ok(Some(k))
            }
            Ok(None) => {
                self.note_in_keychain(name, false);
                Ok(in_dev)
            }
            Err(ReadError::Unavailable(why)) => {
                // K3 brake: the index (or a migrated copy) says this key
                // lives in the keychain — an absent keychain is not an
                // absent key.
                self.refuse_if_keychain_held(name, &why)?;
                Ok(in_dev)
            }
            Err(e @ ReadError::Failed(_)) => Err(format!(
                "{} could not be read ({}). It is not absent; nothing was changed. Allow Motebit keychain access and retry.",
                name, e
            )),
        }
    }

    // ── writes ───────────────────────────────────────────────────────────

    /// Store `value` under `name`. K4: the previous value of key material is
    /// preserved (and verified) first when it differs.
    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let old = self.get(name)?; // K2: refuses on a read failure
        if let Some(old) = old.as_deref() {
            if old != value && is_key_material(name) {
                self.preserve_value(name, old)?;
            }
        }
        self.store_raw(name, value, old.as_deref())
    }

    /// Remove `name`. Key material is preserved first (K4; this is also what
    /// `clear()` of the rotation write-ahead does).
    pub fn delete(&self, name: &str) -> Result<(), String> {
        if is_key_material(name) {
            return self.set_aside(name);
        }
        let _ = self.get(name)?; // a damaged / unreadable store refuses too
        self.remove_raw(name)
    }

    /// Move `name` out of the active slot WITHOUT destroying its bytes (the
    /// surface-kit `setAside` verb): kept as `<name>.preserved-<time>`,
    /// verified, then removed. Any failure is an `Err`, entry left in place.
    pub fn set_aside(&self, name: &str) -> Result<(), String> {
        let Some(old) = self.get(name)? else {
            return self.remove_raw(name);
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

    /// Write `value` without the preserve step; `previous` is the value
    /// `set` read (and preserved) — the only value this write may replace.
    ///
    /// K1: the keychain is read for `name` HERE, in this operation, and is
    /// mutated only after that read succeeded. A read failure refuses; an
    /// unavailable keychain means the file is written and the keychain is
    /// never touched.
    fn store_raw(&self, name: &str, value: &str, previous: Option<&str>) -> Result<(), String> {
        let dev = self.read_dev()?;
        let current = match self.secret.get(name) {
            Ok(v) => v,
            Err(ReadError::Unavailable(why)) => {
                // K3 brake: a key that lives in the keychain is never
                // shadowed by a file write while the keychain is away.
                self.refuse_if_keychain_held(name, &why)?;
                // File-only mode: the keychain is not mutated (K1).
                return self.write_file_entry(dev, name, value, previous, &why);
            }
            Err(e @ ReadError::Failed(_)) => {
                return Err(format!(
                    "{} could not be read before writing ({}); refusing to write over what it may hold. Nothing was changed.",
                    name, e
                ));
            }
        };
        // K4: a keychain value this write did not read (and so did not
        // preserve) is never replaced.
        if let Some(cur) = current.as_deref() {
            if cur != value && Some(cur) != previous {
                return Err(format!(
                    "the OS keychain holds a value for {} that this write did not account for; refusing to overwrite it. Nothing was changed.",
                    name
                ));
            }
        }
        if let Err(set_err) = self.secret.set(name, value) {
            // Double fault guard: with a value held there, a file write would
            // leave two candidates (K5) — refuse. With nothing held (a
            // successful read said so), the file takes it.
            if current.is_some() {
                return Err(format!(
                    "the OS keychain refused to replace {} ({}) and still holds its value; nothing was changed",
                    name, set_err
                ));
            }
            return self.write_file_entry(dev, name, value, previous, &set_err);
        }
        match self.secret.get(name) {
            Ok(Some(v)) if v == value => {}
            Ok(None) if current.is_none() => {
                // Accepted but not kept (a silent drop): the keychain holds
                // nothing for this name, so the file takes it.
                return self.write_file_entry(dev, name, value, previous, "the keychain did not keep the write");
            }
            Ok(_) => {
                return Err(format!(
                    "keychain write of {} did not read back; the previous value is kept as a .preserved copy. Nothing else was changed.",
                    name
                ))
            }
            Err(e) => {
                // Double fault: the write may or may not have landed. The
                // previous value was preserved before it (K4); the file is
                // not touched, so no second candidate is created.
                return Err(format!(
                    "keychain write of {} could not be confirmed ({}); the previous value is kept as a .preserved copy. Nothing else was changed.",
                    name, e
                ));
            }
        }
        self.note_in_keychain(name, true);
        // The keychain now holds `value`. A different file value for this
        // name that was not the one preserved is key material: keep it.
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

    fn write_file_entry(
        &self,
        dev: Option<Map>,
        name: &str,
        value: &str,
        previous: Option<&str>,
        why: &str,
    ) -> Result<(), String> {
        let mut map = dev.unwrap_or_default();
        if let Some(old) = map.get(name).cloned() {
            if old != value && is_key_material(name) && previous != Some(old.as_str()) {
                keep_in_map(&mut map, name, old, &(self.stamp)());
            }
        }
        map.insert(name.to_string(), value.to_string());
        self.write_dev(&map)
            .map_err(|e| format!("could not store {} in the fallback file ({}): {}", name, why, e))?;
        eprintln!(
            "[motebit] {} stored in {} (plaintext, 0600) — keychain not used: {}",
            name,
            self.dev_path().display(),
            why
        );
        Ok(())
    }

    /// K1 for deletes: the keychain entry is deleted only after a successful
    /// read of it in this operation. Callers preserve first (K4).
    fn remove_raw(&self, name: &str) -> Result<(), String> {
        let dev = self.read_dev()?;
        match self.secret.get(name) {
            Ok(Some(_)) => self.secret.delete(name)?,
            Ok(None) => {}
            Err(ReadError::Unavailable(why)) => self.refuse_if_keychain_held(name, &why)?,
            Err(e @ ReadError::Failed(_)) => {
                return Err(format!(
                    "{} could not be read before removing it ({}); nothing was changed",
                    name, e
                ))
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
                    // K1: mutated only after the successful read above.
                    let ok = self.secret.set(name, value).and_then(|()| match self.secret.get(name) {
                        Ok(Some(v)) if &v == value => Ok(()),
                        Ok(_) => Err(format!("{} did not read back from the keychain", name)),
                        Err(e) => Err(e.to_string()),
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
                    // Unavailable or unreadable: no keychain mutation (K1).
                    report.keychain_unavailable = Some(e.to_string());
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
        /// Reads fail on an AVAILABLE keychain (denied / cancelled / locked).
        pub fail_get: RefCell<bool>,
        pub fail_set: RefCell<bool>,
        /// No store at all (no provider): reads are `Unavailable`, writes fail.
        pub unavailable: RefCell<bool>,
        /// Accepts writes but does not persist them (the silent-drop shape).
        pub drop_writes: RefCell<bool>,
        /// Double fault: after a write of this name, every read fails.
        pub fail_reads_after_set_of: RefCell<Option<String>>,
    }
    impl SecretStore for &FakeKeychain {
        fn get(&self, name: &str) -> Result<Option<String>, ReadError> {
            if *self.unavailable.borrow() {
                return Err(ReadError::Unavailable("no secret service provider".into()));
            }
            if *self.fail_get.borrow() {
                return Err(ReadError::Failed("user cancelled the keychain prompt".into()));
            }
            Ok(self.entries.borrow().get(name).cloned())
        }
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            if *self.unavailable.borrow() {
                return Err("no secret service provider".into());
            }
            if *self.fail_set.borrow() {
                return Err("keychain refused the write".into());
            }
            if !*self.drop_writes.borrow() {
                self.entries.borrow_mut().insert(name.into(), value.into());
            }
            if self.fail_reads_after_set_of.borrow().as_deref() == Some(name) {
                *self.fail_get.borrow_mut() = true;
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
        // K2: an UNAVAILABLE keychain (no provider) is file-only mode.
        *kc.unavailable.borrow_mut() = true;
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

    // ── State table (docs/proposals/key-file-durability-v1.md, lane B) ───

    fn kc_values(kc: &FakeKeychain) -> Vec<String> {
        kc.entries.borrow().values().cloned().collect()
    }

    /// Reviewer probe p1 (#760 close): a keychain whose READ fails while its
    /// WRITE would be accepted (a dismissed prompt, then an allowed one).
    /// K1: no keychain mutation without a successful read — OLD survives.
    #[test]
    fn p1_read_fails_write_would_succeed_set_refuses_and_old_survives() {
        let dir = scratch("p1");
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("device_private_key".into(), "OLD".into());
        *kc.fail_get.borrow_mut() = true; // fail_set stays false
        let s = store(&kc, &dir);
        assert!(s.set("device_private_key", "NEW").is_err());
        // Even the raw writer, handed a `previous`, re-reads and refuses.
        assert!(s.store_raw("device_private_key", "NEW", Some("OLD")).is_err());
        assert!(s.store_raw("device_private_key", "NEW", None).is_err());
        assert_eq!(kc.entries.borrow()["device_private_key"], "OLD");
        assert_eq!(kc.entries.borrow().len(), 1, "nothing written: {:?}", kc_values(&kc));
        assert!(!dir.join("dev-keyring.json").exists(), "no file candidate either");
    }

    /// Reviewer probe p2: the delete twin. K1: no delete without a read.
    #[test]
    fn p2_read_fails_delete_and_set_aside_refuse_and_the_entry_survives() {
        let dir = scratch("p2");
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("pending_rotation".into(), "HELD".into());
        kc.entries.borrow_mut().insert("anthropic_api_key".into(), "sk".into());
        *kc.fail_get.borrow_mut() = true;
        let s = store(&kc, &dir);
        assert!(s.delete("pending_rotation").is_err());
        assert!(s.set_aside("pending_rotation").is_err());
        assert!(s.delete("anthropic_api_key").is_err());
        assert!(s.remove_raw("pending_rotation").is_err());
        assert_eq!(kc.entries.borrow()["pending_rotation"], "HELD");
        assert_eq!(kc.entries.borrow()["anthropic_api_key"], "sk");
    }

    /// Row 8, read side: a read failure is never "absent" (R1) — and the
    /// message names what to do (follow-up 3: no "OS keychain" wording on
    /// a file-only machine — that is row 1/2, which never errors).
    #[test]
    fn row8_a_read_failure_is_an_error_even_with_a_file_value() {
        let dir = scratch("row8");
        std::fs::write(dir.join("dev-keyring.json"), "{\"device_private_key\":\"F\"}").unwrap();
        let kc = FakeKeychain::default();
        *kc.fail_get.borrow_mut() = true;
        let err = store(&kc, &dir).get("device_private_key").unwrap_err();
        assert!(err.contains("not absent") && err.contains("keychain access"), "{err}");
        let err = store(&kc, &dir).get("anthropic_api_key").unwrap_err();
        assert!(err.contains("not absent"), "{err}");
    }

    /// Rows 1 and 2 (K2): unavailable ⇒ file-only mode, exactly main's
    /// behavior; the keychain is never mutated; no error mentions it.
    #[test]
    fn k2_unavailable_is_file_only_mode() {
        let dir = scratch("unavailable");
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("device_private_key".into(), "IN-KC-UNREACHABLE".into());
        *kc.unavailable.borrow_mut() = true;
        let s = store(&kc, &dir);
        assert_eq!(s.get("device_private_key").unwrap(), None); // row 1
        s.set("device_private_key", "F").unwrap();
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("F"));
        s.set("device_private_key", "F2").unwrap(); // row 2
        let j = dev_json(&dir);
        assert_eq!(j["device_private_key"], "F2");
        assert_eq!(j["device_private_key.preserved-T"], "F");
        s.set("pending_rotation", "P").unwrap();
        s.set_aside("pending_rotation").unwrap();
        assert_eq!(dev_json(&dir)["pending_rotation.preserved-T"], "P");
        // K1: the unreachable keychain value was never touched.
        assert_eq!(kc.entries.borrow()["device_private_key"], "IN-KC-UNREACHABLE");
        assert_eq!(kc.entries.borrow().len(), 1);
    }

    /// Row 3: available and empty ⇒ the keychain, verified, indexed.
    #[test]
    fn row3_available_empty_writes_the_keychain() {
        let dir = scratch("row3");
        let kc = FakeKeychain::default();
        let s = store(&kc, &dir);
        assert_eq!(s.get("device_private_key").unwrap(), None);
        s.set("device_private_key", "K").unwrap();
        assert_eq!(kc.entries.borrow()["device_private_key"], "K");
        assert!(!dir.join("dev-keyring.json").exists());
        assert!(std::fs::read_to_string(dir.join("keychain-index.json")).unwrap().contains("device_private_key"));
    }

    /// Row 4: file holds F, keychain empty ⇒ F preserved, NEW in the keychain,
    /// F leaves the active file slot.
    #[test]
    fn row4_file_value_is_kept_when_the_keychain_takes_over() {
        let dir = scratch("row4");
        std::fs::write(dir.join("dev-keyring.json"), "{\"device_private_key\":\"F\"}").unwrap();
        let kc = FakeKeychain::default();
        let s = store(&kc, &dir);
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("F"));
        s.set("device_private_key", "NEW").unwrap();
        assert_eq!(kc.entries.borrow()["device_private_key"], "NEW");
        assert!(kc_values(&kc).contains(&"F".to_string()), "F destroyed");
        assert!(dev_json(&dir).get("device_private_key").is_none());
    }

    /// Row 6: the same value in both places is one value.
    #[test]
    fn row6_same_value_in_both_is_one_value() {
        let dir = scratch("row6");
        std::fs::write(dir.join("dev-keyring.json"), "{\"device_private_key\":\"K\"}").unwrap();
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("device_private_key".into(), "K".into());
        let s = store(&kc, &dir);
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("K"));
        s.set("device_private_key", "NEW").unwrap();
        assert_eq!(kc.entries.borrow()["device_private_key"], "NEW");
        assert!(kc_values(&kc).contains(&"K".to_string()));
    }

    /// Row 7 (K5): two different values ⇒ an error, never a silent choice;
    /// writes and deletes refuse; both values stay.
    #[test]
    fn k5_two_different_values_refuse() {
        let dir = scratch("row7");
        std::fs::write(dir.join("dev-keyring.json"), "{\"device_private_key\":\"FILE\"}").unwrap();
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("device_private_key".into(), "KEYCHAIN".into());
        let s = store(&kc, &dir);
        // Migration leaves the conflict in place…
        assert_eq!(s.migrate().unwrap().conflicts, vec!["device_private_key".to_string()]);
        // …and every operation on it refuses.
        assert!(s.get("device_private_key").unwrap_err().contains("two different values"));
        assert!(s.set("device_private_key", "NEW").is_err());
        assert!(s.set_aside("device_private_key").is_err());
        assert_eq!(kc.entries.borrow()["device_private_key"], "KEYCHAIN");
        assert_eq!(dev_json(&dir)["device_private_key"], "FILE");
    }

    /// Double fault, case 1: the keychain holds K, the write is refused.
    /// A file write would create a second candidate (K5) — refuse instead.
    #[test]
    fn double_fault_refused_write_with_a_held_value_refuses() {
        let dir = scratch("dfault1");
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("device_private_key".into(), "K".into());
        *kc.fail_set.borrow_mut() = true;
        let s = store(&kc, &dir);
        assert!(s.set("device_private_key", "NEW").is_err());
        assert_eq!(kc.entries.borrow()["device_private_key"], "K");
        let file_has_active = dir.join("dev-keyring.json").exists()
            && dev_json(&dir).get("device_private_key").is_some();
        assert!(!file_has_active, "a second candidate was written");
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("K"));
    }

    /// Double fault, case 2: the write lands, then the confirming read
    /// errors. The old value was preserved BEFORE the write (K4); the file is
    /// not touched; the operation reports the uncertainty.
    #[test]
    fn double_fault_verify_read_error_refuses_and_keeps_the_old_value() {
        let dir = scratch("dfault2");
        let kc = FakeKeychain::default();
        kc.entries.borrow_mut().insert("device_private_key".into(), "K".into());
        *kc.fail_reads_after_set_of.borrow_mut() = Some("device_private_key".into());
        let s = store(&kc, &dir);
        assert!(s.set("device_private_key", "NEW").is_err());
        assert_eq!(kc.entries.borrow()["device_private_key.preserved-T"], "K");
        assert!(!dir.join("dev-keyring.json").exists());
    }

    /// Reviewer probe Q1 (#762): a key migrated INTO the keychain, then the
    /// keychain goes away (no provider). Row 1b: the index brake refuses —
    /// no Ok(None), so no first-launch / divergence mint over it, and no
    /// file write that would become a second candidate.
    #[test]
    fn q1_migrated_key_with_keychain_unavailable_refuses_never_absent() {
        let dir = scratch("q1");
        std::fs::write(dir.join("dev-keyring.json"), "{\"device_private_key\":\"K\"}").unwrap();
        let kc = FakeKeychain::default();
        let s = store(&kc, &dir);
        assert_eq!(s.migrate().unwrap().migrated, vec!["device_private_key".to_string()]);
        assert!(!dir.join("dev-keyring.json").exists());
        *kc.unavailable.borrow_mut() = true;
        let err = s.get("device_private_key").unwrap_err();
        assert!(err.contains("stored in the OS keychain") && err.contains("Unlock or start"), "{err}");
        assert!(s.set("device_private_key", "MINTED").is_err());
        assert!(s.set_aside("device_private_key").is_err());
        assert!(s.store_raw("device_private_key", "MINTED", None).is_err());
        assert!(s.remove_raw("device_private_key").is_err());
        assert!(!dir.join("dev-keyring.json").exists(), "no second candidate written");
        // The evidence survives the index being lost: the migrated copy.
        std::fs::remove_file(dir.join("keychain-index.json")).unwrap();
        assert!(s.get("device_private_key").is_err());
        // Keychain back: the key reads normally.
        *kc.unavailable.borrow_mut() = false;
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("K"));
    }

    /// Row 1b from the index alone (no migrated copy): the index row brakes.
    #[test]
    fn row1b_an_index_row_alone_brakes_key_material() {
        let dir = scratch("row1b-index");
        std::fs::write(dir.join("keychain-index.json"), "{\"keys\":[\"device_private_key\"]}").unwrap();
        let kc = FakeKeychain::default();
        *kc.unavailable.borrow_mut() = true;
        let s = store(&kc, &dir);
        assert!(s.get("device_private_key").is_err());
        assert!(s.set("device_private_key", "MINTED").is_err());
        assert!(!dir.join("dev-keyring.json").exists());
        // A damaged index is evidence too.
        std::fs::write(dir.join("keychain-index.json"), "{ torn").unwrap();
        assert!(s.get("device_private_key").is_err());
    }

    /// Row 1b brake is key-material only, and a fresh file-only machine
    /// (no index, no migrated copy) stays exactly main's behavior.
    #[test]
    fn row1a_fresh_file_only_machine_is_unaffected_by_the_brake() {
        let dir = scratch("row1a");
        let kc = FakeKeychain::default();
        *kc.unavailable.borrow_mut() = true;
        let s = store(&kc, &dir);
        assert_eq!(s.get("device_private_key").unwrap(), None);
        s.set("device_private_key", "K").unwrap();
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("K"));
        // An indexed NON-key name (an API key) is not braked.
        std::fs::write(dir.join("keychain-index.json"), "{\"keys\":[\"anthropic_api_key\"]}").unwrap();
        assert_eq!(s.get("anthropic_api_key").unwrap(), None);
        assert_eq!(s.get("device_private_key").unwrap().as_deref(), Some("K"));
    }

    /// The live "session bus, no provider" shapes (#762 finding 1), built
    /// from the crates' own types: every one is UNAVAILABLE (row 1a/1b),
    /// while other D-Bus errors stay read FAILURES.
    #[cfg(target_os = "linux")]
    #[test]
    fn k2_linux_no_owner_of_org_freedesktop_secrets_is_unavailable() {
        use zbus::fdo;
        let wrap = |e: secret_service::Error| classify(keyring::Error::PlatformFailure(Box::new(e)));
        let unavailable = |r: Result<Option<String>, ReadError>| matches!(r, Err(ReadError::Unavailable(_)));
        let msg = "The name org.freedesktop.secrets was not provided by any .service files".to_string();
        assert!(unavailable(wrap(secret_service::Error::ZbusFdo(fdo::Error::ServiceUnknown(msg.clone())))));
        assert!(unavailable(wrap(secret_service::Error::ZbusFdo(fdo::Error::NameHasNoOwner(msg.clone())))));
        assert!(unavailable(wrap(secret_service::Error::Zbus(zbus::Error::FDO(Box::new(
            fdo::Error::ServiceUnknown(msg.clone())
        ))))));
        // The exact live shape: Zbus(MethodError("…ServiceUnknown", …)).
        let reply = zbus::Message::method("/org/freedesktop/secrets", "OpenSession")
            .unwrap()
            .build(&())
            .unwrap();
        let name = zbus::names::OwnedErrorName::try_from("org.freedesktop.DBus.Error.ServiceUnknown").unwrap();
        assert!(unavailable(wrap(secret_service::Error::Zbus(zbus::Error::MethodError(
            name,
            Some(msg.clone()),
            reply.clone()
        )))));
        // A different D-Bus error from an AVAILABLE provider is a failure.
        let denied = zbus::names::OwnedErrorName::try_from("org.freedesktop.DBus.Error.AccessDenied").unwrap();
        assert!(!unavailable(wrap(secret_service::Error::Zbus(zbus::Error::MethodError(
            denied,
            None,
            reply
        )))));
        assert!(!unavailable(wrap(secret_service::Error::ZbusFdo(fdo::Error::AccessDenied(msg)))));
    }

    /// K2 classification of the REAL keyring errors, per platform.
    #[test]
    fn k2_classify_uses_the_platform_meaning_of_each_variant() {
        fn boxed(m: &str) -> Box<dyn std::error::Error + Send + Sync> {
            Box::new(std::io::Error::new(std::io::ErrorKind::Other, m.to_string()))
        }
        assert_eq!(classify(keyring::Error::NoEntry), Ok(None));
        let nsa = classify(keyring::Error::NoStorageAccess(boxed("x")));
        let pf = classify(keyring::Error::PlatformFailure(boxed("x")));
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            // NoStorageAccess = errSecNotAvailable / no logon session.
            assert!(matches!(nsa, Err(ReadError::Unavailable(_))));
            // PlatformFailure = cancelled / denied / locked.
            assert!(matches!(pf, Err(ReadError::Failed(_))));
        }
        #[cfg(target_os = "linux")]
        {
            // NoStorageAccess = Locked / Prompt / NoResult on Linux.
            assert!(matches!(nsa, Err(ReadError::Failed(_))));
            // A generic D-Bus failure is a read failure…
            assert!(matches!(pf, Err(ReadError::Failed(_))));
            // …only the crate's own "no provider" is unavailable.
            let none = classify(keyring::Error::PlatformFailure(Box::new(
                secret_service::Error::Unavailable,
            )));
            assert!(matches!(none, Err(ReadError::Unavailable(_))));
        }
        let _ = (nsa, pf);
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
