//! Computer-use Tauri bridge.
//!
//! Two commands mirror the `ComputerPlatformDispatcher` interface from
//! `@motebit/runtime` (spec/computer-use-v1.md):
//!
//!   - `computer_query_display` → returns primary-display metadata.
//!   - `computer_execute`       → executes one `ComputerActionRequest.action`.
//!
//! **Status: v1 stub.** Both commands return a structured
//! `{ reason: "not_supported", ... }` error envelope the TS bridge
//! unwraps into a `ComputerDispatcherError`. The real implementations
//! will land in a dedicated follow-up pass:
//!
//!   - `query_display` via ScreenCaptureKit (macOS) / Windows.Graphics.Capture.
//!   - `execute(screenshot)` via the `xcap` crate.
//!   - `execute(click/type/…)` via the `enigo` crate + OS accessibility.
//!
//! Failure shape: when a command returns `Err(FailureEnvelope)`, the TS
//! wrapper reads `envelope.reason` and throws `ComputerDispatcherError(reason)`
//! so `@motebit/runtime`'s session manager can map it into the typed
//! outcome taxonomy (policy_denied, permission_denied, platform_blocked,
//! etc.). Generic errors without a `reason` default to `platform_blocked`.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

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
/// declared in `spec/computer-use-v1.md` §7.1 is valid here; v1 stub
/// always emits `not_supported`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FailureEnvelope {
    pub reason: String,
    pub message: String,
}

impl FailureEnvelope {
    pub fn not_supported(message: impl Into<String>) -> Self {
        Self {
            reason: "not_supported".to_string(),
            message: message.into(),
        }
    }
}

/// Query primary-display metadata. Stub returns `not_supported` until
/// the platform implementation (ScreenCaptureKit, Windows.Graphics.Capture)
/// lands.
#[tauri::command]
pub fn computer_query_display() -> Result<DisplayInfo, FailureEnvelope> {
    Err(FailureEnvelope::not_supported(
        "computer_query_display: platform implementation pending (ScreenCaptureKit / Windows.Graphics.Capture)",
    ))
}

/// Execute one computer-use action. `action` is the nested discriminated
/// variant from `ComputerActionRequest.action` (see `spec/computer-use-v1.md`
/// §5.1). Stub returns `not_supported` for every variant.
#[tauri::command]
pub fn computer_execute(action: JsonValue) -> Result<JsonValue, FailureEnvelope> {
    // Inspect the action's `kind` so the error message tells the caller
    // which variant they attempted — useful diagnostic while the stub is
    // in place. Real implementations dispatch on this kind.
    let kind = action
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("<missing>");
    Err(FailureEnvelope::not_supported(format!(
        "computer_execute({kind}): platform implementation pending (xcap + enigo + OS accessibility)"
    )))
}
