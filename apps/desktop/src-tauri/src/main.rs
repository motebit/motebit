#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod computer_use;
mod runtime_host;
mod secure_enclave;
mod skills;
mod tool_guard;
mod tpm;

use computer_use::{computer_execute, computer_query_display};
use secure_enclave::{se_available, se_mint_attestation};
use runtime_host::{
    runtime_host_bind, runtime_host_close, runtime_host_connect, runtime_host_meta,
    runtime_host_mkdir_exclusive, runtime_host_pid_alive, runtime_host_read_file,
    runtime_host_remove_dir, runtime_host_remove_file, runtime_host_send, runtime_host_unbind,
    runtime_host_write_file, RuntimeHostState,
};
use skills::{
    skills_disable, skills_enable, skills_install_directory, skills_list, skills_read_detail,
    skills_remove, skills_trust, skills_untrust, skills_verify, SkillsState,
};
use tpm::{tpm_available, tpm_mint_quote};
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

struct AppState {
    db: Mutex<Connection>,
}

const SCHEMA: &str = r#"
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
  tombstoned INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  memory_type TEXT DEFAULT 'semantic',
  valid_from INTEGER,
  valid_until INTEGER,
  -- MemorySource provenance (docs/doctrine/memory-provenance.md): who the
  -- forming code path attributed this memory to. NULL on pre-provenance
  -- rows; rowToNode maps through isMemorySource (never fabricates a tier).
  -- Desktop migration v7 adds these to existing installs.
  source TEXT,
  source_turn_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote ON memory_nodes (motebit_id);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_mote_tomb_pin ON memory_nodes (motebit_id, tombstoned, pinned);
CREATE INDEX IF NOT EXISTS idx_memory_nodes_retrieve ON memory_nodes (motebit_id, tombstoned, last_accessed DESC);

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
  cost_units INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL,
  -- Sensitivity tier classified at write time. NULL on pre-phase-5 rows;
  -- the consolidation-cycle flush phase lazy-classifies on read per
  -- docs/doctrine/retention-policy.md §"Decision 6b". Desktop migration
  -- v1 adds the column to existing installs.
  sensitivity TEXT
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
  token_estimate INTEGER NOT NULL DEFAULT 0,
  -- Sensitivity tier classified at write time. NULL on pre-phase-5 rows;
  -- the consolidation-cycle flush phase lazy-classifies on read per
  -- docs/doctrine/retention-policy.md §"Decision 6b". Desktop migration
  -- v1 adds the column to existing installs.
  sensitivity TEXT
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
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- v1 axis of the goal's bounded-commitment envelope per
  -- docs/doctrine/panel-temporal-registers.md §"Bounded commitment is
  -- multi-dimensional." Token cap; NULL = no cap. Future axes
  -- (voice_seconds, tool_calls, wall_clock_ms, ...) land as additive
  -- sibling columns; this one is not renamed. tauri-migrations v2 adds
  -- the column to pre-v2 installs.
  budget_tokens INTEGER
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
  error_message TEXT,
  -- Token usage for this run. Sums per goal feed the runtime register's
  -- spent_tokens for the budget envelope; NULL on legacy rows (treated
  -- as 0 by the rollup). tauri-migrations v2 adds the column.
  tokens_used INTEGER,
  -- Full artifact bytes for this fire — the `artifact` category per
  -- docs/doctrine/goal-results.md §"The three categories." Stored
  -- untruncated alongside the 500-char `summary` (which feeds the
  -- executions-panel preview and the panels controller's
  -- `last_response_preview`). NULL on failed fires (clear-on-error
  -- semantic) and on pre-v3 rows (treated identically to a failed
  -- fire's null). Phase-3 sibling commit wraps this as a signed
  -- `ContentArtifactManifest` (`@motebit/crypto::signContentArtifact`)
  -- at fire-time when motebit identity is loaded. tauri-migrations v3
  -- adds the column to existing installs.
  response_full TEXT,
  -- Signed `ContentArtifactManifest` JSON for the artifact bytes in
  -- `response_full`. Minted at fire-time by the desktop scheduler via
  -- `@motebit/runtime::signGoalArtifact(content, { goalId, runId })`
  -- (suite-dispatched through `@motebit/crypto`, currently
  -- `motebit-jcs-ed25519-hex-v1`). NULL when identity wasn't loaded
  -- at fire-time, when content was empty, or when the signer threw —
  -- never silently signed with a placeholder. The SQL projection in
  -- `list_goals_with_meta` derives `last_manifest_signed` as
  -- `(latest_outcome.signed_manifest IS NOT NULL)` so the panels
  -- runner's `ScheduledGoal.last_manifest_signed` field is populated
  -- on the same wire shape as web (Phase-3-deferral close per
  -- docs/doctrine/goal-results.md). tauri-migrations v4 adds the
  -- column to existing installs.
  signed_manifest TEXT
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

CREATE TABLE IF NOT EXISTS gradient_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  motebit_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  gradient REAL NOT NULL,
  delta REAL NOT NULL,
  knowledge_density REAL NOT NULL,
  knowledge_density_raw REAL NOT NULL,
  knowledge_quality REAL NOT NULL,
  graph_connectivity REAL NOT NULL,
  graph_connectivity_raw REAL NOT NULL,
  temporal_stability REAL NOT NULL,
  retrieval_quality REAL NOT NULL DEFAULT 0,
  interaction_efficiency REAL NOT NULL DEFAULT 0,
  tool_efficiency REAL NOT NULL DEFAULT 0,
  curiosity_pressure REAL NOT NULL DEFAULT 0,
  stats TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gradient_motebit_ts ON gradient_snapshots (motebit_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS agent_trust (
  motebit_id TEXT NOT NULL,
  remote_motebit_id TEXT NOT NULL,
  trust_level TEXT NOT NULL DEFAULT 'unknown',
  public_key TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  successful_tasks INTEGER NOT NULL DEFAULT 0,
  failed_tasks INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  PRIMARY KEY (motebit_id, remote_motebit_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_trust_motebit ON agent_trust (motebit_id);
"#;

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

// === ~/.motebit/config.json — shared with the CLI ===
//
// The CLI keeps `cli_encrypted_key` in this file — for a CLI identity the
// only copy of the private key — so the desktop obeys the CLI's three rules
// for it (`apps/cli/src/durable-file.ts` + `config.ts`, and create-motebit's
// `config-file.ts` twin):
//
//  1. Absence is not damage: NotFound reads as `{}`; anything else unreadable,
//     unparseable, or not a JSON object is an Err, file untouched.
//  2. Damage is never overwritten: a write over a damaged file first keeps
//     its bytes as `config.json.clobbered-<time>` (the one backup name every
//     reader looks for), or refuses.
//  3. A replacement is staged (created 0600 — never world-readable, not even
//     for an instant), fsync'd, renamed, and the directory fsync'd; the
//     scratch copy is removed on every failure path.

fn motebit_config_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "Cannot determine home directory".to_string())?;
    Ok(std::path::Path::new(&home).join(".motebit").join("config.json"))
}

/// Rule 1. `Ok(None)` is absence; `Err` is damage.
fn read_config_strict(path: &std::path::Path) -> Result<Option<String>, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "{} exists but could not be read ({}). It has NOT been changed.",
                path.display(),
                e
            ))
        }
    };
    match serde_json::from_str::<serde_json::Value>(&contents) {
        Ok(serde_json::Value::Object(_)) => Ok(Some(contents)),
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

/// Narrow a pre-existing world/group-readable config to 0600. Best effort:
/// a failed chmod never refuses a read.
fn tighten_to_owner_only(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.is_file() && meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// The backup timestamp, spelled exactly as the TypeScript writers spell it —
/// `new Date().toISOString()` with `:` and `.` replaced by `-`, e.g.
/// `2026-09-24T17-03-09-123Z` — so every writer's backups sort together.
fn backup_stamp(unix_millis: u128) -> String {
    let ms = (unix_millis % 1000) as u32;
    let secs = (unix_millis / 1000) as i64;
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (H. Hinnant), proleptic Gregorian, UTC.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}-{:03}Z",
        y,
        m,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        ms
    )
}

/// Rule 2. Keep `path`'s bytes as `<path>.clobbered-<time>` without reading
/// them (hard link; copy as fallback). Returns the backup path, or Err when
/// neither works — the caller must then refuse to write.
fn preserve_aside(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stamp = backup_stamp(millis);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config.json".to_string());
    let mut last_err = String::from("no backup name available");
    for n in 0..100u32 {
        let suffix = if n == 0 { String::new() } else { format!("-{}", n) };
        let backup = path.with_file_name(format!("{}.clobbered-{}{}", name, stamp, suffix));
        let made = match std::fs::hard_link(path, &backup) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                if backup.exists() {
                    continue;
                }
                std::fs::copy(path, &backup).map(|_| ())
            }
        };
        match made {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        &backup,
                        std::fs::Permissions::from_mode(0o600),
                    );
                }
                return Ok(backup);
            }
            Err(e) => {
                last_err = e.to_string();
                break;
            }
        }
    }
    Err(format!(
        "could not preserve {} before replacing it ({}); nothing was changed",
        path.display(),
        last_err
    ))
}

/// Rule 3. Stage → fsync → rename → fsync dir, owner-only from creation.
fn write_file_atomic_owner_only(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "config path has no parent"))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config.json".to_string());
    let staged = dir.join(format!("{}.{}.{}.tmp", name, std::process::id(), nonce));
    let result = (|| -> std::io::Result<()> {
        let mut opts = std::fs::OpenOptions::new();
        // create_new: the mode below applies only on creation, so the staged
        // name must be one that did not already exist.
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&staged)?;
        file.write_all(contents)?;
        #[cfg(unix)]
        {
            // Exact, not umask-narrowed; before the rename, so a failure here
            // is reported as the failed write it is.
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(&staged, path)
    })();
    if let Err(e) = result {
        // Never leave the scratch copy behind; it holds the same secrets.
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }
    // Durability of the rename itself. Not every platform can open a
    // directory for sync (Windows); the rename is still atomic.
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Rules 2 + 3 for one config file. Returns the backup path when damage was preserved.
fn write_config_at(path: &std::path::Path, json: &str) -> Result<Option<std::path::PathBuf>, String> {
    // Never persist something the next read would refuse as damage.
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(serde_json::Value::Object(_)) => {}
        Ok(_) => return Err("Invalid config: not a JSON object".to_string()),
        Err(e) => return Err(format!("Invalid JSON: {}", e)),
    }
    let dir = path
        .parent()
        .ok_or_else(|| "config path has no parent".to_string())?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    let preserved = match read_config_strict(path) {
        Ok(_) => None,
        Err(_) => Some(preserve_aside(path)?),
    };
    write_file_atomic_owner_only(path, json.as_bytes())
        .map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(preserved)
}

#[tauri::command]
fn read_config() -> Result<String, String> {
    let path = motebit_config_path()?;
    match read_config_strict(&path)? {
        None => Ok("{}".to_string()),
        Some(contents) => {
            tighten_to_owner_only(&path);
            Ok(contents)
        }
    }
}

#[tauri::command]
fn write_config(json: String) -> Result<(), String> {
    let path = motebit_config_path()?;
    if let Some(backup) = write_config_at(&path, &json)? {
        eprintln!(
            "[motebit] unreadable config preserved as {} before replacing it",
            backup.display()
        );
    }
    Ok(())
}

const KEYRING_SERVICE: &str = "com.motebit.desktop";

// === Dev-mode keyring fallback ===
//
// Ad-hoc-signed dev binaries on macOS (the common `cargo run --debug`
// output) can have the Security framework silently drop generic-password
// writes: `keyring::Entry::set_password` returns Ok(()) but the entry
// never persists to the user's login keychain. Observable signature:
// `security dump-keychain` shows zero entries for com.motebit.desktop
// after a bootstrap that appeared to succeed.
//
// Signed production builds (`tauri build` with a Developer ID
// certificate wired via tauri.conf.json `bundle.macOS.signingIdentity`)
// are unaffected — macOS trusts their stable code identity and honors
// the Security framework writes.
//
// Rather than leave dev contributors locked out of any feature that
// depends on keyring storage (device identity, BYOK API keys, sync
// tokens), every `keyring_*` IPC falls through to a file-backed store
// at `~/.motebit/dev-keyring.json`, mode 0600. The file is plaintext
// JSON — a local attacker with read access to `~/.motebit/` already
// has read access to `config.json` (which contains your motebit_id)
// and `motebit.db` (which contains your entire event log). The threat
// model is "signed code can use the OS Keychain; dev binaries fall
// back to the same file-level perms as the rest of the user's
// motebit state." Mode 0600 matches what `~/.ssh/id_ed25519` uses —
// standard Unix file protection, not cryptographic protection.
//
// Reads always try the OS Keychain first; if absent (or transient
// error), fall back to the dev file. Writes attempt the Keychain,
// verify the write persisted (round-trip read), and fall back to the
// dev file if verify fails. Deletes clear both. Signed prod builds
// take the Keychain branch on every call, the dev file never opens.
// A future cleanup once every contributor has a signed dev build can
// remove this fallback entirely.

fn dev_keyring_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".motebit").join("dev-keyring.json"))
}

fn dev_keyring_read_all() -> HashMap<String, String> {
    let path = match dev_keyring_path() {
        Some(p) => p,
        None => return HashMap::new(),
    };
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn dev_keyring_write_all(map: &HashMap<String, String>) -> Result<(), String> {
    let path = dev_keyring_path().ok_or_else(|| "HOME not set".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(&path, &json).map_err(|e| e.to_string())?;
    // mode 0600 — user-only read/write. Matches ~/.ssh/id_ed25519's
    // protection level. On non-Unix (Windows) the permissions model
    // is different and this cfg-gated block is skipped; Windows dev
    // users on Tauri are rare and the fallback still works there, the
    // only gap is Unix-style file perms enforcement.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn keyring_get(key: String) -> Result<Option<String>, String> {
    // Try OS keychain first — signed production builds resolve here.
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &key) {
        match entry.get_password() {
            Ok(val) => return Ok(Some(val)),
            Err(keyring::Error::NoEntry) => {
                // Not in keychain — fall through to dev file.
            }
            Err(_) => {
                // Transient keychain error (permission prompt cancelled,
                // backend unavailable). Fall through rather than failing
                // hard — the dev-file fallback may still have the value.
            }
        }
    }
    // Dev fallback
    let map = dev_keyring_read_all();
    Ok(map.get(&key).cloned())
}

#[tauri::command]
fn keyring_set(key: String, value: String) -> Result<(), String> {
    // Dual-write: Keychain (best-effort) + dev file (authoritative).
    //
    // An earlier attempt verified the Keychain write via a round-trip
    // read, but `keyring::Entry` is consistent within the process even
    // when the Security framework silently drops the write on macOS
    // ad-hoc-signed dev binaries — set_password returns Ok, the
    // subsequent get_password returns the same value, yet `security
    // dump-keychain` from another process shows nothing. The in-process
    // cache hides the drop from the verify step.
    //
    // Fix: always write to the dev file too. Signed production builds
    // read from Keychain first (gets the fresh value). Dev builds read
    // from Keychain (empty) and fall through to the dev file (fresh).
    // In both cases the reader sees the latest value. A stale dev file
    // never causes a read bug because reads prefer Keychain whenever
    // it has the key.
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &key) {
        let _ = entry.set_password(&value); // ignore — file below is authoritative
    }
    let mut map = dev_keyring_read_all();
    map.insert(key, value);
    dev_keyring_write_all(&map)
}

#[tauri::command]
fn keyring_delete(key: String) -> Result<(), String> {
    // Best-effort delete from both stores; idempotent.
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &key) {
        let _ = entry.delete_credential();
    }
    let mut map = dev_keyring_read_all();
    if map.remove(&key).is_some() {
        // Intentionally swallow write errors on delete — the caller's
        // intent ("make sure this key is gone") is satisfied as long
        // as future reads return None. The Keychain delete above
        // handles the signed-build case; if the dev file is already
        // unwritable (e.g. perms changed), future reads of a still-
        // present-in-file key would surface a stale value. Better
        // to report that on next read than to throw here.
        let _ = dev_keyring_write_all(&map);
    }
    Ok(())
}

// === MCP Discovery ===

/// Read MCP config files from known, allowlisted locations only.
/// Returns contents of each file (null if not found/unreadable).
#[derive(serde::Serialize)]
struct McpConfigSource {
    name: String,
    path: String,
    content: Option<String>,
}

#[tauri::command]
fn discover_mcp_configs() -> Vec<McpConfigSource> {
    let home = match home_dir() {
        Some(h) => h,
        None => return vec![],
    };

    let mut sources: Vec<(&str, String)> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        sources.push(("Claude Desktop", format!("{}/Library/Application Support/Claude/claude_desktop_config.json", home)));
        sources.push(("Claude Code", format!("{}/.claude.json", home)));
        sources.push(("VS Code", format!("{}/Library/Application Support/Code/User/settings.json", home)));
    }

    #[cfg(target_os = "linux")]
    {
        // Claude Desktop on Linux — casing varies by distro
        sources.push(("Claude Desktop", format!("{}/.config/claude/claude_desktop_config.json", home)));
        sources.push(("Claude Desktop", format!("{}/.config/Claude/claude_desktop_config.json", home)));
        sources.push(("Claude Code", format!("{}/.claude.json", home)));
        sources.push(("VS Code", format!("{}/.config/Code/User/settings.json", home)));
        // Code - OSS (open-source VS Code on some Linux distros)
        sources.push(("VS Code", format!("{}/.config/Code - OSS/User/settings.json", home)));
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| format!("{}\\AppData\\Roaming", home));
        sources.push(("Claude Desktop", format!("{}\\Claude\\claude_desktop_config.json", appdata)));
        sources.push(("Claude Code", format!("{}\\.claude.json", home)));
        sources.push(("VS Code", format!("{}\\Code\\User\\settings.json", appdata)));
    }

    sources
        .into_iter()
        .map(|(name, path)| {
            let content = std::fs::read_to_string(&path).ok();
            McpConfigSource { name: name.to_string(), path, content }
        })
        .collect()
}

/// Resolve home directory across platforms.
fn home_dir() -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    { std::env::var("HOME").ok() }

    #[cfg(target_os = "windows")]
    { std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok() }
}

// === Privileged Tool Commands ===

/// Deny the file tools access to the sovereign state dir `~/.motebit`
/// (keyring, config, db). Defense-in-depth at the privilege boundary: even a
/// direct IPC call that bypassed the TS policy gate cannot read or overwrite
/// the secrets. See `tool_guard` + docs/doctrine/surface-authority-model.md.
fn deny_if_protected(path: &str) -> Result<(), String> {
    if let Some(root) = tool_guard::motebit_root() {
        if tool_guard::is_protected_path(std::path::Path::new(path), &root) {
            return Err("access to the motebit state directory (~/.motebit) is not permitted".into());
        }
    }
    Ok(())
}

#[tauri::command]
fn read_file_tool(path: String) -> Result<String, String> {
    deny_if_protected(&path)?;
    std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("File not found: {}", path),
        std::io::ErrorKind::PermissionDenied => format!("Permission denied: {}", path),
        _ => format!("Read error: {}", e),
    })
}

#[tauri::command]
fn write_file_tool(path: String, content: String) -> Result<String, String> {
    deny_if_protected(&path)?;
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

    // Best-effort destructive-command guard (catastrophic-wipe protection).
    // NOT a complete shell boundary — raw `sh -c` stays powerful by design;
    // the CSP is the upstream defense and the full sandbox is deferred
    // (docs/doctrine/surface-authority-model.md).
    if let Some(pattern) = tool_guard::is_destructive_command(&command) {
        return Err(format!(
            "blocked: destructive command pattern '{pattern}' is not permitted"
        ));
    }

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
fn transcribe_audio(audio_base64: String) -> Result<String, String> {
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

    cleanup("");
    Err("No transcription available. Grant macOS Speech Recognition permission (System Settings > Privacy & Security > Speech Recognition) or install whisper locally (pip install openai-whisper).".to_string())
}

// === Goal Commands (narrow IPC — no raw SQL from the webview) ===

#[tauri::command]
fn goals_list(state: State<AppState>, motebit_id: String) -> Result<Vec<JsonValue>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // LEFT JOIN + COALESCE rolls up tokens_used per goal so the runtime
    // register can render the budget envelope without a second query.
    // Pre-token-tracking outcome rows (NULL tokens_used) contribute 0 —
    // correct semantic since we don't know what they consumed.
    // Project the latest outcome's `summary`, `response_full`, and
    // `outcome_id` (used as the slab turn-id seed) onto each goal row
    // so the panels controller can surface `last_response_preview`,
    // `last_response_full`, and `last_turn_id` without a second
    // query. Doctrine: `docs/doctrine/goal-results.md` §"The three
    // categories" + the runner's symmetric clear-on-error (a failed
    // fire's NULL `summary` naturally projects as no preview; the
    // most-recent visible signal stays honest). The slab item id is
    // `slab-turn-${runId}`; the desktop scheduler uses `runId` as the
    // outcome_id, so the latest outcome's outcome_id IS the slab
    // turn-id seed — the TypeScript adapter applies the
    // `slabTurnIdForRun` formula at projection time so the wire
    // shape stays single-sourced (rename-resistant). Only completed
    // outcomes contribute the seed; failed outcomes' outcome_id
    // points at a dissolved slab item, so we project NULL there to
    // match the runner's clear-on-error semantic on web.
    let mut stmt = db
        .prepare(
            "SELECT g.goal_id, g.prompt, g.interval_ms, g.mode, g.status, g.consecutive_failures, \
                    g.created_at, g.last_run_at, g.budget_tokens, \
                    COALESCE(SUM(o.tokens_used), 0) AS spent_tokens, \
                    (SELECT summary FROM goal_outcomes \
                       WHERE goal_id = g.goal_id ORDER BY ran_at DESC LIMIT 1) AS latest_summary, \
                    (SELECT response_full FROM goal_outcomes \
                       WHERE goal_id = g.goal_id ORDER BY ran_at DESC LIMIT 1) AS latest_response_full, \
                    (SELECT CASE WHEN status = 'completed' THEN outcome_id ELSE NULL END \
                       FROM goal_outcomes WHERE goal_id = g.goal_id \
                       ORDER BY ran_at DESC LIMIT 1) AS latest_outcome_id, \
                    (SELECT CASE WHEN status = 'completed' AND signed_manifest IS NOT NULL \
                                 THEN 1 ELSE 0 END \
                       FROM goal_outcomes WHERE goal_id = g.goal_id \
                       ORDER BY ran_at DESC LIMIT 1) AS latest_manifest_signed \
             FROM goals g \
             LEFT JOIN goal_outcomes o ON o.goal_id = g.goal_id \
             WHERE g.motebit_id = ? \
             GROUP BY g.goal_id \
             ORDER BY g.created_at DESC",
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
            // last_run_at is nullable — pre-first-run goals have no value.
            // The UI derives next_run_at from (last_run_at ?? created_at) + interval_ms.
            let last_run_at: Option<i64> = row.get(7)?;
            obj.insert(
                "last_run_at".into(),
                match last_run_at {
                    Some(v) => JsonValue::Number(v.into()),
                    None => JsonValue::Null,
                },
            );
            let budget_tokens: Option<i64> = row.get(8)?;
            obj.insert(
                "budget_tokens".into(),
                match budget_tokens {
                    Some(v) => JsonValue::Number(v.into()),
                    None => JsonValue::Null,
                },
            );
            obj.insert("spent_tokens".into(), JsonValue::Number(row.get::<_, i64>(9)?.into()));
            let latest_summary: Option<String> = row.get(10)?;
            obj.insert(
                "last_response_preview".into(),
                match latest_summary {
                    Some(v) => JsonValue::String(v),
                    None => JsonValue::Null,
                },
            );
            let latest_response_full: Option<String> = row.get(11)?;
            obj.insert(
                "last_response_full".into(),
                match latest_response_full {
                    Some(v) => JsonValue::String(v),
                    None => JsonValue::Null,
                },
            );
            // Latest completed outcome's outcome_id IS the runId the
            // desktop scheduler passed to runtime.sendMessageStreaming,
            // which is what `slabTurnIdForRun` consumes. Surface
            // applies the formula at projection time.
            let latest_outcome_id: Option<String> = row.get(12)?;
            obj.insert(
                "last_outcome_id".into(),
                match latest_outcome_id {
                    Some(v) => JsonValue::String(v),
                    None => JsonValue::Null,
                },
            );
            // Latest outcome's `signed_manifest IS NOT NULL`,
            // projected as a 0/1 integer by the CASE expression above
            // and surfaced to the renderer as `last_manifest_signed`
            // (boolean) for the receipt-summary row's "signed" chip.
            // NULL on goals with no completed outcomes (renderer omits
            // the indicator); 1 on completed + signed; 0 on completed
            // + signing-skipped (identity not loaded / empty / threw).
            // Mirrors web's `last_manifest_signed` semantic exactly so
            // the cross-surface receipt-summary row reads identically.
            let latest_manifest_signed: Option<i64> = row.get(13)?;
            obj.insert(
                "last_manifest_signed".into(),
                match latest_manifest_signed {
                    Some(1) => JsonValue::Bool(true),
                    Some(_) => JsonValue::Bool(false),
                    None => JsonValue::Null,
                },
            );
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
    budget_tokens: Option<i64>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    db.execute(
        "INSERT INTO goals (goal_id, motebit_id, prompt, interval_ms, mode, status, created_at, budget_tokens) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7)",
        rusqlite::params![goal_id, motebit_id, prompt, interval_ms, mode, now, budget_tokens],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn goals_set_budget_tokens(
    state: State<AppState>,
    goal_id: String,
    budget_tokens: Option<i64>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // Update the cap, then re-evaluate budget_exhausted in one
    // transaction: a raised cap above current spend flips the goal back
    // to 'active'; a lowered cap below current spend pushes to
    // 'budget_exhausted'. Terminal statuses (completed/failed) are
    // immune — caps don't reopen them.
    db.execute(
        "UPDATE goals SET budget_tokens = ?1 WHERE goal_id = ?2",
        rusqlite::params![budget_tokens, goal_id],
    )
    .map_err(|e| e.to_string())?;
    // Re-evaluate. Compute spent first via a separate query to avoid a
    // correlated subquery in the UPDATE (rusqlite/SQLite handle it but
    // the explicit form is clearer about intent).
    let spent: i64 = db
        .query_row(
            "SELECT COALESCE(SUM(tokens_used), 0) FROM goal_outcomes WHERE goal_id = ?1",
            [&goal_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let next_status = match budget_tokens {
        Some(cap) if spent >= cap => "budget_exhausted",
        _ => "active",
    };
    db.execute(
        "UPDATE goals SET status = ?1 \
         WHERE goal_id = ?2 AND status NOT IN ('completed', 'failed')",
        rusqlite::params![next_status, goal_id],
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

// === fetch_url: native HTTP fetch for read_url ===
//
// Webview fetch() hits WKWebView's ATS/CORS restrictions and fails with
// the opaque "Load failed" for any external URL. Rust-side reqwest has
// none of that — the read_url tool routes through this command so
// read-the-web actually works in the Tauri surface (and in production).

#[derive(serde::Serialize)]
struct FetchUrlResponse {
    status: u16,
    content_type: String,
    body: String,
}

#[tauri::command]
async fn fetch_url(url: String) -> Result<FetchUrlResponse, String> {
    use std::time::Duration;
    let client = reqwest::Client::builder()
        .user_agent("Motebit/0.1")
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Read body failed: {}", e))?;
    Ok(FetchUrlResponse { status, content_type, body })
}

// (TTS via OpenAI was removed 2026-05-03 along with the rest of the
// OpenAI-Voice path. Voice TTS now lives entirely in TS-side providers
// — ElevenLabs / Inworld / Deepgram / WebSpeech — at
// `apps/desktop/src/ui/voice.ts:rebuildTtsProvider`.)

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
        .manage(SkillsState::new())
        .manage(RuntimeHostState::default())
        .invoke_handler(tauri::generate_handler![
            db_query,
            db_execute,
            read_config,
            write_config,
            keyring_get,
            keyring_set,
            keyring_delete,
            discover_mcp_configs,
            read_file_tool,
            write_file_tool,
            shell_exec_tool,
            transcribe_audio,
            goals_list,
            goals_create,
            goals_set_budget_tokens,
            goals_toggle,
            goals_delete,
            goals_outcomes,
            fetch_url,
            computer_query_display,
            computer_execute,
            se_available,
            se_mint_attestation,
            tpm_available,
            tpm_mint_quote,
            skills_list,
            skills_read_detail,
            skills_install_directory,
            skills_enable,
            skills_disable,
            skills_trust,
            skills_untrust,
            skills_remove,
            skills_verify,
            runtime_host_meta,
            runtime_host_connect,
            runtime_host_send,
            runtime_host_close,
            runtime_host_bind,
            runtime_host_unbind,
            runtime_host_read_file,
            runtime_host_write_file,
            runtime_host_remove_file,
            runtime_host_mkdir_exclusive,
            runtime_host_remove_dir,
            runtime_host_pid_alive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod config_file_tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
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

    fn entries(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn absence_reads_as_none_damage_as_err() {
        let dir = scratch("read");
        let path = dir.join("config.json");
        assert_eq!(read_config_strict(&path).unwrap(), None);
        for body in ["{ \"motebit_id\": ", "null", "[]", "3"] {
            std::fs::write(&path, body).unwrap();
            assert!(read_config_strict(&path).is_err(), "{body} must read as damage");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), body);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn damage_is_preserved_before_it_is_replaced() {
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
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"motebit_id\":\"m-2\"}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_healthy_config_is_replaced_without_a_backup() {
        let dir = scratch("healthy");
        let path = dir.join("config.json");
        std::fs::write(&path, "{\"motebit_id\":\"m-1\"}").unwrap();
        assert_eq!(write_config_at(&path, "{\"motebit_id\":\"m-2\"}").unwrap(), None);
        assert_eq!(entries(&dir), vec!["config.json".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_persist_a_non_object() {
        let dir = scratch("nonobject");
        let path = dir.join("config.json");
        assert!(write_config_at(&path, "[]").is_err());
        assert!(write_config_at(&path, "{").is_err());
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
        // On read: tightened in place.
        tighten_to_owner_only(&path);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        // On write: the replacement is 0600 whatever the old mode was.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_config_at(&path, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scratch_is_removed_when_the_replacement_fails() {
        let dir = scratch("fail");
        let path = dir.join("config.json");
        // A non-empty directory where the file should be: staging succeeds,
        // the rename cannot.
        std::fs::create_dir_all(path.join("occupied")).unwrap();
        assert!(write_file_atomic_owner_only(&path, b"{}").is_err());
        let strays: Vec<String> = entries(&dir)
            .into_iter()
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(strays.is_empty(), "stray scratch files: {strays:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_stamp_matches_the_typescript_spelling() {
        // new Date(1790000000123).toISOString() === "2026-09-21T14:13:20.123Z"
        assert_eq!(backup_stamp(1_790_000_000_123), "2026-09-21T14-13-20-123Z");
        assert_eq!(backup_stamp(0), "1970-01-01T00-00-00-000Z");
        // A leap day, which is where hand-rolled calendars break.
        // new Date(Date.UTC(2028, 1, 29, 23, 59, 59, 999)) → 1835481599999
        assert_eq!(backup_stamp(1_835_481_599_999), "2028-02-29T23-59-59-999Z");
    }
}
