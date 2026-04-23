import CryptoKit
import DeviceCheck
import ExpoModulesCore
import Foundation

/// Apple App Attest attestation bridge for iOS.
///
/// Mints a hardware-attested keypair via `DCAppAttestService`, signs a
/// challenge derived from motebit's canonical attestation body, and
/// returns the CBOR attestation object + keyId + clientDataHash. The
/// caller (TS shim) assembles those three base64url segments into the
/// `attestation_receipt` wire format `@motebit/crypto-appattest`
/// consumes.
///
/// Symmetric with `apps/mobile/modules/expo-secure-enclave/ios/` — same
/// command shape, same error taxonomy (`not_supported`,
/// `permission_denied`, `platform_blocked`), same atomic-mint contract.
/// Private keys never leave the Secure Enclave; App Attest keys
/// additionally carry an Apple-signed attestation certificate chain.
///
/// Why a separate module from ExpoSecureEnclave: App Attest keys are
/// managed by DCAppAttestService (separate API surface), carry an Apple
/// attestation chain (separate verifier, in `@motebit/crypto-appattest`),
/// and require the App Attest entitlement. Treating them as a distinct
/// metabolic leaf keeps each surface orthogonal.
public class ExpoAppAttestModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoAppAttest")

    // MARK: - Availability probe

    /// Is App Attest supported on this device?
    ///
    /// DCAppAttestService gates on device hardware (A11 or later) and
    /// iOS version. Returns `false` on simulator, older hardware, and
    /// Android.
    AsyncFunction("appAttestAvailable") { () -> Bool in
      return DCAppAttestService.shared.isSupported
    }

    // MARK: - Atomic attest

    /// Atomic keygen → compose clientDataHash → attest.
    ///
    /// Rejects with structured `code` on failure:
    ///   - "not_supported"     — App Attest unavailable on this device.
    ///   - "permission_denied" — user declined a privacy prompt.
    ///   - "platform_blocked"  — anything else (Apple error, network
    ///                           blip, entitlement missing, OOM).
    AsyncFunction("appAttestMint") {
      (args: AppAttestArgs, promise: Promise) -> Void in
      AppAttestMinter.mint(args: args, promise: promise)
    }
  }
}

// MARK: - Argument record

/// Mirror of the TS call shape. The `clientDataBody` is the
/// JCS-canonicalized attestation body motebit would otherwise sign with
/// the Secure Enclave — here it's hashed and passed as App Attest's
/// per-attestation nonce (the "clientDataHash" in WebAuthn terms).
public struct AppAttestArgs: Record {
  public init() {}

  @Field
  var motebitId: String = ""

  @Field
  var deviceId: String = ""

  @Field
  var identityPublicKeyHex: String = ""

  @Field
  var attestedAt: Double = 0
}

// MARK: - Minter

private enum AppAttestMinter {
  static func mint(args: AppAttestArgs, promise: Promise) {
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      promise.reject("not_supported", "DCAppAttestService.isSupported == false on this device")
      return
    }

    // 1. Compose the same canonical body ExpoSecureEnclave would —
    //    byte-identical field ordering and JCS so a future migration
    //    from AppAttest-only to AppAttest+SE doesn't fork the body
    //    shape.
    let body = CanonicalBody.encode(
      attestedAt: UInt64(args.attestedAt),
      deviceId: args.deviceId,
      identityPublicKey: args.identityPublicKeyHex.lowercased(),
      motebitId: args.motebitId
    )
    guard let bodyBytes = body.data(using: .utf8) else {
      promise.reject("platform_blocked", "canonical body encoding failed")
      return
    }
    let clientDataHash = Data(SHA256.hash(data: bodyBytes))

    // 2. Generate an App Attest keypair. The hardware binds the private
    //    key to this exact app; Apple's CA attests the leaf at mint.
    service.generateKey { keyId, error in
      guard let keyId = keyId, error == nil else {
        let (code, msg) = classifyError(error, context: "generateKey")
        promise.reject(code, msg)
        return
      }

      // 3. Attest the key against the clientDataHash. Apple returns a
      //    CBOR-encoded attestation object whose x5c chains to the
      //    Apple App Attestation Root CA (pinned by the verifier in
      //    @motebit/crypto-appattest). authData.rpIdHash binds the
      //    app's bundle ID; the leaf's 1.2.840.113635.100.8.2
      //    extension binds SHA256(authData || clientDataHash).
      service.attestKey(keyId, clientDataHash: clientDataHash) { attestation, attErr in
        guard let attestation = attestation, attErr == nil else {
          let (code, msg) = classifyError(attErr, context: "attestKey")
          promise.reject(code, msg)
          return
        }

        promise.resolve([
          "attestation_object_base64": attestation.base64UrlEncodedNoPadString(),
          "key_id_base64": Data(base64Encoded: keyId)?.base64UrlEncodedNoPadString()
            ?? keyId,  // keyId is already base64 string from Apple's API
          "client_data_hash_base64": clientDataHash.base64UrlEncodedNoPadString(),
        ])
      }
    }
  }

  /// Apple's DCError taxonomy maps cleanly onto motebit's three-reason
  /// failure shape. Unknown errors degrade to `platform_blocked`.
  private static func classifyError(
    _ error: Error?,
    context: String
  ) -> (code: String, message: String) {
    guard let err = error as NSError? else {
      return ("platform_blocked", "\(context): unknown error")
    }
    let msg = "\(context): \(err.localizedDescription)"
    // DCError domain codes: 0=unknownSystemFailure, 1=invalidInput,
    // 2=invalidKey, 3=serverUnavailable, 4=featureUnsupported.
    if err.domain == DCError.errorDomain {
      switch err.code {
      case DCError.featureUnsupported.rawValue:
        return ("not_supported", msg)
      default:
        return ("platform_blocked", msg)
      }
    }
    return ("platform_blocked", msg)
  }
}

// MARK: - Canonical JSON body

private enum CanonicalBody {
  /// JCS-canonical body with alphabetically-ordered keys. Byte-identical
  /// to the Secure Enclave body minus `se_public_key` / `algorithm`
  /// (those two fields describe how the SE signs; App Attest signs the
  /// clientDataHash through Apple's attestation chain, not through a
  /// motebit-composed ECDSA signature, so they are not part of the body
  /// under attestation here).
  static func encode(
    attestedAt: UInt64,
    deviceId: String,
    identityPublicKey: String,
    motebitId: String
  ) -> String {
    return
      "{\"attested_at\":\(attestedAt)"
      + ",\"device_id\":\(jsonString(deviceId))"
      + ",\"identity_public_key\":\(jsonString(identityPublicKey))"
      + ",\"motebit_id\":\(jsonString(motebitId))"
      + ",\"platform\":\"device_check\""
      + ",\"version\":\"1\"}"
  }

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

// MARK: - Encoding helpers

extension Data {
  fileprivate func base64UrlEncodedNoPadString() -> String {
    let base64 = self.base64EncodedString()
    return
      base64
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

extension String {
  fileprivate func base64UrlEncodedNoPadString() -> String {
    guard let data = Data(base64Encoded: self) else { return self }
    return data.base64UrlEncodedNoPadString()
  }
}
