package expo.modules.playintegrity

import android.util.Base64
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.security.MessageDigest

/**
 * Google Play Integrity attestation bridge for Android.
 *
 * Mints a Play Integrity JWT via `IntegrityManager.requestIntegrityToken`
 * and returns it verbatim. The JWT is the wire `attestation_receipt` —
 * the caller (TS shim) passes it directly through; the verifier
 * (`@motebit/crypto-play-integrity`) parses the JWT, looks up the
 * signing key in the pinned Google JWKS, verifies the signature, and
 * byte-compares the payload's `nonce` against
 * `base64url(SHA256(canonicalBody))`.
 *
 * The `canonicalBody` is composed here in Kotlin with byte-identical
 * JCS ordering to the TS `canonicalJson` call in
 * `packages/crypto-play-integrity/src/verify.ts`. If the two diverge,
 * the verifier's nonce derivation fails — so this file is the
 * load-bearing sibling of the verifier's body-reconstruction step.
 *
 * Symmetric with `apps/mobile/modules/expo-app-attest/` — same command
 * shape, same error taxonomy (`not_supported`, `permission_denied`,
 * `platform_blocked`), same atomic-mint contract.
 */
class ExpoPlayIntegrityModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoPlayIntegrity")

    // ─── Availability probe ────────────────────────────────────────
    //
    // The SDK's availability is best detected by attempting
    // `IntegrityManagerFactory.create(context)`. Failure (Google Play
    // Services missing, Play Store not installed, OEM without Google
    // services) raises an exception we trap as `false`.
    AsyncFunction("playIntegrityAvailable") {
      return@AsyncFunction try {
        val context = appContext.reactContext
        if (context == null) {
          false
        } else {
          IntegrityManagerFactory.create(context)
          true
        }
      } catch (_: Throwable) {
        false
      }
    }

    // ─── Atomic mint ───────────────────────────────────────────────
    AsyncFunction("playIntegrityMint") { args: PlayIntegrityArgs, promise: Promise ->
      PlayIntegrityMinter.mint(args, promise, appContext.reactContext)
    }
  }
}

/// Mirror of the TS call shape. `attestedAt` arrives as a JS number —
/// Kotlin `Double` preserves integer-ms values up to 2^53 safely.
class PlayIntegrityArgs : Record {
  @Field var motebitId: String = ""
  @Field var deviceId: String = ""
  @Field var identityPublicKeyHex: String = ""
  @Field var attestedAt: Double = 0.0
}

private object PlayIntegrityMinter {
  fun mint(args: PlayIntegrityArgs, promise: Promise, context: android.content.Context?) {
    if (context == null) {
      promise.reject(CodedException("platform_blocked", "Android context unavailable", null))
      return
    }

    // Compose the byte-identical canonical body the verifier re-derives
    // at check time (see `packages/crypto-play-integrity/src/verify.ts`
    // step 4). JCS-canonical: alphabetical key order, no whitespace,
    // JSON-escaped strings, numbers as JSON numbers.
    val body = CanonicalBody.encode(
      attestedAt = args.attestedAt.toLong(),
      deviceId = args.deviceId,
      identityPublicKey = args.identityPublicKeyHex.lowercase(),
      motebitId = args.motebitId
    )
    val digest = MessageDigest.getInstance("SHA-256").digest(body.toByteArray(Charsets.UTF_8))
    val nonce = Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    try {
      val manager = IntegrityManagerFactory.create(context)
      val request = IntegrityTokenRequest.builder().setNonce(nonce).build()
      manager.requestIntegrityToken(request)
        .addOnSuccessListener { response ->
          val map = hashMapOf<String, Any>(
            "jwt" to response.token(),
            "nonce_base64url" to nonce
          )
          promise.resolve(map)
        }
        .addOnFailureListener { err ->
          promise.reject(classifyError(err))
        }
    } catch (err: Throwable) {
      promise.reject(classifyError(err))
    }
  }

  /// Play Integrity surfaces a mix of `IntegrityErrorCode`-bearing
  /// `ApiException`s and plain `Throwable`s. The three-reason shape
  /// motebit uses degrades every unmapped code to `platform_blocked`
  /// — that is the truthful answer at this layer. Finer-grained
  /// classification (e.g. mapping `CANNOT_BIND_TO_SERVICE` to a
  /// retryable reason) is a future pass; today's mint path treats all
  /// errors as "fall back to software."
  private fun classifyError(err: Throwable): CodedException {
    return CodedException(
      "platform_blocked",
      "play_integrity: ${err.javaClass.simpleName}: ${err.message ?: "<no message>"}",
      err
    )
  }
}

/// Byte-identical JCS encoder for the attestation body. Must match
/// `canonicalJson(...)` in `packages/crypto-play-integrity/src/verify.ts`
/// for the keys we emit: alphabetical key order, no whitespace,
/// RFC-8259 string escaping.
private object CanonicalBody {
  fun encode(
    attestedAt: Long,
    deviceId: String,
    identityPublicKey: String,
    motebitId: String
  ): String {
    return buildString {
      append("{\"attested_at\":").append(attestedAt)
      append(",\"device_id\":").append(jsonString(deviceId))
      append(",\"identity_public_key\":").append(jsonString(identityPublicKey))
      append(",\"motebit_id\":").append(jsonString(motebitId))
      append(",\"platform\":\"play_integrity\"")
      append(",\"version\":\"1\"}")
    }
  }

  private fun jsonString(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (ch in s) {
      when {
        ch == '"' -> sb.append("\\\"")
        ch == '\\' -> sb.append("\\\\")
        ch == '\n' -> sb.append("\\n")
        ch == '\r' -> sb.append("\\r")
        ch == '\t' -> sb.append("\\t")
        ch.code < 0x20 -> sb.append(String.format("\\u%04x", ch.code))
        else -> sb.append(ch)
      }
    }
    sb.append('"')
    return sb.toString()
  }
}
