#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::Connection;
use std::sync::Mutex;
use tauri::State;

struct AppState {
    db: Mutex<Connection>,
}

#[tauri::command]
fn db_query(state: State<AppState>, sql: String) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let results: Vec<String> = rows.filter_map(|r| r.ok()).collect();
    serde_json::to_string(&results).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_execute(state: State<AppState>, sql: String) -> Result<usize, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(&sql, []).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_config() -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let path = std::path::Path::new(&home).join(".motebit").join("config.json");
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("Failed to read config: {}", e)),
    }
}

#[tauri::command]
fn write_config(json: String) -> Result<(), String> {
    // Validate JSON
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Cannot determine home directory".to_string())?;
    let dir = std::path::Path::new(&home).join(".motebit");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    let path = dir.join("config.json");
    std::fs::write(&path, &json)
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

const KEYRING_SERVICE: &str = "com.motebit.desktop";

#[tauri::command]
fn keyring_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(val) => Ok(Some(val)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keyring_set(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn keyring_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &key)
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // idempotent
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    let db = Connection::open("motebit.db").expect("Failed to open database");

    // Enable WAL mode for better concurrent access
    db.execute_batch("PRAGMA journal_mode=WAL;")
        .expect("Failed to set WAL mode");

    tauri::Builder::default()
        .manage(AppState {
            db: Mutex::new(db),
        })
        .invoke_handler(tauri::generate_handler![
            db_query,
            db_execute,
            read_config,
            write_config,
            keyring_get,
            keyring_set,
            keyring_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
