package expo.modules.secureenclave

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android stub — the Apple Secure Enclave does not exist on Android.
 *
 * Hardware-rooted identity on Android lands behind Play Integrity (and
 * optionally StrongBox-attested keystore) in a subsequent pass; the
 * primitive is identical — a `HardwareAttestationClaim` with a
 * `platform: "play_integrity"` (or `"android_keystore"`) value and an
 * `attestation_receipt`. Until that pass lands, both commands here
 * throw `not_supported` so the mobile mint path degrades to a
 * truthful `platform: "software"` claim — exactly the desktop
 * fallback behaviour on non-macOS hosts.
 *
 * The stub exists so the Expo module loads on Android without a
 * "module not found" error; the TS shim handles the rejection and
 * maps it to the shared `SecureEnclaveError` taxonomy.
 */
class ExpoSecureEnclaveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoSecureEnclave")

    AsyncFunction("seAvailable") {
      // Honest report: no SE on Android. A future pass may wire this
      // to a StrongBox probe; today the answer is always false.
      false
    }

    AsyncFunction("seMintAttestation") { _: Map<String, Any?> ->
      throw CodedException(
        "not_supported",
        "Secure Enclave is iOS-only; Play Integrity / StrongBox path is a follow-up",
        null
      )
    }
  }
}
