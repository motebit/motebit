package expo.modules.androidkeystore

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec

/**
 * Android Hardware-Backed Keystore Attestation bridge.
 *
 * Replaces `ExpoPlayIntegrity` as the canonical Android mint path. The
 * verifier (`@motebit/crypto-android-keystore`) chain-validates the
 * cert chain emitted here against Google's published Hardware
 * Attestation roots — the architecturally-correct sovereign-verifiable
 * Android primitive (vs Play Integrity's per-app-key,
 * network-mediated verification path that was never publicly third-
 * party verifiable).
 *
 * Mint flow:
 *
 *   1. Compose the byte-identical canonical body the verifier
 *      re-derives at check time (see
 *      `packages/crypto-android-keystore/src/verify.ts` step 5):
 *      JCS-canonical alphabetical key order, no whitespace,
 *      JSON-escaped strings.
 *   2. SHA-256 the body to produce the `attestationChallenge` byte
 *      array.
 *   3. Generate an ECDSA P-256 keypair inside the AndroidKeyStore
 *      provider with `setAttestationChallenge(challenge)`. The TEE /
 *      StrongBox hardware backend signs the cert chain that binds the
 *      challenge to the new keypair.
 *   4. Read the cert chain from the Keystore, drop the root cert (the
 *      verifier supplies it from pinned anchors), encode leaf-first
 *      as `{leafB64}.{intermediatesJoinedB64}` per motebit's wire
 *      format.
 *
 * Symmetric with `apps/mobile/modules/expo-app-attest/` and
 * `apps/mobile/modules/expo-secure-enclave/` — same command shape,
 * same error taxonomy (`not_supported`, `permission_denied`,
 * `platform_blocked`), same atomic-mint contract.
 *
 * Why ECDSA P-256 (not Ed25519): hardware-backed Ed25519 is not
 * supported by AndroidKeyStore as of KeyMint 4. ECDSA P-256 is
 * universal, hardware-backed on every modern Android device, and
 * matches the pattern App Attest already uses — the hardware attestor
 * key attests the Ed25519 identity key via challenge binding rather
 * than replacing it. (See `docs/doctrine/hardware-attestation.md`
 * § "Hierarchical, never replacement".)
 */
class ExpoAndroidKeystoreModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoAndroidKeystore")

    // ─── Availability probe ────────────────────────────────────────
    //
    // `KeyStore.getInstance("AndroidKeyStore")` succeeds on every
    // Android API ≥ 18. The hardware-backing gate (TEE vs software-
    // only) is enforced by the VERIFIER reading
    // `attestationSecurityLevel` off the leaf — software-only
    // attestations are rejected at the canonical motebit floor. So
    // the TS-side cascade only needs to know "is the Keystore
    // surface present at all," which is true everywhere.
    //
    // `setAttestationChallenge` itself requires API ≥ 24 (Keymaster
    // 3+); older devices fail at mint time and degrade to software.
    AsyncFunction("androidKeystoreAvailable") {
      return@AsyncFunction try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
          false
        } else {
          KeyStore.getInstance("AndroidKeyStore").load(null)
          true
        }
      } catch (_: Throwable) {
        false
      }
    }

    // ─── Atomic mint ───────────────────────────────────────────────
    AsyncFunction("androidKeystoreMint") { args: AndroidKeystoreArgs, promise: Promise ->
      AndroidKeystoreMinter.mint(args, promise)
    }
  }
}

/// Mirror of the TS call shape. `attestedAt` arrives as a JS number —
/// Kotlin `Double` preserves integer-ms values up to 2^53 safely.
class AndroidKeystoreArgs : Record {
  @Field var motebitId: String = ""
  @Field var deviceId: String = ""
  @Field var identityPublicKeyHex: String = ""
  @Field var attestedAt: Double = 0.0
}

private object AndroidKeystoreMinter {
  private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
  private const val ALIAS_PREFIX = "motebit-attestor-"

  fun mint(args: AndroidKeystoreArgs, promise: Promise) {
    try {
      val body = CanonicalBody.encode(
        attestedAt = args.attestedAt.toLong(),
        deviceId = args.deviceId,
        identityPublicKey = args.identityPublicKeyHex.lowercase(),
        motebitId = args.motebitId
      )
      val challenge = MessageDigest.getInstance("SHA-256")
        .digest(body.toByteArray(Charsets.UTF_8))
      val challengeB64 = Base64.encodeToString(
        challenge,
        Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
      )

      // Per-motebit alias keeps multiple identities on the same device
      // separable. Generating with the same alias overwrites — fine,
      // because the attestation cert is a one-shot artifact and the
      // challenge changes per mint.
      val alias = ALIAS_PREFIX + args.motebitId

      val keyPairGenerator = KeyPairGenerator.getInstance(
        KeyProperties.KEY_ALGORITHM_EC,
        KEYSTORE_PROVIDER
      )
      val spec = KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_SIGN
      )
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setAttestationChallenge(challenge)
        .build()
      keyPairGenerator.initialize(spec)
      keyPairGenerator.generateKeyPair()

      val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER)
      keyStore.load(null)
      val chain: Array<java.security.cert.Certificate>? = keyStore.getCertificateChain(alias)
      if (chain == null || chain.isEmpty()) {
        promise.reject(CodedException(
          "platform_blocked",
          "Keystore returned empty certificate chain for alias $alias",
          null
        ))
        return
      }

      // Drop the root cert (verifier supplies it from pinned anchors)
      // and encode leaf-first per motebit's wire format. If the chain
      // has only one cert (rare — a self-signed leaf), keep it as the
      // leaf and emit an empty intermediates segment.
      val chainList = chain.toList()
      val chainNoRoot = if (chainList.size > 1) chainList.dropLast(1) else chainList
      val leafB64 = b64url(chainNoRoot[0].encoded)
      val intermediatesB64 = if (chainNoRoot.size > 1) {
        chainNoRoot.drop(1).joinToString(",") { b64url(it.encoded) }
      } else {
        ""
      }
      val receipt = "$leafB64.$intermediatesB64"

      // Sanity-check: the leaf must carry the AOSP Key Attestation
      // extension (OID 1.3.6.1.4.1.11129.2.1.17). Absence means the
      // device emitted a software-attested chain (no TEE backing).
      // We don't FAIL here — the verifier's
      // `attestation_extension_valid` check is the canonical gate.
      // But we surface the absence as a structured warning so the
      // caller's logs make the cause visible.
      val leafX509 = chainNoRoot[0] as? X509Certificate
      if (leafX509 != null && leafX509.getExtensionValue("1.3.6.1.4.1.11129.2.1.17") == null) {
        // Surface to logcat — caller cascade will degrade to software
        // when the verifier rejects. Don't reject here; the verifier
        // is the canonical gate.
        android.util.Log.w(
          "ExpoAndroidKeystore",
          "leaf cert lacks AOSP Key Attestation extension — likely software-only attestation; verifier will reject"
        )
      }

      promise.resolve(hashMapOf<String, Any>(
        "receipt" to receipt,
        "challenge_base64url" to challengeB64
      ))
    } catch (err: Throwable) {
      promise.reject(classifyError(err))
    }
  }

  /// AndroidKeyStore raises `KeyStoreException`, `ProviderException`,
  /// `InvalidAlgorithmParameterException`, etc. The three-reason shape
  /// motebit uses degrades every unmapped error to `platform_blocked`
  /// — the truthful answer at this layer. Finer-grained classification
  /// (e.g. mapping `KeyPermanentlyInvalidatedException` to a retryable
  /// reason) is a future pass.
  private fun classifyError(err: Throwable): CodedException {
    return CodedException(
      "platform_blocked",
      "android_keystore: ${err.javaClass.simpleName}: ${err.message ?: "<no message>"}",
      err
    )
  }

  private fun b64url(bytes: ByteArray): String {
    return Base64.encodeToString(
      bytes,
      Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
    )
  }
}

/// Byte-identical JCS encoder for the attestation body. Must match
/// `buildCanonicalAttestationBody(...)` in
/// `packages/crypto-android-keystore/src/verify.ts` for the keys we
/// emit: alphabetical key order, no whitespace, RFC-8259 string
/// escaping, `platform: "android_keystore"`, `version: "1"`.
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
      append(",\"platform\":\"android_keystore\"")
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
