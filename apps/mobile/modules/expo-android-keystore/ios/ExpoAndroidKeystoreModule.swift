import ExpoModulesCore
import Foundation

/// iOS stub — Android Keystore Attestation is Android-only.
///
/// On iOS the hardware-attestation surface is Apple App Attest (see
/// `apps/mobile/modules/expo-app-attest/ios/ExpoAppAttestModule.swift`).
/// Both commands here reject with `not_supported` so the shared mobile
/// mint path degrades cleanly — the Android Keystore path never fires
/// on iOS because `androidKeystoreAvailable` returns `false`, and even
/// if it did, `androidKeystoreMint` would reject with the same code
/// the TS shim's error taxonomy handles.
public class ExpoAndroidKeystoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoAndroidKeystore")

    AsyncFunction("androidKeystoreAvailable") { () -> Bool in
      return false
    }

    AsyncFunction("androidKeystoreMint") {
      (_: AndroidKeystoreArgs, promise: Promise) -> Void in
      promise.reject(
        "not_supported",
        "Android Keystore Attestation is Android-only; iOS mint path lives in ExpoAppAttest"
      )
    }
  }
}

/// Mirror of the TS call shape — kept so the Swift-side Record field
/// decoding succeeds even on the reject path (Expo decodes the
/// argument record before the function body runs).
public struct AndroidKeystoreArgs: Record {
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
