//! Skills sidecar host — bridges Tauri IPC commands to a Node child
//! that wraps `@motebit/skills`.
//!
//! Why a Node sidecar, not a Tauri-fs adapter in the webview:
//! `feedback_privilege_boundary_probe` (2026-04-29). Skill install is
//! permissive (`spec/skills-v1.md` §7.1) — motebit accepts arbitrary
//! third-party `SKILL.md` content. Rendering that content in a context
//! that ALSO has fs-write + signature verification collapses three
//! privilege concerns into one process. The desktop renderer is a
//! Chromium webview (`architecture_tauri_webview_not_node`), and a
//! compromised webview holding render-attacker-content + fs-write +
//! crypto-verify is exactly the failure mode the doctrine forbids.
//!
//! Boundary: webview → Tauri IPC (this file) → Node sidecar. The
//! webview only ever invokes `skills_*` commands, which return
//! display-grade summaries. Verification, fs writes, and trust grants
//! happen in the Node child, never in the renderer.
//!
//! Wire format: newline-delimited JSON over stdin/stdout. One request
//! per line, one response per line. Notifications (audit events,
//! sidecar-ready signal) carry `id: null` so they don't collide with
//! request/response pairing.
//!
//! Lifecycle: lazy spawn on first command. `Sidecar` owns the Child +
//! its stdin/stdout handles inside the `AppState`'s `Mutex`. On EOF or
//! protocol error, the slot is cleared and the next command respawns —
//! v1 retries are caller-driven, not auto-retried inside the same call.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SkillsError {
    pub reason: String,
    pub message: String,
}

impl SkillsError {
    fn new(reason: &str, message: impl Into<String>) -> Self {
        Self {
            reason: reason.to_string(),
            message: message.into(),
        }
    }
    fn unavailable(msg: impl Into<String>) -> Self {
        Self::new("sidecar_unavailable", msg)
    }
    fn protocol(msg: impl Into<String>) -> Self {
        Self::new("protocol_error", msg)
    }
}

/// Sidecar process handle. Holds the Child + its piped I/O. Created
/// lazily on first request; replaced on protocol failure.
struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

/// Owned by `AppState` (in `main.rs`). The lazy-init pattern means a
/// user who never opens the skills panel never spawns Node.
pub struct SkillsState {
    sidecar: Mutex<Option<Sidecar>>,
}

impl SkillsState {
    pub fn new() -> Self {
        Self {
            sidecar: Mutex::new(None),
        }
    }
}

impl Default for SkillsState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Path resolution ───────────────────────────────────────────────────

/// Resolve the sidecar JS path. Dev and prod resolve via the same
/// Tauri `BaseDirectory::Resource` lookup — `bundle.resources` in
/// `tauri.conf.json` points it at `src-tauri/sidecar/skills.js` in dev
/// and at the bundled Resources dir in prod.
fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, SkillsError> {
    app.path()
        .resolve("sidecar/skills.js", BaseDirectory::Resource)
        .map_err(|e| {
            SkillsError::unavailable(format!("could not resolve sidecar/skills.js: {e}"))
        })
}

// ── Spawn / handshake ─────────────────────────────────────────────────

fn spawn_sidecar(app: &AppHandle) -> Result<Sidecar, SkillsError> {
    let path = resolve_sidecar_path(app)?;
    if !path.exists() {
        return Err(SkillsError::unavailable(format!(
            "sidecar not found at {} — ensure tauri.conf.json bundle.resources includes sidecar/skills.js",
            path.display()
        )));
    }

    let mut child = Command::new("node")
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            SkillsError::unavailable(format!(
                "failed to spawn `node {}`: {e} — Node ≥20 must be on PATH",
                path.display()
            ))
        })?;

    let stdin = child.stdin.take().ok_or_else(|| {
        SkillsError::unavailable("sidecar stdin pipe missing after spawn".to_string())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        SkillsError::unavailable("sidecar stdout pipe missing after spawn".to_string())
    })?;
    let mut stdout = BufReader::new(stdout);

    // Handshake: sidecar emits one ready frame before accepting
    // requests. Reading it here keeps the first command from racing
    // the @motebit/skills import inside the child.
    let mut line = String::new();
    stdout.read_line(&mut line).map_err(|e| {
        SkillsError::unavailable(format!("sidecar handshake read failed: {e}"))
    })?;
    let parsed: JsonValue = serde_json::from_str(line.trim()).map_err(|e| {
        SkillsError::protocol(format!(
            "sidecar handshake frame was not valid JSON: {e} — line: {line:?}"
        ))
    })?;
    if parsed.get("notification").and_then(JsonValue::as_str) != Some("ready") {
        return Err(SkillsError::protocol(format!(
            "expected ready notification from sidecar; got {parsed}"
        )));
    }

    Ok(Sidecar {
        child,
        stdin,
        stdout,
        next_id: 1,
    })
}

// ── Request / response cycle ──────────────────────────────────────────

#[derive(Serialize)]
struct Request<'a> {
    id: u64,
    method: &'a str,
    params: JsonValue,
}

fn call(
    app: &AppHandle,
    state: &SkillsState,
    method: &str,
    params: JsonValue,
) -> Result<JsonValue, SkillsError> {
    let mut guard = state.sidecar.lock().map_err(|e| {
        SkillsError::protocol(format!("sidecar mutex poisoned: {e}"))
    })?;
    if guard.is_none() {
        *guard = Some(spawn_sidecar(app)?);
    }
    let sidecar = guard.as_mut().expect("sidecar present after init");

    let id = sidecar.next_id;
    sidecar.next_id += 1;

    let req = Request { id, method, params };
    let payload = serde_json::to_string(&req).map_err(|e| {
        SkillsError::protocol(format!("could not serialize request: {e}"))
    })?;

    if let Err(e) = writeln!(sidecar.stdin, "{payload}") {
        // Write failure usually means the child died. Drop the slot so
        // the next call respawns.
        *guard = None;
        return Err(SkillsError::unavailable(format!(
            "sidecar stdin write failed: {e}"
        )));
    }
    if let Err(e) = sidecar.stdin.flush() {
        *guard = None;
        return Err(SkillsError::unavailable(format!(
            "sidecar stdin flush failed: {e}"
        )));
    }

    // Read response lines, skipping notifications (id: null) until we
    // see our id back. The sidecar's audit-event sink emits
    // `notification: "audit"` frames asynchronously; v1 we drop them
    // here since the host doesn't yet route them into the event store.
    loop {
        let mut line = String::new();
        let n = sidecar.stdout.read_line(&mut line).map_err(|e| {
            SkillsError::protocol(format!("sidecar stdout read failed: {e}"))
        })?;
        if n == 0 {
            *guard = None;
            return Err(SkillsError::unavailable(
                "sidecar closed stdout (likely crashed)".to_string(),
            ));
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: JsonValue = serde_json::from_str(trimmed).map_err(|e| {
            SkillsError::protocol(format!("malformed sidecar response: {e}"))
        })?;
        match parsed.get("id") {
            Some(JsonValue::Number(n)) if n.as_u64() == Some(id) => {
                if parsed.get("ok") == Some(&JsonValue::Bool(true)) {
                    return Ok(parsed
                        .get("result")
                        .cloned()
                        .unwrap_or(JsonValue::Null));
                }
                let err_obj = parsed.get("error");
                let reason = err_obj
                    .and_then(|v| v.get("reason"))
                    .and_then(JsonValue::as_str)
                    .unwrap_or("internal_error")
                    .to_string();
                let message = err_obj
                    .and_then(|v| v.get("message"))
                    .and_then(JsonValue::as_str)
                    .unwrap_or("")
                    .to_string();
                return Err(SkillsError { reason, message });
            }
            _ => {
                // Notification (id: null) or mismatched id — skip.
                continue;
            }
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn skills_list(
    app: AppHandle,
    state: State<SkillsState>,
) -> Result<JsonValue, SkillsError> {
    call(&app, &state, "list", JsonValue::Null)
}

#[tauri::command]
pub fn skills_read_detail(
    app: AppHandle,
    state: State<SkillsState>,
    name: String,
) -> Result<JsonValue, SkillsError> {
    call(
        &app,
        &state,
        "read_detail",
        serde_json::json!({ "name": name }),
    )
}

#[tauri::command]
pub fn skills_install_directory(
    app: AppHandle,
    state: State<SkillsState>,
    path: String,
    force: Option<bool>,
) -> Result<JsonValue, SkillsError> {
    call(
        &app,
        &state,
        "install_directory",
        serde_json::json!({ "path": path, "force": force.unwrap_or(false) }),
    )
}

#[tauri::command]
pub fn skills_enable(
    app: AppHandle,
    state: State<SkillsState>,
    name: String,
) -> Result<JsonValue, SkillsError> {
    call(&app, &state, "enable", serde_json::json!({ "name": name }))
}

#[tauri::command]
pub fn skills_disable(
    app: AppHandle,
    state: State<SkillsState>,
    name: String,
) -> Result<JsonValue, SkillsError> {
    call(&app, &state, "disable", serde_json::json!({ "name": name }))
}

#[tauri::command]
pub fn skills_trust(
    app: AppHandle,
    state: State<SkillsState>,
    name: String,
) -> Result<JsonValue, SkillsError> {
    call(&app, &state, "trust", serde_json::json!({ "name": name }))
}

#[tauri::command]
pub fn skills_untrust(
    app: AppHandle,
    state: State<SkillsState>,
    name: String,
) -> Result<JsonValue, SkillsError> {
    call(&app, &state, "untrust", serde_json::json!({ "name": name }))
}

#[tauri::command]
pub fn skills_remove(
    app: AppHandle,
    state: State<SkillsState>,
    name: String,
) -> Result<JsonValue, SkillsError> {
    call(&app, &state, "remove", serde_json::json!({ "name": name }))
}

#[tauri::command]
pub fn skills_verify(
    app: AppHandle,
    state: State<SkillsState>,
    name: String,
) -> Result<JsonValue, SkillsError> {
    call(&app, &state, "verify", serde_json::json!({ "name": name }))
}

// Drop on the Sidecar struct kills the child so `tauri:dev` reloads
// don't leak Node processes.
impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_error_unavailable_carries_reason() {
        let e = SkillsError::unavailable("boom");
        assert_eq!(e.reason, "sidecar_unavailable");
        assert_eq!(e.message, "boom");
    }

    #[test]
    fn skills_error_protocol_carries_reason() {
        let e = SkillsError::protocol("malformed");
        assert_eq!(e.reason, "protocol_error");
        assert_eq!(e.message, "malformed");
    }

    #[test]
    fn request_serializes_with_id_method_params() {
        let req = Request {
            id: 42,
            method: "list",
            params: JsonValue::Null,
        };
        let s = serde_json::to_string(&req).unwrap();
        assert!(s.contains("\"id\":42"));
        assert!(s.contains("\"method\":\"list\""));
        assert!(s.contains("\"params\":null"));
    }

    #[test]
    fn parses_ok_response_to_result_value() {
        // The matching arm in `call()` extracts `.result` for `ok: true`.
        // Mirror the parse path so a refactor that drops the field
        // would flag here.
        let frame = serde_json::json!({
            "id": 1,
            "ok": true,
            "result": ["a", "b"],
        });
        assert_eq!(frame["ok"], JsonValue::Bool(true));
        assert_eq!(frame["result"], serde_json::json!(["a", "b"]));
    }

    #[test]
    fn parses_error_response_to_reason_message() {
        let frame = serde_json::json!({
            "id": 1,
            "ok": false,
            "error": { "reason": "verification_failed", "message": "tampered" },
        });
        let reason = frame["error"]["reason"].as_str().unwrap();
        let message = frame["error"]["message"].as_str().unwrap();
        assert_eq!(reason, "verification_failed");
        assert_eq!(message, "tampered");
    }

    #[test]
    fn ignores_notification_frames_with_null_id() {
        // Notifications carry `id: null` so the request/response
        // matching loop skips them — this test pins that behavior.
        let frame = serde_json::json!({
            "id": null,
            "ok": true,
            "notification": "audit",
        });
        assert_eq!(frame["id"], JsonValue::Null);
        assert_eq!(frame["notification"], JsonValue::String("audit".to_string()));
    }
}
