// Runtime-host socket pipe — dumb transport for the webview-resident
// protocol (docs/doctrine/daemon-desktop-unification.md). NO protocol,
// authentication, or election logic lives here: the webview's TS owns
// all of it (the same single implementation the node hosts run); this
// module only moves newline-delimited frames and touches the
// filesystem with the exact primitive semantics the platform seam
// (`RuntimeHostPlatform`) asks for.

#![allow(clippy::needless_pass_by_value)]

use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

#[cfg(unix)]
type Writers = Arc<Mutex<HashMap<u64, UnixStream>>>;

pub struct RuntimeHostState {
    next_id: AtomicU64,
    #[cfg(unix)]
    writers: Writers,
    listener_shutdown: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for RuntimeHostState {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            #[cfg(unix)]
            writers: Arc::new(Mutex::new(HashMap::new())),
            listener_shutdown: Mutex::new(None),
        }
    }
}

/// Process identity + home dir — the webview can't read either itself.
#[tauri::command]
pub fn runtime_host_meta() -> Result<JsonValue, String> {
    let home = std::env::var("HOME").map_err(|_| "no HOME in environment".to_string())?;
    Ok(json!({ "pid": std::process::id(), "home": home }))
}

#[cfg(unix)]
fn spawn_reader(id: u64, stream: UnixStream, channel: Channel<JsonValue>, writers: Writers) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            match line {
                Ok(mut l) => {
                    l.push('\n');
                    if channel
                        .send(json!({ "type": "data", "conn_id": id, "data": l }))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        writers.lock().unwrap().remove(&id);
        let _ = channel.send(json!({ "type": "close", "conn_id": id }));
    });
}

/// Connect to the coordinator socket. Frames stream back over the
/// channel as `{type:"data",conn_id,data}` / `{type:"close",conn_id}`.
/// Returns the connection id, or Err("unreachable") when nothing
/// accepts — the election's null signal.
#[cfg(unix)]
#[tauri::command]
pub fn runtime_host_connect(
    state: tauri::State<RuntimeHostState>,
    socket_path: String,
    on_event: Channel<JsonValue>,
) -> Result<u64, String> {
    let stream = UnixStream::connect(&socket_path).map_err(|_| "unreachable".to_string())?;
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let writer = stream.try_clone().map_err(|e| e.to_string())?;
    state.writers.lock().unwrap().insert(id, writer);
    spawn_reader(id, stream, on_event, state.writers.clone());
    Ok(id)
}

#[cfg(unix)]
#[tauri::command]
pub fn runtime_host_send(
    state: tauri::State<RuntimeHostState>,
    conn_id: u64,
    data: String,
) -> Result<(), String> {
    let mut writers = state.writers.lock().unwrap();
    let stream = writers.get_mut(&conn_id).ok_or("connection gone")?;
    stream.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[cfg(unix)]
#[tauri::command]
pub fn runtime_host_close(state: tauri::State<RuntimeHostState>, conn_id: u64) {
    if let Some(stream) = state.writers.lock().unwrap().remove(&conn_id) {
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Bind the coordinator endpoint (0600). Returns "bound" or "in_use" —
/// the TS election decides what either means. Accepted connections
/// stream `{type:"connection",conn_id}` then per-connection data/close
/// events over the same channel. NEVER unlinks a stale socket — that
/// is the election's mutex-guarded critical section, driven from TS.
#[cfg(unix)]
#[tauri::command]
pub fn runtime_host_bind(
    state: tauri::State<RuntimeHostState>,
    socket_path: String,
    on_event: Channel<JsonValue>,
) -> Result<String, String> {
    let listener = match UnixListener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => return Ok("in_use".to_string()),
        Err(e) => return Err(format!("bind failed: {e}")),
    };
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not restrict socket permissions: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("listener config failed: {e}"))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    *state.listener_shutdown.lock().unwrap() = Some(shutdown.clone());

    let writers = state.writers.clone();
    let next_id = Arc::new(AtomicU64::new(1_000_000)); // listener-side ids; disjoint from connect ids
    std::thread::spawn(move || {
        loop {
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let id = next_id.fetch_add(1, Ordering::SeqCst);
                    match stream.try_clone() {
                        Ok(writer) => {
                            writers.lock().unwrap().insert(id, writer);
                            if on_event
                                .send(json!({ "type": "connection", "conn_id": id }))
                                .is_err()
                            {
                                break;
                            }
                            spawn_reader(id, stream, on_event.clone(), writers.clone());
                        }
                        Err(_) => continue,
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
    });
    Ok("bound".to_string())
}

#[cfg(unix)]
#[tauri::command]
pub fn runtime_host_unbind(state: tauri::State<RuntimeHostState>) {
    if let Some(flag) = state.listener_shutdown.lock().unwrap().take() {
        flag.store(true, Ordering::SeqCst);
    }
}

// === Filesystem + pid primitives (platform-seam leaf operations) ============

#[tauri::command]
pub fn runtime_host_read_file(path: String) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

#[cfg(unix)]
#[tauri::command]
pub fn runtime_host_write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn runtime_host_remove_file(path: String) {
    let _ = std::fs::remove_file(path);
}

#[tauri::command]
pub fn runtime_host_mkdir_exclusive(path: String) -> Result<String, String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match std::fs::create_dir(&path) {
        Ok(()) => Ok("created".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok("exists".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn runtime_host_remove_dir(path: String) {
    let _ = std::fs::remove_dir_all(path);
}

#[cfg(unix)]
#[tauri::command]
pub fn runtime_host_pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // Signal-0 probe; permission-denied means the pid exists under
    // another user — alive for election purposes.
    let result = unsafe { libc::kill(pid, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

// === Non-unix stubs (Windows named-pipe support is a recorded residual) =====

#[cfg(not(unix))]
#[tauri::command]
pub fn runtime_host_connect(
    _state: tauri::State<RuntimeHostState>,
    _socket_path: String,
    _on_event: Channel<JsonValue>,
) -> Result<u64, String> {
    Err("runtime-host transport is not yet supported on this platform".to_string())
}

#[cfg(not(unix))]
#[tauri::command]
pub fn runtime_host_send(
    _state: tauri::State<RuntimeHostState>,
    _conn_id: u64,
    _data: String,
) -> Result<(), String> {
    Err("runtime-host transport is not yet supported on this platform".to_string())
}

#[cfg(not(unix))]
#[tauri::command]
pub fn runtime_host_close(_state: tauri::State<RuntimeHostState>, _conn_id: u64) {}

#[cfg(not(unix))]
#[tauri::command]
pub fn runtime_host_bind(
    _state: tauri::State<RuntimeHostState>,
    _socket_path: String,
    _on_event: Channel<JsonValue>,
) -> Result<String, String> {
    Err("runtime-host transport is not yet supported on this platform".to_string())
}

#[cfg(not(unix))]
#[tauri::command]
pub fn runtime_host_unbind(_state: tauri::State<RuntimeHostState>) {}

#[cfg(not(unix))]
#[tauri::command]
pub fn runtime_host_write_file(_path: String, _content: String) -> Result<(), String> {
    Err("runtime-host transport is not yet supported on this platform".to_string())
}

#[cfg(not(unix))]
#[tauri::command]
pub fn runtime_host_pid_alive(_pid: i32) -> bool {
    false
}
