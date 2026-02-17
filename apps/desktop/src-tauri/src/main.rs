#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde_json::Value as JsonValue;
use std::sync::Mutex;
use tauri::State;

struct AppState {
    db: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  version_clock INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_mote_clock ON events (motebit_id, version_clock);

CREATE TABLE IF NOT EXISTS memory_nodes (
  node_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding TEXT NOT NULL,
  confidence REAL NOT NULL,
  sensitivity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  half_life REAL NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote ON memory_nodes (motebit_id);

CREATE TABLE IF NOT EXISTS memory_edges (
  edge_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  weight REAL NOT NULL,
  confidence REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges (source_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges (target_id);

CREATE TABLE IF NOT EXISTS tool_audit_log (
  call_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  decision TEXT NOT NULL,
  result TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_audit_turn ON tool_audit_log (turn_id);
";

fn json_to_sql_value(v: &JsonValue) -> SqlValue {
    match v {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        JsonValue::String(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Text(v.to_string()),
    }
}

#[tauri::command]
fn db_query(
    state: State<AppState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<Vec<JsonValue>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let sql_params: Vec<SqlValue> = params.iter().map(json_to_sql_value).collect();
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;

    let column_count = stmt.column_count();
    let column_names: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
        .collect();

    let rows = stmt
        .query_map(params_from_iter(sql_params), |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in column_names.iter().enumerate() {
                let val: SqlValue = row.get(i)?;
                let json_val = match val {
                    SqlValue::Null => JsonValue::Null,
                    SqlValue::Integer(n) => JsonValue::Number(n.into()),
                    SqlValue::Real(f) => {
                        JsonValue::Number(serde_json::Number::from_f64(f).unwrap_or(0.into()))
                    }
                    SqlValue::Text(s) => JsonValue::String(s),
                    SqlValue::Blob(b) => {
                        JsonValue::String(String::from_utf8_lossy(&b).into_owned())
                    }
                };
                obj.insert(name.clone(), json_val);
            }
            Ok(JsonValue::Object(obj))
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

#[tauri::command]
fn db_execute(
    state: State<AppState>,
    sql: String,
    params: Vec<JsonValue>,
) -> Result<usize, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let sql_params: Vec<SqlValue> = params.iter().map(json_to_sql_value).collect();
    db.execute(&sql, params_from_iter(sql_params))
        .map_err(|e| e.to_string())
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
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .expect("Cannot determine home directory");
    let dir = std::path::Path::new(&home).join(".motebit");
    std::fs::create_dir_all(&dir).expect("Failed to create ~/.motebit directory");
    let db_path = dir.join("motebit.db");

    let db = Connection::open(&db_path).expect("Failed to open database");

    // Enable WAL mode for better concurrent access
    db.execute_batch("PRAGMA journal_mode=WAL;")
        .expect("Failed to set WAL mode");

    // Initialize schema
    db.execute_batch(SCHEMA)
        .expect("Failed to initialize database schema");

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
