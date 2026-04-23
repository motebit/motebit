import CryptoKit
import ExpoModulesCore
import Foundation
import Security

/// Apple Secure Enclave attestation bridge for iOS.
///
/// Mints a hardware-backed ECDSA P-256 signature over a
/// JCS-canonicalized attestation-claim body. The Enclave generates a
/// fresh ephemeral keypair in-hardware, signs the message, and returns
/// the public key + DER signature. The private key never leaves the
/// Secure Enclave — `kSecAttrTokenIDSecureEnclave` is the
/// Apple-supported way to guarantee this.
///
/// Symmetric with `apps/desktop/src-tauri/src/secure_enclave.rs`:
///   - Same canonical-body shape (version, algorithm, motebit_id,
///     device_id, identity_public_key, se_public_key, attested_at)
///     with JCS field ordering (alphabetical keys).
///   - Same algorithm: ECDSA-P256-SHA256 over the canonical body
///     bytes.
///   - Same output: `(body_base64, signature_der_base64)` — TS
///     concatenates with "." to form the wire `attestation_receipt`.
///
/// Why ephemeral per-attestation (v1). Persisting SE keys across app
/// launches requires keychain-item lookup by application tag, biometric
/// / passcode ACLs, and per-device key-lifecycle management. That is a
/// second pass — matches the Rust desktop path's v1 shape exactly.
///
/// Failure taxonomy (matches the desktop bridge):
///   - `not_supported`     — simulator, pre-A7 hardware, or SE not
///                           reachable on this device.
///   - `permission_denied` — user declined a biometric / passcode
///                           challenge the SE required.
///   - `platform_blocked`  — anything else. The TS side degrades all
///                           three reasons to a `platform: "software"`
///                           claim — truthful, never deceptive.
public class ExpoSecureEnclaveModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoSecureEnclave")

    // MARK: - Availability probe

    /// Precise SE probe — attempts a throwaway key generation with
    /// `kSecAttrTokenIDSecureEnclave`. Returns true only when the OS
    /// actually hands back a usable SE-bound key; false on simulators,
    /// pre-A7 hardware, or any device where the token binding is
    /// rejected. This is stricter than the Rust desktop heuristic
    /// (`cfg!(target_os = "macos")`) — iOS simulators run on macOS but
    /// have no SE, so a platform check alone would lie.
    AsyncFunction("seAvailable") { () -> Bool in
      return SecureEnclaveProbe.available()
    }

    // MARK: - Atomic mint

    /// Atomic keygen → compose → sign. The key lifetime is scoped to
    /// one function call so a fresh key always names itself in the
    /// body it signs. This is the same contract the Rust desktop path
    /// makes — composing inside the native side avoids a bootstrapping
    /// round-trip for the v1 no-persistence case.
    ///
    /// Rejects with a structured `code` on failure so the TS shim can
    /// raise a typed `SecureEnclaveError` with the matching reason:
    ///   - "not_supported", "permission_denied", "platform_blocked".
    AsyncFunction("seMintAttestation") {
      (args: SeMintArgs, promise: Promise) -> Void in
      SecureEnclaveMinter.mint(args: args, promise: promise)
    }
  }
}

// MARK: - Argument record

/// Mirror of the TS call shape. ExpoModulesCore synthesizes the
/// JS-to-Swift conversion via the `Record` protocol.
public struct SeMintArgs: Record {
  @Field
  var motebitId: String = ""

  @Field
  var deviceId: String = ""

  @Field
  var identityPublicKeyHex: String = ""

  @Field
  var attestedAt: Double = 0
}

// MARK: - Availability probe

private enum SecureEnclaveProbe {
  /// True when a throwaway SE-bound P-256 key can be generated on this
  /// device. Implemented as a real probe rather than a hardware model
  /// lookup — the OS is the authority.
  static func available() -> Bool {
    #if targetEnvironment(simulator)
      return false
    #else
      var error: Unmanaged<CFError>?
      guard
        let access = SecAccessControlCreateWithFlags(
          kCFAllocatorDefault,
          kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
          [.privateKeyUsage],
          &error
        )
      else {
        return false
      }
      let attrs: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: false,
          kSecAttrAccessControl as String: access,
        ] as [String: Any],
      ]
      var createErr: Unmanaged<CFError>?
      guard SecKeyCreateRandomKey(attrs as CFDictionary, &createErr) != nil else {
        return false
      }
      return true
    #endif
  }
}

// MARK: - Atomic minter

private enum SecureEnclaveMinter {
  static func mint(args: SeMintArgs, promise: Promise) {
    #if targetEnvironment(simulator)
      promise.reject("not_supported", "Secure Enclave unavailable on simulator")
      return
    #else
      // 1. Generate an ephemeral SE-bound ECDSA P-256 key. The
      //    `kSecAttrTokenID = kSecAttrTokenIDSecureEnclave` attribute
      //    guarantees the private key never leaves the hardware.
      var accessErr: Unmanaged<CFError>?
      guard
        let access = SecAccessControlCreateWithFlags(
          kCFAllocatorDefault,
          kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
          [.privateKeyUsage],
          &accessErr
        )
      else {
        let msg = describeCFError(accessErr?.takeRetainedValue())
        promise.reject("platform_blocked", "se access control: \(msg)")
        return
      }

      let keyAttrs: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecAttrLabel as String: "com.motebit.attestation.ephemeral",
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: false,
          kSecAttrAccessControl as String: access,
        ] as [String: Any],
      ]

      var keygenErr: Unmanaged<CFError>?
      guard
        let privateKey = SecKeyCreateRandomKey(keyAttrs as CFDictionary, &keygenErr)
      else {
        let cfErr = keygenErr?.takeRetainedValue()
        let (code, msg) = classifyCFError(cfErr, context: "se key generate")
        promise.reject(code, msg)
        return
      }

      // 2. Pull the public key out. External representation is Apple's
      //    X9.62 uncompressed form: 0x04 || X || Y (65 bytes for P-256).
      guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
        promise.reject("platform_blocked", "SE key missing public half")
        return
      }
      var pubErr: Unmanaged<CFError>?
      guard
        let publicRep = SecKeyCopyExternalRepresentation(publicKey, &pubErr) as Data?
      else {
        let msg = describeCFError(pubErr?.takeRetainedValue())
        promise.reject("platform_blocked", "SE public key external representation: \(msg)")
        return
      }

      let sePublicKeyHex: String
      if let compressed = CompressP256.compress(uncompressed: publicRep) {
        sePublicKeyHex = compressed
      } else {
        // Fallback to uncompressed hex. The TS verifier
        // (`@motebit/crypto::verifyHardwareAttestationClaim`) accepts
        // both compressed and uncompressed via @noble/curves, so the
        // fallback is still correct — we just prefer compressed for
        // wire-size symmetry with the desktop path.
        sePublicKeyHex = publicRep.hexLowercase()
      }

      // 3. Compose the canonical body. Field order is JCS alphabetical:
      //    algorithm, attested_at, device_id, identity_public_key,
      //    motebit_id, se_public_key, version. Matches the Rust
      //    desktop path exactly so receipts are byte-identical across
      //    surfaces given the same inputs.
      let identityLower = args.identityPublicKeyHex.lowercased()
      let attestedAtInt = UInt64(args.attestedAt)
      let body = CanonicalBody.encode(
        attestedAt: attestedAtInt,
        deviceId: args.deviceId,
        identityPublicKey: identityLower,
        motebitId: args.motebitId,
        sePublicKey: sePublicKeyHex
      )
      guard let bodyBytes = body.data(using: .utf8) else {
        promise.reject("platform_blocked", "canonical body encoding failed")
        return
      }

      // 4. Sign via `.ecdsaSignatureMessageX962SHA256`. The algorithm
      //    takes raw message bytes, SHA-256s them internally, and
      //    returns a DER-encoded X9.62 signature — the exact shape
      //    `@motebit/crypto::verifyHardwareAttestationClaim` consumes.
      let alg: SecKeyAlgorithm = .ecdsaSignatureMessageX962SHA256
      guard
        SecKeyIsAlgorithmSupported(privateKey, .sign, alg)
      else {
        promise.reject("platform_blocked", "SE key does not support ecdsaSignatureMessageX962SHA256")
        return
      }

      var signErr: Unmanaged<CFError>?
      guard
        let sigDer = SecKeyCreateSignature(
          privateKey,
          alg,
          bodyBytes as CFData,
          &signErr
        ) as Data?
      else {
        let cfErr = signErr?.takeRetainedValue()
        let (code, msg) = classifyCFError(cfErr, context: "se sign")
        promise.reject(code, msg)
        return
      }

      // 5. base64url-no-pad both halves. The TS side assembles the
      //    receipt as `body_base64 + "." + signature_der_base64`.
      promise.resolve([
        "body_base64": bodyBytes.base64UrlEncodedNoPadString(),
        "signature_der_base64": sigDer.base64UrlEncodedNoPadString(),
      ])
    #endif
  }

  private static func describeCFError(_ err: CFError?) -> String {
    guard let err = err else { return "unknown" }
    return CFErrorCopyDescription(err) as String? ?? "unknown"
  }

  /// Map CFError debug text to the structured failure taxonomy. Mirrors
  /// `classify_sec_err` in `secure_enclave.rs` — same substring matches.
  private static func classifyCFError(
    _ err: CFError?,
    context: String
  ) -> (code: String, message: String) {
    let desc = describeCFError(err).lowercased()
    let msg = "\(context): \(describeCFError(err))"
    if desc.contains("usercancel") || desc.contains("authfailed") || desc.contains("biometry") {
      return ("permission_denied", msg)
    }
    if desc.contains("tokennotfound") || desc.contains("no such token") {
      return ("not_supported", msg)
    }
    return ("platform_blocked", msg)
  }
}

// MARK: - Canonical JSON body

private enum CanonicalBody {
  /// Produce the JCS-canonical JSON body string with alphabetically
  /// ordered keys. Mirrors `canonical_body` in `secure_enclave.rs`.
  /// Manual string assembly is deliberate — `JSONEncoder` does not
  /// guarantee key ordering across Swift versions, and the TS
  /// verifier re-canonicalizes with JCS, so any drift here breaks
  /// signature verification. The json_string escaper covers every
  /// JSON-required escape sequence; motebit IDs / device IDs / hex
  /// keys are ASCII-safe in practice but the escaper is
  /// defense-in-depth.
  static func encode(
    attestedAt: UInt64,
    deviceId: String,
    identityPublicKey: String,
    motebitId: String,
    sePublicKey: String
  ) -> String {
    // Alphabetical: algorithm, attested_at, device_id,
    // identity_public_key, motebit_id, se_public_key, version.
    return
      "{\"algorithm\":\"ecdsa-p256-sha256\""
      + ",\"attested_at\":\(attestedAt)"
      + ",\"device_id\":\(jsonString(deviceId))"
      + ",\"identity_public_key\":\(jsonString(identityPublicKey))"
      + ",\"motebit_id\":\(jsonString(motebitId))"
      + ",\"se_public_key\":\(jsonString(sePublicKey))"
      + ",\"version\":\"1\"}"
  }

  /// JSON-conformant string literal with the required escape sequences.
  /// ASCII control characters are emitted as \uXXXX.
  private static func jsonString(_ s: String) -> String {
    var out = "\""
    out.reserveCapacity(s.count + 2)
    for scalar in s.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    out += "\""
    return out
  }
}

// MARK: - P-256 public-key compression

private enum CompressP256 {
  /// Compress an X9.62 uncompressed P-256 public key (65 bytes,
  /// `04 || X || Y`) to the compressed form (`02/03 || X`) as 33-byte
  /// hex. Returns nil on malformed input so the caller can fall back
  /// to uncompressed hex.
  static func compress(uncompressed: Data) -> String? {
    guard uncompressed.count == 65 else { return nil }
    let bytes = [UInt8](uncompressed)
    guard bytes[0] == 0x04 else { return nil }
    // y[31] is the least-significant byte of Y (big-endian). Its
    // low bit determines the compressed prefix: even → 0x02, odd → 0x03.
    let lastY = bytes[64]
    let prefix: UInt8 = (lastY & 0x01) == 0 ? 0x02 : 0x03
    var out = Data(capacity: 33)
    out.append(prefix)
    out.append(contentsOf: bytes[1...32])
    return out.hexLowercase()
  }
}

// MARK: - Encoding helpers

extension Data {
  /// Lowercase hex encoding (no prefix). Motebit wire format is
  /// lowercase throughout; canonical JSON re-canonicalization is
  /// case-sensitive on hex strings.
  fileprivate func hexLowercase() -> String {
    return self.map { String(format: "%02x", $0) }.joined()
  }

  /// base64url, no padding. Matches Rust's `URL_SAFE_NO_PAD` and JS's
  /// `toBase64Url` in `@motebit/crypto`.
  fileprivate func base64UrlEncodedNoPadString() -> String {
    let base64 = self.base64EncodedString()
    return
      base64
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
