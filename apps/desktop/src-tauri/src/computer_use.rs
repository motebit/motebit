//! Computer-use Tauri bridge — real implementation.
//!
//! Two commands mirror the `ComputerPlatformDispatcher` interface from
//! `@motebit/runtime` (spec/computer-use-v1.md):
//!
//!   - `computer_query_display` → primary-display metadata via `xcap`.
//!   - `computer_execute`       → one `ComputerActionRequest.action`.
//!
//! Input dispatch is `enigo`; screen capture is `xcap`. Both are
//! cross-platform but the macOS paths fault through the TCC permission
//! pipeline (Screen Recording + Accessibility) — we normalize the fault
//! to the protocol's `permission_denied` outcome so the session manager
//! surfaces it to the AI deterministically.
//!
//! Return shape:
//!   - Observation actions (`screenshot`, `cursor_position`) return a
//!     JSON object whose `kind` matches the action. Screenshot includes
//!     a raw PNG artifact — `artifact_id` is the bytes' SHA-256 prefix,
//!     `artifact_sha256` binds verification. Bytes travel inline as
//!     base64 in `bytes_base64` for v1; a future pass can route them
//!     through a content-addressed artifact store without changing this
//!     function's shape.
//!   - Input actions return `null`. The signed receipt upstream is the
//!     audit record; no per-action data is produced here.
//!
//! Failure mapping:
//!   - `xcap` / `enigo` permission faults → `permission_denied`.
//!   - Unknown `action.kind`              → `platform_blocked`.
//!   - All other errors                   → `platform_blocked`.
//!   - `key` / `type` action where the key name can't be parsed →
//!     `platform_blocked` (matches the spec: we executed nothing).
//!
//! Coordinate space: actions arrive in logical pixels. `xcap` and `enigo`
//! both operate in logical pixels on macOS, matching the session-opened
//! event's `display_width / display_height` from `query_display`. No
//! scaling transform is applied here.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use enigo::{
    Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings,
};
use image::ImageEncoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use xcap::Monitor;

/// Primary-display info returned by `computer_query_display`. Logical
/// pixels. `scaling_factor` is logical-to-physical.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DisplayInfo {
    pub width: u32,
    pub height: u32,
    pub scaling_factor: f64,
}

/// Structured failure envelope. TS side reads `reason` and throws a
/// `ComputerDispatcherError(reason, message)`. Any of the ten reasons
/// declared in `spec/computer-use-v1.md` §7.1 is valid here.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FailureEnvelope {
    pub reason: String,
    pub message: String,
}

impl FailureEnvelope {
    fn new(reason: &str, message: impl Into<String>) -> Self {
        Self {
            reason: reason.to_string(),
            message: message.into(),
        }
    }
    fn platform_blocked(message: impl Into<String>) -> Self {
        Self::new("platform_blocked", message)
    }
    fn permission_denied(message: impl Into<String>) -> Self {
        Self::new("permission_denied", message)
    }
}

/// Query primary-display metadata via `xcap`. Returns logical pixel
/// dimensions (the coordinate space subsequent actions operate in).
/// Returns `permission_denied` on macOS if Screen Recording is not
/// authorized — `Monitor::all()` returns a non-empty list without it,
/// but the first `capture_image()` call will fault. We call it here to
/// force the TCC prompt early; the bytes are discarded.
#[tauri::command]
pub fn computer_query_display() -> Result<DisplayInfo, FailureEnvelope> {
    let monitor = primary_monitor()?;
    let width = monitor
        .width()
        .map_err(|e| FailureEnvelope::platform_blocked(format!("monitor.width: {e}")))?;
    let height = monitor
        .height()
        .map_err(|e| FailureEnvelope::platform_blocked(format!("monitor.height: {e}")))?;
    let scaling_factor = monitor
        .scale_factor()
        .map_err(|e| FailureEnvelope::platform_blocked(format!("monitor.scale_factor: {e}")))?
        as f64;
    Ok(DisplayInfo {
        width,
        height,
        scaling_factor,
    })
}

/// Execute one computer-use action. `action` is the nested discriminated
/// variant from `ComputerActionRequest.action` (see `spec/computer-use-v1.md`
/// §5.1). Dispatches on `action.kind`.
#[tauri::command]
pub fn computer_execute(action: JsonValue) -> Result<JsonValue, FailureEnvelope> {
    let kind = action
        .get("kind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FailureEnvelope::platform_blocked("action.kind missing or not a string"))?;

    match kind {
        "screenshot" => do_screenshot(),
        "cursor_position" => do_cursor_position(),
        "click" => do_click(&action, false),
        "double_click" => do_click(&action, true),
        "mouse_move" => do_mouse_move(&action),
        "drag" => do_drag(&action),
        "type" => do_type(&action),
        "key" => do_key(&action),
        "scroll" => do_scroll(&action),
        other => Err(FailureEnvelope::platform_blocked(format!(
            "unknown computer action kind: {other}"
        ))),
    }
}

// ── Monitor selection ────────────────────────────────────────────────

fn primary_monitor() -> Result<Monitor, FailureEnvelope> {
    let monitors = Monitor::all().map_err(|e| to_capture_error(e.to_string()))?;
    monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| {
            Monitor::all()
                .ok()
                .and_then(|ms| ms.into_iter().next())
        })
        .ok_or_else(|| FailureEnvelope::platform_blocked("no monitors reported by xcap"))
}

/// xcap surfaces permission faults as platform-specific `Xcap*` errors.
/// On macOS without Screen Recording TCC, the message typically mentions
/// "permission" / "denied" / "screen recording". We recognize that and
/// map to `permission_denied` for deterministic AI handling.
fn to_capture_error(msg: String) -> FailureEnvelope {
    let lower = msg.to_lowercase();
    if lower.contains("permission")
        || lower.contains("denied")
        || lower.contains("authoriz")
        || lower.contains("screen recording")
    {
        FailureEnvelope::permission_denied(msg)
    } else {
        FailureEnvelope::platform_blocked(msg)
    }
}

// ── Observation actions ──────────────────────────────────────────────

fn do_screenshot() -> Result<JsonValue, FailureEnvelope> {
    let monitor = primary_monitor()?;
    let image = monitor
        .capture_image()
        .map_err(|e| to_capture_error(e.to_string()))?;
    let width = image.width();
    let height = image.height();

    let mut buf = Vec::with_capacity((width as usize) * (height as usize) * 4);
    image::codecs::png::PngEncoder::new(Cursor::new(&mut buf))
        .write_image(&image, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| FailureEnvelope::platform_blocked(format!("png encode: {e}")))?;

    let sha = Sha256::digest(&buf);
    let sha_hex = hex(&sha);
    let artifact_id = format!("sha256:{}", &sha_hex[..16]);
    let bytes_base64 = B64.encode(&buf);
    let captured_at = now_ms();

    Ok(json!({
        "kind": "screenshot",
        "image_format": "png",
        "width": width,
        "height": height,
        "captured_at": captured_at,
        "artifact_id": artifact_id,
        "artifact_sha256": sha_hex,
        "bytes_base64": bytes_base64,
        "redaction": {
            "applied": false,
            "projection_kind": "raw",
        },
    }))
}

fn do_cursor_position() -> Result<JsonValue, FailureEnvelope> {
    let enigo = Enigo::new(&Settings::default())
        .map_err(|e| to_input_error(format!("enigo init: {e}")))?;
    let (x, y) = enigo
        .location()
        .map_err(|e| to_input_error(format!("enigo.location: {e}")))?;
    Ok(json!({
        "kind": "cursor_position",
        "x": x,
        "y": y,
        "captured_at": now_ms(),
    }))
}

// ── Input actions ────────────────────────────────────────────────────

fn do_click(action: &JsonValue, double: bool) -> Result<JsonValue, FailureEnvelope> {
    let (x, y) = read_target(action, "target")?;
    let button = parse_button(action.get("button").and_then(|v| v.as_str()).unwrap_or("left"))?;
    let modifiers = parse_modifiers(action.get("modifiers"))?;

    let mut enigo = new_enigo()?;
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| to_input_error(format!("move_mouse: {e}")))?;
    hold_modifiers(&mut enigo, &modifiers, Direction::Press)?;
    enigo
        .button(button, Direction::Click)
        .map_err(|e| to_input_error(format!("button click: {e}")))?;
    if double {
        sleep(Duration::from_millis(40));
        enigo
            .button(button, Direction::Click)
            .map_err(|e| to_input_error(format!("button second click: {e}")))?;
    }
    hold_modifiers(&mut enigo, &modifiers, Direction::Release)?;
    Ok(JsonValue::Null)
}

fn do_mouse_move(action: &JsonValue) -> Result<JsonValue, FailureEnvelope> {
    let (x, y) = read_target(action, "target")?;
    let mut enigo = new_enigo()?;
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| to_input_error(format!("move_mouse: {e}")))?;
    Ok(JsonValue::Null)
}

fn do_drag(action: &JsonValue) -> Result<JsonValue, FailureEnvelope> {
    let (from_x, from_y) = read_target(action, "from")?;
    let (to_x, to_y) = read_target(action, "to")?;
    let button = parse_button(action.get("button").and_then(|v| v.as_str()).unwrap_or("left"))?;
    let modifiers = parse_modifiers(action.get("modifiers"))?;
    let duration_ms = action
        .get("duration_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(120);

    let mut enigo = new_enigo()?;
    hold_modifiers(&mut enigo, &modifiers, Direction::Press)?;
    enigo
        .move_mouse(from_x, from_y, Coordinate::Abs)
        .map_err(|e| to_input_error(format!("move to from: {e}")))?;
    enigo
        .button(button, Direction::Press)
        .map_err(|e| to_input_error(format!("button press: {e}")))?;

    // Interpolate ~40Hz so the drag reads as a smooth gesture to the
    // target app instead of a teleport — several apps treat teleports
    // as programmatic input and reject them.
    let steps = (duration_ms / 25).max(1) as i32;
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let ix = from_x + ((to_x - from_x) as f64 * t) as i32;
        let iy = from_y + ((to_y - from_y) as f64 * t) as i32;
        enigo
            .move_mouse(ix, iy, Coordinate::Abs)
            .map_err(|e| to_input_error(format!("move interp: {e}")))?;
        sleep(Duration::from_millis(25));
    }

    enigo
        .button(button, Direction::Release)
        .map_err(|e| to_input_error(format!("button release: {e}")))?;
    hold_modifiers(&mut enigo, &modifiers, Direction::Release)?;
    Ok(JsonValue::Null)
}

fn do_type(action: &JsonValue) -> Result<JsonValue, FailureEnvelope> {
    let text = action
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FailureEnvelope::platform_blocked("type.text missing"))?;
    let per_char_delay_ms = action
        .get("per_char_delay_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let mut enigo = new_enigo()?;
    if per_char_delay_ms == 0 {
        enigo
            .text(text)
            .map_err(|e| to_input_error(format!("text: {e}")))?;
    } else {
        for c in text.chars() {
            enigo
                .text(&c.to_string())
                .map_err(|e| to_input_error(format!("text char: {e}")))?;
            sleep(Duration::from_millis(per_char_delay_ms));
        }
    }
    Ok(JsonValue::Null)
}

fn do_key(action: &JsonValue) -> Result<JsonValue, FailureEnvelope> {
    let spec = action
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| FailureEnvelope::platform_blocked("key.key missing"))?;
    let (modifiers, main_key) = parse_key_combo(spec)?;

    let mut enigo = new_enigo()?;
    hold_modifiers(&mut enigo, &modifiers, Direction::Press)?;
    enigo
        .key(main_key, Direction::Click)
        .map_err(|e| to_input_error(format!("key click: {e}")))?;
    hold_modifiers(&mut enigo, &modifiers, Direction::Release)?;
    Ok(JsonValue::Null)
}

fn do_scroll(action: &JsonValue) -> Result<JsonValue, FailureEnvelope> {
    let (x, y) = read_target(action, "target")?;
    let dx = action.get("dx").and_then(|v| v.as_i64()).unwrap_or(0);
    let dy = action.get("dy").and_then(|v| v.as_i64()).unwrap_or(0);

    let mut enigo = new_enigo()?;
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| to_input_error(format!("move for scroll: {e}")))?;
    if dy != 0 {
        enigo
            .scroll(dy as i32, Axis::Vertical)
            .map_err(|e| to_input_error(format!("scroll Y: {e}")))?;
    }
    if dx != 0 {
        enigo
            .scroll(dx as i32, Axis::Horizontal)
            .map_err(|e| to_input_error(format!("scroll X: {e}")))?;
    }
    Ok(JsonValue::Null)
}

// ── Helpers ──────────────────────────────────────────────────────────

fn new_enigo() -> Result<Enigo, FailureEnvelope> {
    Enigo::new(&Settings::default()).map_err(|e| to_input_error(format!("enigo init: {e}")))
}

/// enigo's InputError on macOS typically contains "accessibility" when
/// Accessibility permission is not granted. Classify to `permission_denied`
/// so the AI loop surfaces the actionable case to the user.
fn to_input_error(msg: String) -> FailureEnvelope {
    let lower = msg.to_lowercase();
    if lower.contains("accessibility")
        || lower.contains("permission")
        || lower.contains("denied")
        || lower.contains("not trusted")
    {
        FailureEnvelope::permission_denied(msg)
    } else {
        FailureEnvelope::platform_blocked(msg)
    }
}

fn read_target(action: &JsonValue, field: &str) -> Result<(i32, i32), FailureEnvelope> {
    let obj = action
        .get(field)
        .ok_or_else(|| FailureEnvelope::platform_blocked(format!("{field} missing")))?;
    let x = obj
        .get("x")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| FailureEnvelope::platform_blocked(format!("{field}.x missing")))?;
    let y = obj
        .get("y")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| FailureEnvelope::platform_blocked(format!("{field}.y missing")))?;
    Ok((x.round() as i32, y.round() as i32))
}

fn parse_button(name: &str) -> Result<Button, FailureEnvelope> {
    match name.to_ascii_lowercase().as_str() {
        "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        other => Err(FailureEnvelope::platform_blocked(format!(
            "unknown button: {other}"
        ))),
    }
}

fn parse_modifiers(raw: Option<&JsonValue>) -> Result<Vec<Key>, FailureEnvelope> {
    let Some(v) = raw else {
        return Ok(vec![]);
    };
    let Some(arr) = v.as_array() else {
        return Ok(vec![]);
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(name) = item.as_str() else {
            return Err(FailureEnvelope::platform_blocked(
                "modifier entries must be strings",
            ));
        };
        out.push(parse_modifier_key(name)?);
    }
    Ok(out)
}

fn parse_modifier_key(name: &str) -> Result<Key, FailureEnvelope> {
    match name.to_ascii_lowercase().as_str() {
        "cmd" | "command" | "meta" | "super" => Ok(Key::Meta),
        "ctrl" | "control" => Ok(Key::Control),
        "alt" | "option" => Ok(Key::Alt),
        "shift" => Ok(Key::Shift),
        other => Err(FailureEnvelope::platform_blocked(format!(
            "unknown modifier: {other}"
        ))),
    }
}

/// Parse a combo like `"cmd+shift+a"` or `"escape"` into (modifiers, key).
fn parse_key_combo(spec: &str) -> Result<(Vec<Key>, Key), FailureEnvelope> {
    let parts: Vec<&str> = spec.split('+').map(str::trim).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err(FailureEnvelope::platform_blocked("key spec empty"));
    }
    let (main_raw, mod_raws) = parts.split_last().unwrap();
    let mut modifiers = Vec::with_capacity(mod_raws.len());
    for m in mod_raws {
        modifiers.push(parse_modifier_key(m)?);
    }
    let main = parse_named_key(main_raw)?;
    Ok((modifiers, main))
}

fn parse_named_key(name: &str) -> Result<Key, FailureEnvelope> {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "escape" | "esc" => Ok(Key::Escape),
        "return" | "enter" => Ok(Key::Return),
        "tab" => Ok(Key::Tab),
        "space" => Ok(Key::Space),
        "backspace" => Ok(Key::Backspace),
        "delete" | "del" => Ok(Key::Delete),
        "up" | "arrowup" => Ok(Key::UpArrow),
        "down" | "arrowdown" => Ok(Key::DownArrow),
        "left" | "arrowleft" => Ok(Key::LeftArrow),
        "right" | "arrowright" => Ok(Key::RightArrow),
        "home" => Ok(Key::Home),
        "end" => Ok(Key::End),
        "pageup" | "pgup" => Ok(Key::PageUp),
        "pagedown" | "pgdn" => Ok(Key::PageDown),
        "cmd" | "command" | "meta" | "super" => Ok(Key::Meta),
        "ctrl" | "control" => Ok(Key::Control),
        "alt" | "option" => Ok(Key::Alt),
        "shift" => Ok(Key::Shift),
        _ => {
            if let Some(fk) = parse_function_key(&lower) {
                return Ok(fk);
            }
            let mut chars = name.chars();
            let first = chars
                .next()
                .ok_or_else(|| FailureEnvelope::platform_blocked("empty key name"))?;
            if chars.next().is_some() {
                return Err(FailureEnvelope::platform_blocked(format!(
                    "unknown key name: {name}"
                )));
            }
            Ok(Key::Unicode(first))
        }
    }
}

/// F1..F20 are available on every enigo-supported target (macOS caps
/// at F20; Windows and Linux-X11 have higher function keys but we stay
/// within the portable subset for wire-format consistency).
fn parse_function_key(lower: &str) -> Option<Key> {
    let n = lower.strip_prefix('f')?.parse::<u32>().ok()?;
    match n {
        1 => Some(Key::F1),
        2 => Some(Key::F2),
        3 => Some(Key::F3),
        4 => Some(Key::F4),
        5 => Some(Key::F5),
        6 => Some(Key::F6),
        7 => Some(Key::F7),
        8 => Some(Key::F8),
        9 => Some(Key::F9),
        10 => Some(Key::F10),
        11 => Some(Key::F11),
        12 => Some(Key::F12),
        13 => Some(Key::F13),
        14 => Some(Key::F14),
        15 => Some(Key::F15),
        16 => Some(Key::F16),
        17 => Some(Key::F17),
        18 => Some(Key::F18),
        19 => Some(Key::F19),
        20 => Some(Key::F20),
        _ => None,
    }
}

fn hold_modifiers(
    enigo: &mut Enigo,
    modifiers: &[Key],
    direction: Direction,
) -> Result<(), FailureEnvelope> {
    // Release in reverse order of press for stack discipline.
    let iter: Box<dyn Iterator<Item = &Key>> = if matches!(direction, Direction::Release) {
        Box::new(modifiers.iter().rev())
    } else {
        Box::new(modifiers.iter())
    };
    for m in iter {
        enigo
            .key(*m, direction)
            .map_err(|e| to_input_error(format!("modifier {m:?}: {e}")))?;
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Unit tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_button_variants() {
        assert!(matches!(parse_button("left").unwrap(), Button::Left));
        assert!(matches!(parse_button("RIGHT").unwrap(), Button::Right));
        assert!(matches!(parse_button("Middle").unwrap(), Button::Middle));
        assert_eq!(parse_button("bogus").unwrap_err().reason, "platform_blocked");
    }

    #[test]
    fn parse_modifier_aliases() {
        assert!(matches!(parse_modifier_key("cmd").unwrap(), Key::Meta));
        assert!(matches!(parse_modifier_key("command").unwrap(), Key::Meta));
        assert!(matches!(parse_modifier_key("meta").unwrap(), Key::Meta));
        assert!(matches!(parse_modifier_key("ctrl").unwrap(), Key::Control));
        assert!(matches!(parse_modifier_key("option").unwrap(), Key::Alt));
        assert!(matches!(parse_modifier_key("shift").unwrap(), Key::Shift));
        assert_eq!(
            parse_modifier_key("hyper").unwrap_err().reason,
            "platform_blocked"
        );
    }

    #[test]
    fn parse_key_combo_plain_key() {
        let (mods, main) = parse_key_combo("escape").unwrap();
        assert!(mods.is_empty());
        assert!(matches!(main, Key::Escape));
    }

    #[test]
    fn parse_key_combo_single_modifier() {
        let (mods, main) = parse_key_combo("cmd+c").unwrap();
        assert_eq!(mods.len(), 1);
        assert!(matches!(mods[0], Key::Meta));
        assert!(matches!(main, Key::Unicode('c')));
    }

    #[test]
    fn parse_key_combo_multiple_modifiers() {
        let (mods, main) = parse_key_combo("ctrl+shift+t").unwrap();
        assert_eq!(mods.len(), 2);
        assert!(matches!(mods[0], Key::Control));
        assert!(matches!(mods[1], Key::Shift));
        assert!(matches!(main, Key::Unicode('t')));
    }

    #[test]
    fn parse_key_combo_function_key() {
        let (mods, main) = parse_key_combo("f11").unwrap();
        assert!(mods.is_empty());
        assert!(matches!(main, Key::F11));
    }

    #[test]
    fn parse_key_combo_function_key_out_of_range_falls_through() {
        // f99 doesn't exist — falls through to single-char path which rejects.
        assert_eq!(
            parse_key_combo("f99").unwrap_err().reason,
            "platform_blocked"
        );
    }

    #[test]
    fn parse_key_combo_named_non_modifier() {
        let (_, main) = parse_key_combo("pageup").unwrap();
        assert!(matches!(main, Key::PageUp));
    }

    #[test]
    fn parse_key_combo_empty_spec() {
        assert_eq!(
            parse_key_combo("").unwrap_err().reason,
            "platform_blocked"
        );
        assert_eq!(
            parse_key_combo("  +  ").unwrap_err().reason,
            "platform_blocked"
        );
    }

    #[test]
    fn parse_key_combo_unknown_key() {
        assert_eq!(
            parse_key_combo("hyperkey").unwrap_err().reason,
            "platform_blocked"
        );
    }

    #[test]
    fn read_target_valid() {
        let a = json!({ "target": { "x": 100.4, "y": 200.6 } });
        let (x, y) = read_target(&a, "target").unwrap();
        assert_eq!(x, 100);
        assert_eq!(y, 201);
    }

    #[test]
    fn read_target_missing_field() {
        let a = json!({ "target": { "x": 100 } });
        assert_eq!(
            read_target(&a, "target").unwrap_err().reason,
            "platform_blocked"
        );
    }

    #[test]
    fn read_target_absent() {
        let a = json!({});
        assert_eq!(
            read_target(&a, "target").unwrap_err().reason,
            "platform_blocked"
        );
    }

    #[test]
    fn parse_modifiers_null_and_missing() {
        assert_eq!(parse_modifiers(None).unwrap().len(), 0);
        let none = json!(null);
        assert_eq!(parse_modifiers(Some(&none)).unwrap().len(), 0);
    }

    #[test]
    fn parse_modifiers_rejects_non_string_entries() {
        let v = json!([123]);
        assert_eq!(
            parse_modifiers(Some(&v)).unwrap_err().reason,
            "platform_blocked"
        );
    }

    #[test]
    fn to_capture_error_classifies_permission() {
        assert_eq!(
            to_capture_error("Screen Recording permission is required".into()).reason,
            "permission_denied"
        );
        assert_eq!(
            to_capture_error("authorization missing".into()).reason,
            "permission_denied"
        );
        assert_eq!(to_capture_error("internal bug".into()).reason, "platform_blocked");
    }

    #[test]
    fn to_input_error_classifies_accessibility() {
        assert_eq!(
            to_input_error("Accessibility permission not granted".into()).reason,
            "permission_denied"
        );
        assert_eq!(
            to_input_error("application is not trusted".into()).reason,
            "permission_denied"
        );
        assert_eq!(to_input_error("some other bug".into()).reason, "platform_blocked");
    }

    #[test]
    fn hex_zero_and_nonzero() {
        assert_eq!(hex(&[0u8; 4]), "00000000");
        assert_eq!(hex(&[0xde, 0xad, 0xbe, 0xef]), "deadbeef");
    }

    #[test]
    fn compute_execute_unknown_kind_maps_to_platform_blocked() {
        let action = json!({ "kind": "teleport" });
        let err = computer_execute(action).unwrap_err();
        assert_eq!(err.reason, "platform_blocked");
        assert!(err.message.contains("teleport"));
    }

    #[test]
    fn compute_execute_missing_kind_maps_to_platform_blocked() {
        let action = json!({});
        let err = computer_execute(action).unwrap_err();
        assert_eq!(err.reason, "platform_blocked");
    }

    #[test]
    fn compute_execute_type_missing_text_maps_to_platform_blocked() {
        let action = json!({ "kind": "type" });
        let err = computer_execute(action).unwrap_err();
        assert_eq!(err.reason, "platform_blocked");
    }

    #[test]
    fn compute_execute_key_missing_key_maps_to_platform_blocked() {
        let action = json!({ "kind": "key" });
        let err = computer_execute(action).unwrap_err();
        assert_eq!(err.reason, "platform_blocked");
    }
}
