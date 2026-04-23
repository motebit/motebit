package expo.modules.appattest

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android stub — Apple App Attest is iOS-only.
 *
 * Android's analog is Play Integrity (or, at a lower level,
 * StrongBox-attested keystore). That work lands as its own
 * metabolic leaf — `expo-play-integrity` + `@motebit/crypto-play-integrity`
 * — with a matching `HardwareAttestationClaim` platform value.
 *
 * Both commands here throw `not_supported` so the mint path degrades
 * cleanly to the Secure Enclave fallback, and then to a truthful
 * `platform: "software"` claim.
 */
class ExpoAppAttestModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoAppAttest")

    AsyncFunction("appAttestAvailable") {
      false
    }

    AsyncFunction("appAttestMint") { _: Map<String, Any?> ->
      throw CodedException(
        "not_supported",
        "App Attest is iOS-only; Play Integrity path is a follow-up",
        null
      )
    }
  }
}
