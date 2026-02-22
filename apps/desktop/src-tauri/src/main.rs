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

CREATE TABLE IF NOT EXISTS identities (
  motebit_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  version_clock INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  device_token TEXT NOT NULL,
  public_key TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  device_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_mote ON devices (motebit_id);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_mote ON audit_log (motebit_id);

CREATE TABLE IF NOT EXISTS state_snapshots (
  motebit_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version_clock INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  title TEXT,
  summary TEXT,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_motebit ON conversations (motebit_id, last_active_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  motebit_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conv_messages ON conversation_messages (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS goals (
  goal_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  interval_ms INTEGER NOT NULL,
  last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'recurring',
  status TEXT NOT NULL DEFAULT 'active',
  parent_goal_id TEXT,
  max_retries INTEGER NOT NULL DEFAULT 3,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_goals_motebit ON goals (motebit_id);

CREATE TABLE IF NOT EXISTS goal_outcomes (
  outcome_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  motebit_id TEXT NOT NULL,
  ran_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  tool_calls_made INTEGER NOT NULL DEFAULT 0,
  memories_formed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_goal_outcomes_goal ON goal_outcomes (goal_id, ran_at DESC);

CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  motebit_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  current_step_index INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plans_goal ON plans (goal_id);

CREATE TABLE IF NOT EXISTS plan_steps (
  step_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  optional INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  result_summary TEXT,
  error_message TEXT,
  tool_calls_made INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  completed_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps (plan_id, ordinal ASC);
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

// === Privileged Tool Commands ===

#[tauri::command]
fn read_file_tool(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("File not found: {}", path),
        std::io::ErrorKind::PermissionDenied => format!("Permission denied: {}", path),
        _ => format!("Read error: {}", e),
    })
}

#[tauri::command]
fn write_file_tool(path: String, content: String) -> Result<String, String> {
    // Create parent directories if needed
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    std::fs::write(&path, &content)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => format!("Permission denied: {}", path),
            _ => format!("Write error: {}", e),
        })?;
    Ok(format!("Written {} bytes to {}", content.len(), path))
}

#[derive(serde::Serialize)]
struct ShellExecResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[tauri::command]
fn shell_exec_tool(command: String, cwd: Option<String>) -> Result<ShellExecResult, String> {
    use std::process::Command;

    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(&command);

    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }

    // Spawn and wait with timeout
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    // Capture PID before moving child into the wait thread
    let child_pid = child.id();

    // Wait with a 30s timeout using a separate thread
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        let output = child.wait_with_output();
        let _ = tx.send(output);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(result) => {
            let _ = handle.join();
            let output = result.map_err(|e| format!("Process error: {}", e))?;
            Ok(ShellExecResult {
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                exit_code: output.status.code().unwrap_or(-1),
            })
        }
        Err(_) => {
            // Timeout — kill the child process tree to prevent orphans
            // Use SIGKILL via kill command (avoids libc dep)
            let _ = Command::new("kill").args(["-9", &child_pid.to_string()]).output();
            let _ = handle.join();
            Err("Command timed out after 30 seconds".to_string())
        }
    }
}

#[tauri::command]
fn transcribe_audio(audio_base64: String, api_key: Option<String>) -> Result<String, String> {
    use base64::Engine;
    use std::process::Command;

    // Decode base64 → temp file
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&audio_base64)
        .map_err(|e| format!("Failed to decode audio: {}", e))?;

    let temp_path = format!("/tmp/motebit_voice_{}.webm", std::process::id());
    std::fs::write(&temp_path, &audio_bytes)
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    let cleanup = |extra: &str| {
        let _ = std::fs::remove_file(&temp_path);
        if !extra.is_empty() {
            let _ = std::fs::remove_file(extra);
        }
    };

    // Try local whisper binary (Python openai-whisper)
    if let Ok(which_out) = Command::new("which").arg("whisper").output() {
        if which_out.status.success() {
            if let Ok(output) = Command::new("whisper")
                .args([
                    &temp_path,
                    "--output_format",
                    "txt",
                    "--language",
                    "en",
                    "--output_dir",
                    "/tmp",
                ])
                .output()
            {
                if output.status.success() {
                    // whisper outputs <basename>.txt in the output dir
                    let txt_path = format!(
                        "/tmp/motebit_voice_{}.txt",
                        std::process::id()
                    );
                    if let Ok(text) = std::fs::read_to_string(&txt_path) {
                        let trimmed = text.trim().to_string();
                        cleanup(&txt_path);
                        if !trimmed.is_empty() {
                            return Ok(trimmed);
                        }
                    } else {
                        cleanup("");
                    }
                }
            }
        }
    }

    // Fall back to OpenAI Whisper API
    if let Some(ref key) = api_key {
        let output = Command::new("curl")
            .args([
                "-s",
                "-X",
                "POST",
                "https://api.openai.com/v1/audio/transcriptions",
                "-H",
                &format!("Authorization: Bearer {}", key),
                "-F",
                &format!("file=@{}", temp_path),
                "-F",
                "model=whisper-1",
                "-F",
                "response_format=text",
            ])
            .output()
            .map_err(|e| {
                cleanup("");
                format!("Failed to call Whisper API: {}", e)
            })?;

        cleanup("");

        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() {
                return Ok(text);
            }
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() {
            return Err(format!("Whisper API error: {}", stderr));
        }
        return Err("Whisper API returned empty response".to_string());
    }

    cleanup("");
    Err("No transcription available. Grant macOS Speech Recognition permission (System Settings > Privacy & Security > Speech Recognition), install whisper locally (pip install openai-whisper), or add an OpenAI API key in Voice settings.".to_string())
}

// === Goal Commands (narrow IPC — no raw SQL from the webview) ===

#[tauri::command]
fn goals_list(state: State<AppState>, motebit_id: String) -> Result<Vec<JsonValue>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT goal_id, prompt, interval_ms, mode, status, consecutive_failures, created_at \
             FROM goals WHERE motebit_id = ? ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([&motebit_id], |row| {
            let mut obj = serde_json::Map::new();
            obj.insert("goal_id".into(), JsonValue::String(row.get::<_, String>(0)?));
            obj.insert("prompt".into(), JsonValue::String(row.get::<_, String>(1)?));
            obj.insert("interval_ms".into(), JsonValue::Number(row.get::<_, i64>(2)?.into()));
            obj.insert("mode".into(), JsonValue::String(row.get::<_, String>(3)?));
            obj.insert("status".into(), JsonValue::String(row.get::<_, String>(4)?));
            obj.insert(
                "consecutive_failures".into(),
                JsonValue::Number(row.get::<_, i64>(5)?.into()),
            );
            obj.insert("created_at".into(), JsonValue::Number(row.get::<_, i64>(6)?.into()));
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
fn goals_create(
    state: State<AppState>,
    motebit_id: String,
    goal_id: String,
    prompt: String,
    interval_ms: i64,
    mode: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    db.execute(
        "INSERT INTO goals (goal_id, motebit_id, prompt, interval_ms, mode, status, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)",
        rusqlite::params![goal_id, motebit_id, prompt, interval_ms, mode, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn goals_toggle(state: State<AppState>, goal_id: String) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let current: String = db
        .query_row("SELECT status FROM goals WHERE goal_id = ?1", [&goal_id], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let new_status = if current == "active" { "paused" } else { "active" };
    db.execute(
        "UPDATE goals SET status = ?1 WHERE goal_id = ?2",
        rusqlite::params![new_status, goal_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(new_status.to_string())
}

#[tauri::command]
fn goals_delete(state: State<AppState>, goal_id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM plan_steps WHERE plan_id IN (SELECT plan_id FROM plans WHERE goal_id = ?1)", [&goal_id])
        .map_err(|e| e.to_string())?;
    db.execute("DELETE FROM plans WHERE goal_id = ?1", [&goal_id])
        .map_err(|e| e.to_string())?;
    db.execute("DELETE FROM goal_outcomes WHERE goal_id = ?1", [&goal_id])
        .map_err(|e| e.to_string())?;
    db.execute("DELETE FROM goals WHERE goal_id = ?1", [&goal_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn goals_outcomes(
    state: State<AppState>,
    goal_id: String,
    limit: Option<i64>,
) -> Result<Vec<JsonValue>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let max = limit.unwrap_or(5);
    let mut stmt = db
        .prepare(
            "SELECT outcome_id, ran_at, status, summary, error_message \
             FROM goal_outcomes WHERE goal_id = ? ORDER BY ran_at DESC LIMIT ?",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![goal_id, max], |row| {
            let mut obj = serde_json::Map::new();
            obj.insert("outcome_id".into(), JsonValue::String(row.get::<_, String>(0)?));
            obj.insert("ran_at".into(), JsonValue::Number(row.get::<_, i64>(1)?.into()));
            obj.insert("status".into(), JsonValue::String(row.get::<_, String>(2)?));
            let summary: Option<String> = row.get(3)?;
            obj.insert("summary".into(), summary.map_or(JsonValue::Null, JsonValue::String));
            let error: Option<String> = row.get(4)?;
            obj.insert("error_message".into(), error.map_or(JsonValue::Null, JsonValue::String));
            Ok(JsonValue::Object(obj))
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

// === TTS Command (OpenAI API key stays in keyring, never in webview) ===

#[tauri::command]
async fn tts_openai_speech(
    text: String,
    voice: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    use base64::Engine;

    // Read API key from keyring
    let entry = keyring::Entry::new(KEYRING_SERVICE, "whisper_api_key")
        .map_err(|e| e.to_string())?;
    let api_key = match entry.get_password() {
        Ok(val) => val,
        Err(keyring::Error::NoEntry) => {
            return Err("No OpenAI API key configured".to_string());
        }
        Err(e) => return Err(e.to_string()),
    };

    let voice_name = voice.unwrap_or_else(|| "alloy".to_string());
    let model_name = model.unwrap_or_else(|| "tts-1".to_string());

    // Split long text at sentence boundaries (4096 char limit per request)
    let chunks = split_tts_text(&text, 4096);
    let mut all_bytes: Vec<u8> = Vec::new();

    let client = reqwest::Client::new();
    for chunk in &chunks {
        let body = serde_json::json!({
            "model": model_name,
            "input": chunk,
            "voice": voice_name,
            "response_format": "mp3"
        });

        let resp = client
            .post("https://api.openai.com/v1/audio/speech")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("TTS request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!("OpenAI TTS error ({}): {}", status, body_text));
        }

        let bytes = resp.bytes().await.map_err(|e| format!("Failed to read TTS response: {}", e))?;
        all_bytes.extend_from_slice(&bytes);
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(&all_bytes))
}

/// Split text at sentence boundaries for TTS chunking.
fn split_tts_text(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }
        // Find last sentence boundary within max_len
        let search = &remaining[..max_len];
        let split_at = search
            .rfind(". ")
            .or_else(|| search.rfind("! "))
            .or_else(|| search.rfind("? "))
            .map(|i| i + 2)
            .unwrap_or(max_len);
        chunks.push(remaining[..split_at].to_string());
        remaining = &remaining[split_at..];
    }
    chunks
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
            read_file_tool,
            write_file_tool,
            shell_exec_tool,
            transcribe_audio,
            goals_list,
            goals_create,
            goals_toggle,
            goals_delete,
            goals_outcomes,
            tts_openai_speech,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
