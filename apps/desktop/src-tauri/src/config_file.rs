//! `~/.motebit/config.json` — SHARED with the CLI and create-motebit.
//!
//! The CLI keeps `cli_encrypted_key` here — for a CLI identity the only copy
//! of the private key — and every surface keeps the identity binding here
//! (`motebit_id`, `device_id`, `device_public_key`, `_identity_file`). So:
//!
//!  * R1/R3 via `durable_file::read_strict` (absence only on NotFound; a
//!    damaged file is narrowed and reported, never read as `{}`).
//!  * The desktop never changes a `cli_*` field: it does not own them.
//!  * No write removes an identity field; a write that CHANGES binding
//!    material keeps the old file first (`config.json.clobbered-<time>`).
//!  * Lost updates: every desktop writer goes through `update_config_at`, a
//!    field-level merge done in one Rust call (no JS read→write window), and
//!    the rename happens only if the file still holds the bytes the merge
//!    was computed from (compare-and-swap, retried). The CLI and
//!    create-motebit take `config.json.lock`; the DESKTOP does not (it
//!    serializes its own writers with an in-process mutex plus this byte
//!    compare-and-swap). So a CLI write landing between the desktop's final
//!    comparison and its rename (microseconds) is reverted — the residual
//!    window, named, not hidden; adopting the shared lock is a #764
//!    follow-up.

use crate::durable_file::{preserve_aside, read_strict, write_file_atomic_owner_only, Keep};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// Fields no desktop write may REMOVE. They may change (rotation, restore).
pub const IDENTITY_FIELDS: [&str; 5] = [
    "motebit_id",
    "device_id",
    "device_public_key",
    "cli_encrypted_key",
    "cli_private_key",
];

/// Binding material: a write that changes any of these keeps the old file.
pub const BINDING_FIELDS: [&str; 4] = [
    "motebit_id",
    "device_id",
    "device_public_key",
    "_identity_file",
];

fn is_cli_owned(key: &str) -> bool {
    key.starts_with("cli_")
}

pub fn config_path() -> Result<PathBuf, String> {
    Ok(crate::durable_file::motebit_dir()?.join("config.json"))
}

/// The parsed file plus the exact bytes it was parsed from (the CAS token).
struct Snapshot {
    bytes: Option<Vec<u8>>,
    object: Map<String, Value>,
}

fn parse_object(path: &Path, bytes: &[u8]) -> Result<Map<String, Value>, String> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(o)) => Ok(o),
        Ok(_) => Err(format!(
            "{} exists but is not a JSON object. It has NOT been changed.",
            path.display()
        )),
        Err(e) => Err(format!(
            "{} exists but is not valid JSON ({}). It has NOT been changed.",
            path.display(),
            e
        )),
    }
}

fn snapshot(path: &Path) -> Result<Snapshot, String> {
    match read_strict(path)? {
        None => Ok(Snapshot {
            bytes: None,
            object: Map::new(),
        }),
        Some(bytes) => {
            let object = parse_object(path, &bytes)?;
            Ok(Snapshot {
                bytes: Some(bytes),
                object,
            })
        }
    }
}

/// R1. `Ok(None)` is absence; `Err` is damage (narrowed first, file untouched).
pub fn read_config_at(path: &Path) -> Result<Option<String>, String> {
    let snap = snapshot(path)?;
    Ok(snap
        .bytes
        .map(|b| String::from_utf8_lossy(&b).into_owned()))
}

fn present(o: &Map<String, Value>, k: &str) -> bool {
    o.get(k).is_some_and(|v| !v.is_null())
}

fn refuse_dropped_identity_fields(old: &Map<String, Value>, new: &Map<String, Value>) -> Result<(), String> {
    let dropped: Vec<&str> = IDENTITY_FIELDS
        .iter()
        .copied()
        .filter(|k| present(old, k) && !present(new, k))
        .collect();
    if dropped.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Refusing to write config: it would remove {} from the existing file (merge, never replace). Nothing was changed.",
            dropped.join(", ")
        ))
    }
}

/// The desktop never owns a `cli_*` field: any difference (added, changed,
/// removed) between what is on disk and what the desktop would write is
/// refused. A stale snapshot written back would otherwise destroy the key a
/// CLI rotation just committed.
fn refuse_changed_cli_fields(old: &Map<String, Value>, new: &Map<String, Value>) -> Result<(), String> {
    let mut keys: Vec<&String> = old.keys().chain(new.keys()).filter(|k| is_cli_owned(k)).collect();
    keys.sort();
    keys.dedup();
    let changed: Vec<&str> = keys
        .into_iter()
        .filter(|k| old.get(k.as_str()) != new.get(k.as_str()))
        .map(|k| k.as_str())
        .collect();
    if changed.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Refusing to write config: it would change {} — fields the motebit CLI owns (its identity key). The desktop never writes them. Nothing was changed.",
            changed.join(", ")
        ))
    }
}

fn binding_changes(old: &Map<String, Value>, new: &Map<String, Value>) -> bool {
    BINDING_FIELDS
        .iter()
        .any(|k| present(old, k) && old.get(*k) != new.get(*k))
}

/// The CAS check: the file must still hold exactly the bytes we read.
fn unchanged_since(path: &Path, expected: &Option<Vec<u8>>) -> Result<(), String> {
    let now = match std::fs::read(path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{} could not be re-read before writing: {}", path.display(), e)),
    };
    if &now == expected {
        Ok(())
    } else {
        Err(CHANGED_UNDERNEATH.to_string())
    }
}

const CHANGED_UNDERNEATH: &str = "config.json changed while it was being written";

/// Commit `next` over the snapshot. Keeps the old file first when binding
/// material changes, or when the old file is damaged (the caller decides
/// whether damage may be replaced at all).
fn commit(
    path: &Path,
    snap_bytes: &Option<Vec<u8>>,
    keep_old: bool,
    next: &Map<String, Value>,
) -> Result<Option<PathBuf>, String> {
    let dir = path
        .parent()
        .ok_or_else(|| "config path has no parent".to_string())?;
    crate::durable_file::mkdir_owner_only(dir)?;
    // A byte copy, not a link: if the replacement below is refused (the
    // compare-and-swap lost a race) the live name survives, and an older
    // in-place writer would otherwise rewrite the "kept" bytes through a link.
    let preserved = if keep_old && snap_bytes.is_some() {
        Some(preserve_aside(path, "clobbered", Keep::CopyBytes)?)
    } else {
        None
    };
    let json = serde_json::to_string_pretty(&Value::Object(next.clone())).map_err(|e| e.to_string())?;
    let target = crate::durable_file::resolve_write_target(path)?;
    let check = || unchanged_since(&target, snap_bytes);
    write_file_atomic_owner_only(path, json.as_bytes(), Some(&check))?;
    Ok(preserved)
}

/// Full-document write (the legacy `write_config` IPC). Rules as above; a
/// damaged file is kept aside and replaced (the caller could not have merged
/// into it). Returns the backup path when one was made.
pub fn write_config_at(path: &Path, json: &str) -> Result<Option<PathBuf>, String> {
    let next = match serde_json::from_str::<Value>(json) {
        Ok(Value::Object(o)) => o,
        Ok(_) => return Err("Invalid config: not a JSON object".to_string()),
        Err(e) => return Err(format!("Invalid JSON: {}", e)),
    };
    match snapshot(path) {
        Ok(snap) => {
            refuse_dropped_identity_fields(&snap.object, &next)?;
            refuse_changed_cli_fields(&snap.object, &next)?;
            let keep = binding_changes(&snap.object, &next);
            commit(path, &snap.bytes, keep, &next)
        }
        Err(damage) => {
            if next.keys().any(|k| is_cli_owned(k)) {
                return Err(format!("{} Refusing to write cli_* fields over it.", damage));
            }
            // Damage: keep the old bytes, then replace. `snap_bytes` for the
            // CAS is whatever is there now.
            let bytes = std::fs::read(path).ok();
            let preserved = preserve_aside(path, "clobbered", Keep::LinkThenReplace)?;
            let json = serde_json::to_string_pretty(&Value::Object(next)).map_err(|e| e.to_string())?;
            let target = crate::durable_file::resolve_write_target(path)?;
            let check = || unchanged_since(&target, &bytes);
            write_file_atomic_owner_only(path, json.as_bytes(), Some(&check))?;
            Ok(Some(preserved))
        }
    }
}

/// The outcome of a field-level update.
#[derive(Debug, PartialEq, Eq)]
pub enum Updated {
    Unchanged,
    Written { preserved: Option<PathBuf> },
}

/// Field-level merge: every key in `patch` is set (a JSON `null` removes
/// it); every other key on disk is carried through as it is at commit time.
/// `expect` is a compare-and-swap guard: each key must currently hold that
/// value (`null` ⇒ absent), or nothing is written. A damaged file is never
/// merged into: `Err`, untouched. `between` is a test seam run after each
/// read, before the commit.
pub fn update_config_at(
    path: &Path,
    patch_json: &str,
    expect_json: Option<&str>,
) -> Result<Updated, String> {
    update_config_at_with(path, patch_json, expect_json, &|_| {})
}

pub fn update_config_at_with(
    path: &Path,
    patch_json: &str,
    expect_json: Option<&str>,
    between: &dyn Fn(u32),
) -> Result<Updated, String> {
    let patch = match serde_json::from_str::<Value>(patch_json) {
        Ok(Value::Object(o)) => o,
        Ok(_) => return Err("Invalid config patch: not a JSON object".to_string()),
        Err(e) => return Err(format!("Invalid config patch: {}", e)),
    };
    if let Some(k) = patch.keys().find(|k| is_cli_owned(k)) {
        return Err(format!(
            "Refusing to update config: {} is owned by the motebit CLI; the desktop never writes it. Nothing was changed.",
            k
        ));
    }
    let expect = match expect_json {
        None => Map::new(),
        Some(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Object(o)) => o,
            _ => return Err("Invalid config expectation: not a JSON object".to_string()),
        },
    };
    for attempt in 0..8u32 {
        let snap = snapshot(path)?;
        for (k, want) in &expect {
            let have = snap.object.get(k).unwrap_or(&Value::Null);
            if have != want {
                return Err(format!(
                    "Refusing to update config: {} changed since it was read (another writer — the CLI? — got there first). Nothing was changed.",
                    k
                ));
            }
        }
        let mut next = snap.object.clone();
        for (k, v) in &patch {
            if v.is_null() {
                next.remove(k);
            } else {
                next.insert(k.clone(), v.clone());
            }
        }
        if next == snap.object {
            return Ok(Updated::Unchanged);
        }
        refuse_dropped_identity_fields(&snap.object, &next)?;
        let keep = binding_changes(&snap.object, &next);
        between(attempt);
        match commit(path, &snap.bytes, keep, &next) {
            Ok(preserved) => return Ok(Updated::Written { preserved }),
            Err(e) if e == CHANGED_UNDERNEATH => {
                // A backup made for this attempt stays (it is the old bytes);
                // merge again onto what is there now.
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    Err("config.json kept changing while the desktop tried to update it; nothing was changed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "motebit-config-{}-{}-{}",
            tag,
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    fn read_obj(path: &Path) -> Map<String, Value> {
        match serde_json::from_str::<Value>(&std::fs::read_to_string(path).unwrap()).unwrap() {
            Value::Object(o) => o,
            _ => panic!("not an object"),
        }
    }

    #[test]
    fn absence_reads_as_none_damage_as_err() {
        let dir = scratch("read");
        let path = dir.join("config.json");
        assert_eq!(read_config_at(&path).unwrap(), None);
        for body in ["{ \"motebit_id\": ", "null", "[]", "3"] {
            std::fs::write(&path, body).unwrap();
            assert!(read_config_at(&path).is_err(), "{body} must read as damage");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_damaged_0644_config_is_narrowed_before_the_error() {
        // #759 finding (b), desktop leg: narrowing ran only on a good parse.
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("narrow-damaged");
        let path = dir.join("config.json");
        std::fs::write(&path, "{ \"cli_encrypted_key\": {\"ciphertext\": \"ab").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_config_at(&path).is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlinked_config_is_damage_and_is_never_replaced() {
        let dir = scratch("dangling");
        let link = dir.join("config.json");
        std::os::unix::fs::symlink(dir.join("gone/config.json"), &link).unwrap();
        assert!(read_config_at(&link).is_err());
        assert!(update_config_at(&link, "{\"theme\":\"dark\"}", None).is_err());
        assert!(write_config_at(&link, "{\"theme\":\"dark\"}").is_err());
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn damage_is_preserved_before_a_full_write_replaces_it() {
        let dir = scratch("preserve");
        let path = dir.join("config.json");
        let damaged = "{ \"cli_encrypted_key\": { \"ciphertext\": \"ab";
        std::fs::write(&path, damaged).unwrap();
        let backup = write_config_at(&path, "{\"motebit_id\":\"m-2\"}")
            .unwrap()
            .expect("damage must be preserved");
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("config.json.clobbered-"));
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), damaged);
        assert_eq!(read_obj(&path).get("motebit_id").unwrap(), "m-2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_update_never_merges_into_damage() {
        let dir = scratch("update-damage");
        let path = dir.join("config.json");
        std::fs::write(&path, "{ torn").unwrap();
        assert!(update_config_at(&path, "{\"theme\":\"dark\"}", None).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ torn");
        assert_eq!(entries(&dir), vec!["config.json".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_healthy_non_binding_update_makes_no_backup() {
        let dir = scratch("healthy");
        let path = dir.join("config.json");
        std::fs::write(&path, "{\"motebit_id\":\"m-1\",\"theme\":\"light\"}").unwrap();
        assert_eq!(
            update_config_at(&path, "{\"theme\":\"dark\"}", None).unwrap(),
            Updated::Written { preserved: None }
        );
        assert_eq!(entries(&dir), vec!["config.json".to_string()]);
        let o = read_obj(&path);
        assert_eq!(o.get("theme").unwrap(), "dark");
        assert_eq!(o.get("motebit_id").unwrap(), "m-1");
        // null removes; an identical patch writes nothing.
        update_config_at(&path, "{\"theme\":null}", None).unwrap();
        assert!(!read_obj(&path).contains_key("theme"));
        assert_eq!(update_config_at(&path, "{\"theme\":null}", None).unwrap(), Updated::Unchanged);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_desktop_never_writes_a_cli_field() {
        let dir = scratch("cli");
        let path = dir.join("config.json");
        let existing = "{\"motebit_id\":\"m-1\",\"cli_encrypted_key\":{\"ciphertext\":\"KEY-B\"}}";
        std::fs::write(&path, existing).unwrap();
        // update_config: a cli_* key in the patch is refused outright.
        let err = update_config_at(&path, "{\"cli_encrypted_key\":{\"ciphertext\":\"KEY-A\"}}", None).unwrap_err();
        assert!(err.contains("cli_encrypted_key"), "{err}");
        // write_config: a stale snapshot that CHANGES the CLI's key is refused.
        let err = write_config_at(&path, "{\"motebit_id\":\"m-1\",\"cli_encrypted_key\":{\"ciphertext\":\"KEY-A\"},\"theme\":\"x\"}").unwrap_err();
        assert!(err.contains("cli_encrypted_key"), "{err}");
        // …and so is ADDING one.
        let err = write_config_at(&path, "{\"motebit_id\":\"m-1\",\"cli_encrypted_key\":{\"ciphertext\":\"KEY-B\"},\"cli_private_key\":\"p\"}").unwrap_err();
        assert!(err.contains("cli_private_key"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), existing);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_write_that_would_drop_the_cli_key_or_identity() {
        let dir = scratch("drop");
        let path = dir.join("config.json");
        let existing = "{\"motebit_id\":\"m-1\",\"device_id\":\"d-1\",\"cli_encrypted_key\":{\"ciphertext\":\"c\"},\"theme\":\"dark\"}";
        std::fs::write(&path, existing).unwrap();
        let err = write_config_at(&path, "{\"default_provider\":\"anthropic\"}").unwrap_err();
        assert!(err.contains("cli_encrypted_key"), "{err}");
        assert!(err.contains("motebit_id"), "{err}");
        let err = update_config_at(&path, "{\"motebit_id\":null}", None).unwrap_err();
        assert!(err.contains("motebit_id"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), existing);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_binding_change_keeps_the_old_file() {
        // Restore / pairing / divergence-mint / rotation replace binding
        // material: the previous identity's binding is kept, not destroyed.
        let dir = scratch("binding");
        let path = dir.join("config.json");
        let old = "{\"motebit_id\":\"m-A\",\"device_public_key\":\"aa\",\"_identity_file\":\"---A---\"}";
        std::fs::write(&path, old).unwrap();
        let out = update_config_at(
            &path,
            "{\"motebit_id\":\"m-B\",\"device_public_key\":\"bb\",\"_identity_file\":null}",
            None,
        )
        .unwrap();
        let Updated::Written { preserved: Some(backup) } = out else {
            panic!("binding change must preserve: {out:?}")
        };
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), old);
        assert_eq!(read_obj(&path).get("motebit_id").unwrap(), "m-B");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expect_is_a_compare_and_swap() {
        let dir = scratch("expect");
        let path = dir.join("config.json");
        std::fs::write(&path, "{\"motebit_id\":\"m-1\",\"device_public_key\":\"NEW\"}").unwrap();
        let err = update_config_at(
            &path,
            "{\"device_public_key\":\"OTHER\"}",
            Some("{\"device_public_key\":\"OLD\"}"),
        )
        .unwrap_err();
        assert!(err.contains("device_public_key"), "{err}");
        assert_eq!(read_obj(&path).get("device_public_key").unwrap(), "NEW");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cli_rotation_landing_mid_update_survives() {
        // X2: the desktop read the config (key A), the CLI committed key B,
        // then the desktop wrote its theme. The write must not revert B.
        let dir = scratch("lost-update");
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            "{\"motebit_id\":\"m-1\",\"cli_encrypted_key\":{\"ciphertext\":\"KEY-A\"}}",
        )
        .unwrap();
        let p2 = path.clone();
        let cli_rotates = move |attempt: u32| {
            if attempt == 0 {
                std::fs::write(
                    &p2,
                    "{\"motebit_id\":\"m-1\",\"cli_encrypted_key\":{\"ciphertext\":\"KEY-B\"}}",
                )
                .unwrap();
            }
        };
        update_config_at_with(&path, "{\"theme\":\"dark\"}", None, &cli_rotates).unwrap();
        let o = read_obj(&path);
        assert_eq!(o["cli_encrypted_key"]["ciphertext"], "KEY-B");
        assert_eq!(o["theme"], "dark");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_damaged_symlinked_config_is_preserved_as_its_old_bytes() {
        let dir = scratch("symlink-damage");
        let real_dir = scratch("symlink-damage-real");
        let real = real_dir.join("real-config.json");
        let link = dir.join("config.json");
        std::fs::write(&real, "{OLD damaged").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let backup = write_config_at(&link, "{\"motebit_id\":\"m-new\"}")
            .unwrap()
            .expect("damage must be preserved");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "{OLD damaged");
        assert!(!std::fs::symlink_metadata(&backup).unwrap().file_type().is_symlink());
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(read_obj(&real).get("motebit_id").unwrap(), "m-new");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&real_dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_config_is_written_through_the_link_not_over_it() {
        let dir = scratch("symlink");
        let real = dir.join("real-config.json");
        let link = dir.join("config.json");
        std::fs::write(&real, "{\"motebit_id\":\"m-1\"}").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        update_config_at(&link, "{\"theme\":\"dark\"}", None).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(read_obj(&real).get("theme").unwrap(), "dark");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_persist_a_non_object() {
        let dir = scratch("nonobject");
        let path = dir.join("config.json");
        assert!(write_config_at(&path, "[]").is_err());
        assert!(write_config_at(&path, "{").is_err());
        assert!(update_config_at(&path, "[]", None).is_err());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_including_a_pre_existing_0644_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("mode");
        let path = dir.join("config.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        read_config_at(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        // write_config reads (and narrows) first; the replacement is 0600.
        write_config_at(&path, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
