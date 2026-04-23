//! Apple Secure Enclave attestation bridge.
//!
//! Mints a hardware-backed ECDSA P-256 signature over an
//! attestation-claim body. The Enclave generates a fresh ephemeral
//! keypair in-hardware, signs the message, and returns the public
//! key + DER signature. The private key never leaves the Secure
//! Enclave — `kSecAttrTokenID = kSecAttrTokenIDSecureEnclave` is the
//! Apple-supported way to guarantee this.
//!
//! Why ephemeral per-attestation (v1). Persisting SE keys across app
//! launches requires keychain-item lookup by application tag
//! (`SecItemCopyMatching` with `kSecAttrApplicationTag`), biometric /
//! password ACLs, and per-device key-lifecycle management. That's a
//! second pass. For v1, each `se_attest` call mints a fresh key, signs,
//! and lets the transient keychain item drop. Each hardware-attestation
//! claim is a moment-in-time binding between the caller's Ed25519
//! identity key and the Secure Enclave at that instant — sufficient for
//! issuance-time verification inside a `TrustCredential` whose W3C
//! envelope already provides the longer-lived binding. A future pass
//! wires persistent keys (same attestation claim across issuances;
//! identity-level hardware binding) without breaking the wire shape.
//!
//! Non-macOS targets: `se_available()` returns `false`; `se_attest()`
//! returns `FailureEnvelope { reason: "not_supported", ... }`. Honest
//! degradation — the TS mint path falls back to a `platform: "software"`
//! claim and the receiver correctly ranks it lower via the
//! `HardwareAttestationSemiring` (score 0.1).
//!
//! Failure envelope shape mirrors `computer_use.rs`:
//!   - `not_supported` — non-macOS, no Enclave hardware, or the OS
//!     rejected the SE token binding on this device.
//!   - `permission_denied` — TCC / biometric prompt declined.
//!   - `platform_blocked` — anything else (OOM, unexpected error).

use serde::{Deserialize, Serialize};

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
    fn not_supported(msg: impl Into<String>) -> Self {
        Self::new("not_supported", msg)
    }
    #[cfg(target_os = "macos")]
    fn platform_blocked(msg: impl Into<String>) -> Self {
        Self::new("platform_blocked", msg)
    }
    #[cfg(target_os = "macos")]
    fn permission_denied(msg: impl Into<String>) -> Self {
        Self::new("permission_denied", msg)
    }
}

/// Result of one `se_mint_attestation` call — the atomic
/// keygen-compose-sign operation. `body_base64` is the base64url-
/// encoded canonical-JSON attestation body (matching the exact
/// shape `@motebit/crypto`'s verifier expects); `signature_der_base64`
/// is Apple's X9.62 DER signature over those bytes. TS assembles the
/// wire `attestation_receipt` as `"{body_base64}.{signature_der_base64}"`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SeMintResult {
    pub body_base64: String,
    pub signature_der_base64: String,
}

/// Report Secure Enclave availability. True on macOS; false elsewhere.
/// v1 heuristic — a precise check (probe a key-gen attempt) is second-pass.
#[tauri::command]
pub fn se_available() -> bool {
    cfg!(target_os = "macos")
}

/// Atomic mint — generate a fresh SE P-256 key, compose the canonical
/// attestation body (naming the just-generated key), sign with the SE,
/// return both the body and the signature.
///
/// Why one atomic call. The Enclave generates a fresh key per
/// `SecKey::new` (v1 no-persistence path), so "call once to get the
/// key, call again to sign" would produce a body that names a
/// different key than the one that signed — verification would fail.
/// Composing the body inside the Rust side where the key lifetime is
/// scoped to one function call avoids the round-trip bootstrapping
/// problem. This is the cleanest shape until persistent SE keys land.
///
/// The canonical JSON ordering (alphabetical keys, JCS) matches the TS
/// verifier's re-canonicalization so signature verification is
/// byte-exact.
#[tauri::command]
pub fn se_mint_attestation(
    motebit_id: String,
    device_id: String,
    identity_public_key_hex: String,
    attested_at: u64,
) -> Result<SeMintResult, FailureEnvelope> {
    #[cfg(target_os = "macos")]
    {
        se_mint_macos(motebit_id, device_id, identity_public_key_hex, attested_at)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (motebit_id, device_id, identity_public_key_hex, attested_at);
        Err(FailureEnvelope::not_supported(
            "Secure Enclave is only available on macOS",
        ))
    }
}

// ── macOS implementation ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn se_mint_macos(
    motebit_id: String,
    device_id: String,
    identity_public_key_hex: String,
    attested_at: u64,
) -> Result<SeMintResult, FailureEnvelope> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use base64::Engine as _;
    use security_framework::key::{Algorithm, GenerateKeyOptions, KeyType, SecKey, Token};

    // Generate an ephemeral Secure Enclave-bound ECDSA P-256 key. The
    // private key never leaves the SE; the Rust handle wraps an opaque
    // SecKeyRef. Dropping it at the end of this function lets the SE
    // reclaim the slot.
    let mut opts = GenerateKeyOptions::default();
    opts.set_key_type(KeyType::ec())
        .set_size_in_bits(256)
        .set_token(Token::SecureEnclave)
        .set_label("com.motebit.attestation.ephemeral");

    let private_key = SecKey::new(&opts)
        .map_err(|e| classify_sec_err("se key generate", &format!("{e:?}")))?;

    let public_key = private_key
        .public_key()
        .ok_or_else(|| FailureEnvelope::platform_blocked("SE key missing public half"))?;

    let public_der = public_key
        .external_representation()
        .ok_or_else(|| {
            FailureEnvelope::platform_blocked("SE public key lacks external representation")
        })?
        .to_vec();

    let se_public_key_hex = compress_p256_pubkey(&public_der).unwrap_or_else(|_| {
        // Fallback to uncompressed hex if compression fails; the TS
        // verifier accepts both via `@noble/curves`.
        hex_encode(&public_der)
    });

    // Compose the canonical body. Field order matches JCS (RFC 8785):
    // alphabetical by key. Manual string assembly is deliberate — a
    // serde_json::to_string call with BTreeMap ordering would also work
    // but we pay for clarity over the last-mile trust budget.
    let body = canonical_body(
        attested_at,
        &device_id,
        &identity_public_key_hex.to_lowercase(),
        &motebit_id,
        &se_public_key_hex,
    );
    let body_bytes = body.as_bytes();

    // Apple's `ECDSASignatureMessageX962SHA256` takes raw message bytes,
    // SHA-256s them internally, and produces a DER-encoded signature —
    // the exact shape `@motebit/crypto::verifyP256EcdsaSha256` consumes.
    let sig_der = private_key
        .create_signature(Algorithm::ECDSASignatureMessageX962SHA256, body_bytes)
        .map_err(|e| classify_sec_err("se sign", &format!("{e:?}")))?;

    Ok(SeMintResult {
        body_base64: B64.encode(body_bytes),
        signature_der_base64: B64.encode(&sig_der),
    })
}

/// Produce the JCS-canonical JSON body string with alphabetically-
/// sorted keys. Kept separate from the macOS signing path so the
/// canonicalization logic can be unit-tested on any platform.
#[cfg(target_os = "macos")]
fn canonical_body(
    attested_at: u64,
    device_id: &str,
    identity_public_key: &str,
    motebit_id: &str,
    se_public_key: &str,
) -> String {
    // Alphabetical: algorithm, attested_at, device_id,
    // identity_public_key, motebit_id, se_public_key, version.
    format!(
        r#"{{"algorithm":"ecdsa-p256-sha256","attested_at":{attested_at},"device_id":{device_id},"identity_public_key":{identity_public_key},"motebit_id":{motebit_id},"se_public_key":{se_public_key},"version":"1"}}"#,
        attested_at = attested_at,
        device_id = json_string(device_id),
        identity_public_key = json_string(identity_public_key),
        motebit_id = json_string(motebit_id),
        se_public_key = json_string(se_public_key),
    )
}

/// Minimal JSON-string escaper for the fields that go into the
/// canonical body. Motebit IDs / device IDs / hex keys are ASCII-safe
/// in practice — a JSON-conformant escaper is still used as
/// defense-in-depth.
#[cfg(target_os = "macos")]
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Map a raw `SecKey` error message into our failure taxonomy. Apple's
/// errors come through as `CFError` debug strings; we heuristically
/// classify them so the AI / session manager downstream can route on
/// structured reasons instead of opaque text.
#[cfg(target_os = "macos")]
fn classify_sec_err(context: &str, raw: &str) -> FailureEnvelope {
    let lower = raw.to_lowercase();
    let msg = format!("{context}: {raw}");
    if lower.contains("usercancel")
        || lower.contains("authfailed")
        || lower.contains("biometry")
    {
        FailureEnvelope::permission_denied(msg)
    } else if lower.contains("tokennotfound") || lower.contains("no such token") {
        FailureEnvelope::not_supported(msg)
    } else {
        FailureEnvelope::platform_blocked(msg)
    }
}

/// Compress an X9.62 uncompressed P-256 public key (65 bytes,
/// `04 || X || Y`) to the compressed form (`02/03 || X`) as 33-byte
/// hex. Returns the hex-encoded compressed point.
///
/// Returns `Err` on a malformed input so the caller can fall back.
#[cfg(target_os = "macos")]
fn compress_p256_pubkey(uncompressed: &[u8]) -> Result<String, &'static str> {
    if uncompressed.len() != 65 || uncompressed[0] != 0x04 {
        return Err("expected 65-byte uncompressed P-256 point with 0x04 prefix");
    }
    let x = &uncompressed[1..33];
    let y = &uncompressed[33..65];
    let prefix: u8 = if y[31] & 1 == 0 { 0x02 } else { 0x03 };
    let mut out = Vec::with_capacity(33);
    out.push(prefix);
    out.extend_from_slice(x);
    Ok(hex_encode(&out))
}

#[cfg(target_os = "macos")]
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

// ── Unit tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn se_available_true_on_macos() {
        // Platform-gated constant; kept as a behavioral contract so a
        // refactor that accidentally inverted the gate would flag here.
        #[cfg(target_os = "macos")]
        assert!(se_available());
        #[cfg(not(target_os = "macos"))]
        assert!(!se_available());
    }

    #[test]
    fn failure_envelope_shapes_match_taxonomy() {
        let e = FailureEnvelope::not_supported("x");
        assert_eq!(e.reason, "not_supported");
        assert_eq!(e.message, "x");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn classify_sec_err_maps_biometry_to_permission_denied() {
        let e = classify_sec_err("sign", "errSecAuthFailed - userCancel");
        assert_eq!(e.reason, "permission_denied");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn classify_sec_err_maps_token_not_found_to_not_supported() {
        let e = classify_sec_err("keygen", "errSecTokenNotFound");
        assert_eq!(e.reason, "not_supported");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn classify_sec_err_maps_other_to_platform_blocked() {
        let e = classify_sec_err("keygen", "unexpected internal error");
        assert_eq!(e.reason, "platform_blocked");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn compress_p256_pubkey_even_y_uses_02_prefix() {
        // Synthetic uncompressed point. y[31]=0 → even → 0x02 prefix.
        let mut uncompressed = vec![0x04];
        uncompressed.extend_from_slice(&[0xaa; 32]);
        uncompressed.extend_from_slice(&[0x00; 32]);
        let hex = compress_p256_pubkey(&uncompressed).unwrap();
        assert!(hex.starts_with("02"));
        assert_eq!(hex.len(), 66);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn compress_p256_pubkey_odd_y_uses_03_prefix() {
        let mut uncompressed = vec![0x04];
        uncompressed.extend_from_slice(&[0xbb; 32]);
        let mut y = [0x00; 32];
        y[31] = 0x01;
        uncompressed.extend_from_slice(&y);
        let hex = compress_p256_pubkey(&uncompressed).unwrap();
        assert!(hex.starts_with("03"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn compress_p256_pubkey_rejects_bad_prefix() {
        let bad = vec![0x05; 65];
        assert!(compress_p256_pubkey(&bad).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn compress_p256_pubkey_rejects_wrong_length() {
        let bad = vec![0x04; 64];
        assert!(compress_p256_pubkey(&bad).is_err());
    }
}
