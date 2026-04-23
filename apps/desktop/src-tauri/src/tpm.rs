//! Windows / Linux TPM 2.0 attestation bridge.
//!
//! Mints a hardware-backed TPM_ST_ATTEST_QUOTE structure plus an
//! ECDSA/RSA signature over it using the TPM's Attestation Key. The
//! private AK material never leaves the TPM; the Rust handle wraps an
//! opaque ESYS context.
//!
//! Platform coverage.
//!   - Windows — TPM 2.0 is mandatory on Windows 11. Access is via the
//!     TBS (TPM Base Services) API surfaced through `tss-esapi` when
//!     running on a device with a provisioned TPM.
//!   - Linux — access is via `/dev/tpm0` (or the software resource
//!     manager `/dev/tpmrm0` on newer kernels). Requires the user to
//!     have R/W on the device node; most modern distros ship with a
//!     `tss` group that owns it.
//!   - macOS — Macs with a T2 chip expose a TPM-shaped interface, but
//!     macOS itself uses the Secure Enclave path. The macOS stub here
//!     returns `not_supported`; `secure_enclave.rs` is the macOS home.
//!
//! Non-goals for v1:
//!   - Persistent AK keys across reboots. TPM2_Quote against an
//!     ephemeral AK generated per attestation is sufficient for a
//!     moment-in-time identity binding; persistent AKs (via
//!     `kPersistentHandle`) land in a second pass.
//!   - TPM vendor EK-provisioning flow. The EK certificate and its
//!     vendor-CA chain are read from platform storage (Windows
//!     registry or `/sys/class/tpm/tpm0/`); provisioning an unprovisioned
//!     TPM is an operator task, not this bridge's concern.
//!
//! Failure envelope shape mirrors `secure_enclave.rs` so the TS side
//! has one taxonomy to pattern-match across every hardware platform:
//!   - `not_supported` — no TPM, macOS, or `tss-esapi` unavailable.
//!   - `permission_denied` — OS-level TPM access denied.
//!   - `platform_blocked` — anything else (OOM, internal TPM error).
//!
//! ## Current ship status — operator follow-up
//!
//! The `tss-esapi` Rust crate (wrapping the TCG's `tpm2-tss` C library)
//! requires `libtss2-*` installed at link time. A cross-platform build
//! without that system library available produces a linker error, not
//! a runtime fallback. Rather than embed a half-stubbed TPM path that
//! would silently return a fake "valid" quote, this module ships with
//! `tpm_mint_quote` returning `not_supported` on every platform until
//! an operator wires `tss-esapi` in the build graph. The TS cascade
//! (`apps/desktop/src/mint-hardware-credential.ts`) treats this as
//! expected and falls through to the software sentinel. The drift
//! gate `check-hardware-attestation-primitives` covers the wire-shape
//! and verifier contracts; the `tss-esapi` integration is tracked as
//! the TPM-adapter follow-up in `docs/doctrine/hardware-attestation.md`.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FailureEnvelope {
    pub reason: String,
    pub message: String,
}

impl FailureEnvelope {
    #[allow(dead_code)]
    fn new(reason: &str, message: impl Into<String>) -> Self {
        Self {
            reason: reason.to_string(),
            message: message.into(),
        }
    }
    fn not_supported(msg: impl Into<String>) -> Self {
        Self {
            reason: "not_supported".to_string(),
            message: msg.into(),
        }
    }
}

/// Result of one `tpm_mint_quote` call — the atomic
/// AK-compose-quote-sign operation. Mirrors `SeMintResult` in shape so
/// the TS consumer has one result ADT per hardware path.
///
/// Wire encoding: each of the four fields is base64url-no-pad; the TS
/// side assembles `{tpms_attest}.{signature}.{ak_cert}.{intermediates}`
/// as the `attestation_receipt`. Intermediates are comma-separated
/// base64url segments inside the fourth position (empty string when
/// the AK chains directly to a pinned root).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TpmMintResult {
    pub tpms_attest_base64: String,
    pub signature_base64: String,
    pub ak_cert_der_base64: String,
    pub intermediates_comma_joined_base64: String,
}

/// Report TPM 2.0 availability. Today: `false` on every platform
/// because `tss-esapi` is not yet linked (see module docstring). When
/// the operator wires the crate, this probes for a present TPM via
/// `tbs` on Windows or `/dev/tpm0` on Linux.
#[tauri::command]
pub fn tpm_available() -> bool {
    // TODO(operator): once `tss-esapi` is linked, probe here. Windows
    // reports TPM via `Tbsi_GetDeviceInfo`; Linux checks for a
    // readable `/dev/tpm0` or `/dev/tpmrm0`.
    #[cfg(target_os = "macos")]
    {
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Atomic mint — generate a fresh AK (or fetch the persistent one),
/// compose a `TPMS_ATTEST` binding the motebit canonical body via
/// extraData, sign with AK, return (attest bytes, signature, AK
/// cert, intermediates).
///
/// v1 ship: returns `not_supported` on every platform. See the module
/// docstring for the operator follow-up.
#[tauri::command]
pub fn tpm_mint_quote(
    motebit_id: String,
    device_id: String,
    identity_public_key_hex: String,
    attested_at: u64,
) -> Result<TpmMintResult, FailureEnvelope> {
    let _ = (motebit_id, device_id, identity_public_key_hex, attested_at);
    #[cfg(target_os = "macos")]
    {
        Err(FailureEnvelope::not_supported(
            "macOS has Secure Enclave; TPM path is Windows / Linux only",
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(FailureEnvelope::not_supported(
            "tss-esapi not linked — TPM bridge returns not_supported pending operator build-graph pass; \
             falls through to `platform: \"software\"` at the TS caller",
        ))
    }
}

// ── Unit tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tpm_available_is_currently_false_on_every_platform() {
        // Until tss-esapi is wired in the build graph, the probe is
        // platform-gated and deliberately returns false — so the TS
        // cascade emits `platform: "software"` rather than a half-
        // stubbed claim.
        assert!(!tpm_available());
    }

    #[test]
    fn tpm_mint_quote_returns_not_supported() {
        let result = tpm_mint_quote(
            "mot_test".to_string(),
            "dev_test".to_string(),
            "a".repeat(64),
            1_700_000_000_000,
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.reason, "not_supported");
    }

    #[test]
    fn failure_envelope_shape_matches_taxonomy() {
        let e = FailureEnvelope::new("platform_blocked", "x");
        assert_eq!(e.reason, "platform_blocked");
        assert_eq!(e.message, "x");
    }
}
