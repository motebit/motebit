//! Composition proof, Rust half (#760 review F4): replay the exact IPC
//! sequence the TypeScript `restoreIdentity` issues (pinned by
//! `src/__tests__/identity-switch-ipc.test.ts` into
//! `fixtures/identity-switch-restore.json`) through the REAL `KeyStore` and
//! `config_file` — the same functions the Tauri commands call — and prove
//! that a restore of B over A keeps A's key, A's in-flight rotation, and A's
//! binding.

use crate::config_file;
use crate::key_store::tests::FakeKeychain;
use crate::key_store::{KeyStore, NoKeychain, SecretStore};
use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/identity-switch-restore.json");

fn dispatch<S: SecretStore>(store: &KeyStore<S>, config: &std::path::Path, cmd: &str, args: &Value) {
    let s = |k: &str| args[k].as_str().unwrap().to_string();
    let r: Result<(), String> = match cmd {
        "keyring_set" => store.set(&s("key"), &s("value")),
        "keyring_set_aside" => store.set_aside(&s("key")),
        "keyring_delete" => store.delete(&s("key")),
        "keyring_get" => store.get(&s("key")).map(|_| ()),
        "update_config" => config_file::update_config_at(config, &s("patch"), args["expect"].as_str()).map(|_| ()),
        "write_config" => config_file::write_config_at(config, &s("json")).map(|_| ()),
        other => panic!("fixture has an IPC the replay does not know: {other}"),
    };
    r.unwrap_or_else(|e| panic!("{cmd} {args}: {e}"));
}

#[test]
fn restore_ipc_sequence_preserves_the_old_key_rotation_and_binding_in_the_real_store() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("motebit-ipc-replay-{}-{}", std::process::id(), nonce));
    std::fs::create_dir_all(&dir).unwrap();
    let config = dir.join("config.json");
    let a_config = "{\"motebit_id\":\"m-A\",\"device_id\":\"d-A\",\"device_public_key\":\"aa\",\"_identity_file\":\"A-FILE\"}";
    std::fs::write(&config, a_config).unwrap();

    // Identity A on this machine: key and an in-flight rotation, in the keychain.
    let kc = FakeKeychain::default();
    kc.entries.borrow_mut().insert("device_private_key".into(), "KEY-A".into());
    kc.entries.borrow_mut().insert("pending_rotation".into(), "HELD-A-PRIME".into());
    let store = KeyStore::new(&kc, dir.clone());

    let steps: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    assert!(!steps.is_empty());
    for step in &steps {
        dispatch(&store, &config, step["cmd"].as_str().unwrap(), &step["args"]);
    }

    let entries = kc.entries.borrow();
    assert_eq!(entries.get("device_private_key").map(String::as_str), Some("KEY-B"));
    assert!(entries.get("pending_rotation").is_none(), "A's write-ahead left active");
    assert!(entries.get("pending_identity_switch").is_none(), "switch write-ahead left active");
    let kept: Vec<&String> = entries
        .iter()
        .filter(|(k, _)| k.contains(".preserved-"))
        .map(|(_, v)| v)
        .collect();
    assert!(kept.iter().any(|v| *v == "KEY-A"), "A's key destroyed: {kept:?}");
    assert!(kept.iter().any(|v| *v == "HELD-A-PRIME"), "A's rotation destroyed: {kept:?}");

    let now: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
    assert_eq!(now["motebit_id"], "m-B");
    let backups: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("config.json.clobbered-"))
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert_eq!(std::fs::read_to_string(dir.join(&backups[0])).unwrap(), a_config);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The same replay on the store the app actually ships: file-only
/// (`KeyStore::file_only`, what `default_for_app` builds). A restore of B
/// over A keeps A's key and A's in-flight rotation in dev-keyring.json and
/// A's binding as a config backup; no keychain artifact appears.
#[test]
fn restore_ipc_sequence_on_the_file_only_app_store_keeps_everything_of_a() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("motebit-ipc-replay-file-{}-{}", std::process::id(), nonce));
    std::fs::create_dir_all(&dir).unwrap();
    let config = dir.join("config.json");
    let a_config = "{\"motebit_id\":\"m-A\",\"device_id\":\"d-A\",\"device_public_key\":\"aa\",\"_identity_file\":\"A-FILE\"}";
    std::fs::write(&config, a_config).unwrap();
    std::fs::write(
        dir.join("dev-keyring.json"),
        "{\"device_private_key\":\"KEY-A\",\"pending_rotation\":\"HELD-A-PRIME\"}",
    )
    .unwrap();
    let store: KeyStore<NoKeychain> = KeyStore::file_only(dir.clone());

    let steps: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    for step in &steps {
        dispatch(&store, &config, step["cmd"].as_str().unwrap(), &step["args"]);
    }

    let file: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("dev-keyring.json")).unwrap()).unwrap();
    let file = file.as_object().unwrap();
    assert_eq!(file.get("device_private_key").and_then(Value::as_str), Some("KEY-B"));
    assert!(file.get("pending_rotation").is_none(), "A's write-ahead left active");
    assert!(file.get("pending_identity_switch").is_none(), "switch write-ahead left active");
    let kept: Vec<&str> = file
        .iter()
        .filter(|(k, _)| k.contains(".preserved-"))
        .filter_map(|(_, v)| v.as_str())
        .collect();
    assert!(kept.contains(&"KEY-A"), "A's key destroyed: {kept:?}");
    assert!(kept.contains(&"HELD-A-PRIME"), "A's rotation destroyed: {kept:?}");
    assert!(!dir.join("keychain-index.json").exists());

    let now: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
    assert_eq!(now["motebit_id"], "m-B");
    let backups: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("config.json.clobbered-"))
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert_eq!(std::fs::read_to_string(dir.join(&backups[0])).unwrap(), a_config);
    let _ = std::fs::remove_dir_all(&dir);
}

fn scratch_dir(tag: &str) -> std::path::PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("motebit-{}-{}-{}", tag, std::process::id(), nonce));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The STORE half of #765's trigger: a `~/.motebit` whose only keyring file
/// is the CLI's retired plaintext keyring, `dev-keyring.json.migrated-<t>`
/// = {"device_private_key": …}. The file-only store never refuses on
/// keychain grounds: the probe reads the key as absent, and the restore IPC
/// sequence (applyIdentitySwitch) completes.
///
/// Not the whole user-visible outcome: a real `migrate-keyring` also writes
/// `cli_encrypted_key` into config.json, so the desktop's TS bootstrap then
/// stops at `cliIdentityRefusal` (intended — main silently re-minted over
/// the CLI's key). That half is `identity-after-migrate-keyring.test.ts`.
#[test]
fn after_cli_migrate_keyring_the_file_only_store_bootstraps_and_restores() {
    let dir = scratch_dir("after-migrate-keyring");
    std::fs::write(dir.join("dev-keyring.json.migrated-T"), "{\"device_private_key\":\"aa\"}").unwrap();
    let config = dir.join("config.json");
    std::fs::write(&config, "{\"motebit_id\":\"m-A\",\"device_id\":\"d-A\",\"device_public_key\":\"aa-pub\"}").unwrap();
    let store: KeyStore<NoKeychain> = KeyStore::file_only(dir.clone());

    // Bootstrap's hasPrivateKey probe: a TRUE absence, never an error.
    assert_eq!(store.get("device_private_key").unwrap(), None);

    // Restore: every step of the pinned IPC sequence succeeds.
    let steps: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
    for step in &steps {
        dispatch(&store, &config, step["cmd"].as_str().unwrap(), &step["args"]);
    }
    assert_eq!(store.get("device_private_key").unwrap().as_deref(), Some("KEY-B"));
    assert_eq!(store.get("pending_identity_switch").unwrap(), None, "no write-ahead left behind");
    let now: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
    assert_eq!(now["motebit_id"], "m-B");
    // The CLI's copy is left exactly as it was.
    assert_eq!(
        std::fs::read_to_string(dir.join("dev-keyring.json.migrated-T")).unwrap(),
        "{\"device_private_key\":\"aa\"}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Item 16 at the call main() makes: a new `~/.motebit` is 0700.
#[cfg(unix)]
#[test]
fn startup_creates_the_motebit_dir_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch_dir("startup-dir");
    let dir = root.join("home").join(".motebit");
    crate::prepare_motebit_dir(&dir).unwrap();
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    let _ = std::fs::remove_dir_all(&root);
}
