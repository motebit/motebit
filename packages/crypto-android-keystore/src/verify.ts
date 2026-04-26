/**
 * Android Hardware-Backed Keystore Attestation verifier — the core
 * judgment function this package exports.
 *
 * Flow (matches Google's published verification recipe at
 * https://source.android.com/docs/security/features/keystore/attestation,
 * plus the motebit-specific identity-key binding step):
 *
 *   1. Split the receipt into the leaf cert plus the rest of the chain
 *      (`{leafCertB64}.{intermediatesJoinedB64}` — comma-joined leaf-
 *      proximal-first base64url DER blobs in the second segment).
 *   2. Parse the chain as X.509 certificates. Walk the chain leaf →
 *      intermediates → terminal anchor with `@peculiar/x509`'s
 *      `X509ChainBuilder`. Every non-leaf must carry
 *      `basicConstraints.cA === true`. Every signature must verify
 *      under its issuer's public key. Every cert must be within its
 *      validity window. The terminal cert's DER must equal one of the
 *      pinned Google attestation roots.
 *   3. Read the Android Key Attestation extension (OID
 *      `1.3.6.1.4.1.11129.2.1.17`) from the LEAF cert only. The AOSP
 *      spec is explicit that later occurrences of this extension up
 *      the chain MUST be ignored — only the leaf's copy carries
 *      trustworthy data, because only the leaf is signed by the
 *      device's secure-hardware key.
 *   4. Constrain the parsed `KeyDescription`:
 *        - `attestationSecurityLevel ≥ TRUSTED_ENVIRONMENT` (rejects
 *           software-only fallback, which is structurally not
 *           third-party meaningful)
 *        - `attestationVersion ≥ 3` (rejects pre-Android-7 / Keymaster
 *           v2; current production is 4 / Keymaster 4 through 400 /
 *           KeyMint 4.0)
 *        - `hardwareEnforced.rootOfTrust.verifiedBootState` is in the
 *           caller's allowlist (default: VERIFIED only)
 *        - `hardwareEnforced.attestationApplicationId` byte-equals
 *           the caller's expected package binding
 *        - leaf's serial number is not in the caller-supplied
 *           revocation snapshot
 *   5. Cryptographically bind the leaf's `attestationChallenge` field
 *      to the motebit Ed25519 identity: re-derive
 *      `SHA-256(canonicalJson({ attested_at, device_id,
 *       identity_public_key, motebit_id, platform: "android_keystore",
 *       version: "1" }))` and byte-compare against the transmitted
 *      challenge. A malicious client that substitutes any other body
 *      fails here.
 *
 * Pure. No network. No filesystem. Deterministic given `now()` and
 * the caller-supplied revocation snapshot.
 */

import * as x509 from "@peculiar/x509";

import type { HardwareAttestationClaim } from "@motebit/protocol";

import {
  ANDROID_KEY_ATTESTATION_OID,
  DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS,
} from "./google-roots.js";
import {
  parseKeyDescription,
  SECURITY_LEVEL_TRUSTED_ENVIRONMENT,
  VERIFIED_BOOT_STATE_VERIFIED,
  type KeyDescription,
} from "./asn1.js";

/**
 * Caller-supplied revocation snapshot keyed by lowercase-hex serial
 * number — mirrors Google's published shape at
 * https://android.googleapis.com/attestation/status. The motebit
 * verifier never fetches this at runtime; the canonical CLI in
 * `@motebit/verify` ships an embedded snapshot at release time and
 * accepts an override path. Empty snapshot is the no-revocation-data
 * default and means every leaf passes the revocation check.
 */
export interface AndroidKeystoreRevocationSnapshot {
  readonly entries: Readonly<
    Record<
      string,
      {
        readonly status: "REVOKED" | "SUSPENDED";
        readonly reason?: string;
      }
    >
  >;
}

/** Empty revocation snapshot — every leaf passes the revocation check. */
export const EMPTY_REVOCATION_SNAPSHOT: AndroidKeystoreRevocationSnapshot = { entries: {} };

export interface AndroidKeystoreVerifyOptions {
  /**
   * Android package name + signing-cert SHA-256 hash binding the
   * leaf's `attestationApplicationId` MUST match. The expected value
   * is the byte-identical encoding the Kotlin mint path produces —
   * either a raw OCTET STRING capture or a wrapped representation,
   * depending on the surface. Implementations typically supply the
   * raw bytes captured at registration time.
   */
  readonly expectedAttestationApplicationId: Uint8Array;
  /**
   * Ed25519 identity key (lowercase hex) the motebit VC claims. The
   * leaf's `attestationChallenge` MUST bind this key (via the
   * canonical-body re-derivation).
   */
  readonly expectedIdentityPublicKeyHex: string;
  /**
   * motebit_id from the credential subject. Participates in the JCS
   * canonical body re-derived here and byte-compared against the
   * transmitted challenge.
   */
  readonly expectedMotebitId?: string;
  /** device_id from the credential subject. Same binding role. */
  readonly expectedDeviceId?: string;
  /** `attested_at` (unix ms) from the credential subject. Same binding role. */
  readonly expectedAttestedAt?: number;
  /**
   * Override the pinned trust anchors. Tests fabricate their own root
   * so chain verification exercises the same code path without needing
   * a real device-signed leaf. Defaults to
   * `DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS` (RSA + ECDSA P-384).
   */
  readonly rootPems?: readonly string[];
  /**
   * Allowlist of `verifiedBootState` ENUMERATED values the verifier
   * accepts. Default = `[VERIFIED]` (Google-signed bootloader). Set
   * to `[VERIFIED, SELF_SIGNED]` to allow GrapheneOS-style
   * user-installed roots-of-trust per their published attestation
   * compatibility model. Empty array = accept any state (NOT
   * recommended — leaks the boot-image guarantee).
   */
  readonly verifiedBootStateAllowlist?: readonly number[];
  /**
   * Minimum `attestationSecurityLevel` the verifier accepts. Default =
   * `TRUSTED_ENVIRONMENT` (1). Software-only attestations (level 0)
   * are structurally not third-party meaningful and are rejected.
   * StrongBox (2) is a higher score in the semiring, not an admission
   * gate — pass `TRUSTED_ENVIRONMENT` here and let the score-side
   * code differentiate.
   */
  readonly minSecurityLevel?: number;
  /**
   * Minimum `attestationVersion` the verifier accepts. Default = 3
   * (Keymaster 3 / Android 7 — earliest version with the modern chain
   * shape). Anything below this is rejected.
   */
  readonly minAttestationVersion?: number;
  /**
   * Caller-supplied revocation snapshot. Defaults to empty (no
   * revocation enforcement). Production callers should supply
   * Google's status-list shape; `@motebit/verify` ships an embedded
   * snapshot at release time.
   */
  readonly revocationSnapshot?: AndroidKeystoreRevocationSnapshot;
  /** Clock for chain-validity checks. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface AndroidKeystoreVerifyError {
  readonly message: string;
}

export interface AndroidKeystoreVerifyResult {
  readonly valid: boolean;
  readonly cert_chain_valid: boolean;
  /**
   * True when the leaf carried a parseable Key Attestation extension
   * AND every constraint check (security level, attestation version,
   * verified-boot state, application-ID match, revocation lookup)
   * passed.
   */
  readonly attestation_extension_valid: boolean;
  /**
   * True when `attestationChallenge` byte-equals
   * `SHA256(canonical body)` for the caller-supplied identity.
   */
  readonly identity_bound: boolean;
  /**
   * The `attestationSecurityLevel` parsed off the leaf (or null if
   * the extension wasn't parseable). Exposed so callers can surface
   * `TRUSTED_ENVIRONMENT` vs `STRONG_BOX` in an audit UI alongside
   * the pass/fail verdict — and so a routing semiring can score
   * StrongBox higher than plain TEE.
   */
  readonly attestation_security_level: number | null;
  /**
   * The `verifiedBootState` parsed off the leaf's `rootOfTrust` (or
   * null if absent / extension unparseable). Same audit-surface
   * rationale as `attestation_security_level`.
   */
  readonly verified_boot_state: number | null;
  readonly errors: readonly AndroidKeystoreVerifyError[];
}

/**
 * Android Hardware-Backed Keystore Attestation verifier.
 *
 * `claim.attestation_receipt` is the cert chain encoded as
 * `{leafCertB64}.{intermediatesJoinedB64}` — leaf-first DER chain
 * matching the wire format the Kotlin `expo-android-keystore` mint
 * path emits. The intermediates segment is a comma-joined list of
 * base64url-encoded DERs in leaf-proximal-first order; an empty
 * second segment means the leaf chains directly to a pinned root.
 */
export async function verifyAndroidKeystoreAttestation(
  claim: HardwareAttestationClaim,
  opts: AndroidKeystoreVerifyOptions,
): Promise<AndroidKeystoreVerifyResult> {
  const errors: AndroidKeystoreVerifyError[] = [];
  let cert_chain_valid = false;
  let attestation_extension_valid = false;
  let identity_bound = false;
  let attestation_security_level: number | null = null;
  let verified_boot_state: number | null = null;

  if (!claim.attestation_receipt) {
    errors.push({ message: "android_keystore claim missing `attestation_receipt`" });
    return finalize();
  }

  const parts = claim.attestation_receipt.split(".");
  if (parts.length !== 2) {
    errors.push({
      message: `attestation_receipt must be 2 base64url parts (leafCert.intermediates); got ${parts.length}`,
    });
    return finalize();
  }
  const [leafB64, intermediatesB64] = parts as [string, string];

  let leafBytes: Uint8Array;
  let intermediatesBytes: Uint8Array[];
  try {
    leafBytes = fromBase64Url(leafB64);
    intermediatesBytes =
      intermediatesB64.length === 0 ? [] : intermediatesB64.split(",").map((p) => fromBase64Url(p));
  } catch (err) {
    errors.push({ message: `base64url decode failed: ${messageOf(err)}` });
    return finalize();
  }

  let leaf: x509.X509Certificate;
  let intermediates: x509.X509Certificate[];
  let rootCerts: x509.X509Certificate[];
  try {
    leaf = new x509.X509Certificate(toArrayBuffer(leafBytes));
    intermediates = intermediatesBytes.map((b) => new x509.X509Certificate(toArrayBuffer(b)));
    const pems = opts.rootPems ?? DEFAULT_ANDROID_KEYSTORE_TRUST_ANCHORS;
    rootCerts = pems.map((pem) => new x509.X509Certificate(pem));
  } catch (err) {
    errors.push({ message: `x509 parse: ${messageOf(err)}` });
    return finalize();
  }

  const nowDate = new Date(opts.now ? opts.now() : Date.now());

  // ── Chain verification ────────────────────────────────────────────
  try {
    const chainResult = await verifyChain({ leaf, intermediates, pinnedRoots: rootCerts, nowDate });
    cert_chain_valid = chainResult.valid;
    if (!cert_chain_valid) {
      errors.push({ message: chainResult.reason });
    }
  } catch (err) {
    errors.push({ message: `chain verify crashed: ${messageOf(err)}` });
    return finalize();
  }

  // ── Revocation lookup (leaf serial) ──────────────────────────────
  // The leaf serial is the device-attestation key's serial; Google
  // adds it to https://android.googleapis.com/attestation/status when
  // a leaked keybox is detected. Caller-supplied snapshot.
  const snapshot = opts.revocationSnapshot ?? EMPTY_REVOCATION_SNAPSHOT;
  const leafSerialLower = leaf.serialNumber.toLowerCase();
  const revocation = snapshot.entries[leafSerialLower];
  if (revocation) {
    errors.push({
      message: `leaf cert revoked (serial=${leafSerialLower}, status=${revocation.status}${
        revocation.reason ? `, reason=${revocation.reason}` : ""
      })`,
    });
  }
  const revocationOk = !revocation;

  // ── Key Attestation extension ─────────────────────────────────────
  let keyDescription: KeyDescription | null = null;
  const extension = leaf.getExtension(ANDROID_KEY_ATTESTATION_OID);
  if (!extension) {
    errors.push({
      message: `leaf cert missing Android Key Attestation extension (OID ${ANDROID_KEY_ATTESTATION_OID}) — not a hardware-attested leaf`,
    });
  } else {
    try {
      keyDescription = parseKeyDescription(new Uint8Array(extension.value));
      attestation_security_level = keyDescription.attestationSecurityLevel;
      verified_boot_state = keyDescription.hardwareEnforced.rootOfTrust?.verifiedBootState ?? null;
      const constraintsOk = applyExtensionConstraints(keyDescription, opts, errors);
      attestation_extension_valid = constraintsOk && revocationOk;
    } catch (err) {
      errors.push({ message: `Key Attestation extension parse: ${messageOf(err)}` });
    }
  }

  // ── Identity binding ──────────────────────────────────────────────
  if (keyDescription) {
    identity_bound = await applyIdentityBinding(keyDescription.attestationChallenge, opts, errors);
  }

  return finalize();

  function finalize(): AndroidKeystoreVerifyResult {
    return {
      valid: cert_chain_valid && attestation_extension_valid && identity_bound,
      cert_chain_valid,
      attestation_extension_valid,
      identity_bound,
      attestation_security_level,
      verified_boot_state,
      errors,
    };
  }
}

/**
 * Apply the policy constraints to the parsed `KeyDescription`. Returns
 * `true` only if every constraint passed; returns `false` and pushes
 * a structured error otherwise. Multiple failures accumulate so the
 * caller sees the full picture.
 */
function applyExtensionConstraints(
  kd: KeyDescription,
  opts: AndroidKeystoreVerifyOptions,
  errors: AndroidKeystoreVerifyError[],
): boolean {
  let ok = true;

  // attestationVersion floor
  const minAttestationVersion = opts.minAttestationVersion ?? 3;
  if (kd.attestationVersion < minAttestationVersion) {
    errors.push({
      message: `attestationVersion ${kd.attestationVersion} below minimum ${minAttestationVersion} (Keymaster 3 / Android 7+)`,
    });
    ok = false;
  }

  // attestationSecurityLevel floor — software-only fallback rejected
  const minSecurityLevel = opts.minSecurityLevel ?? SECURITY_LEVEL_TRUSTED_ENVIRONMENT;
  if (kd.attestationSecurityLevel < minSecurityLevel) {
    errors.push({
      message: `attestationSecurityLevel ${kd.attestationSecurityLevel} below minimum ${minSecurityLevel} (TRUSTED_ENVIRONMENT or higher required for canonical hardware attestation)`,
    });
    ok = false;
  }

  // hardwareEnforced.rootOfTrust must be present with allowlisted
  // verifiedBootState. The default allowlist is [VERIFIED] —
  // user-unlocked devices are rejected at the canonical floor;
  // GrapheneOS-style SELF_SIGNED can be opted in by the operator.
  const allowlist = opts.verifiedBootStateAllowlist ?? [VERIFIED_BOOT_STATE_VERIFIED];
  const rot = kd.hardwareEnforced.rootOfTrust;
  if (!rot) {
    errors.push({
      message: "hardwareEnforced.rootOfTrust missing — cannot certify boot-image state",
    });
    ok = false;
  } else if (allowlist.length > 0 && !allowlist.includes(rot.verifiedBootState)) {
    errors.push({
      message: `verifiedBootState ${rot.verifiedBootState} not in allowlist [${allowlist.join(", ")}]`,
    });
    ok = false;
  }

  // attestationApplicationId binding — exact byte match.
  const expectedAppId = opts.expectedAttestationApplicationId;
  const actualAppId = kd.hardwareEnforced.attestationApplicationId;
  if (!actualAppId) {
    errors.push({
      message:
        "hardwareEnforced.attestationApplicationId missing — cannot bind to package identity",
    });
    ok = false;
  } else if (!bytesEq(actualAppId, expectedAppId)) {
    errors.push({
      message: `hardwareEnforced.attestationApplicationId does not match expected package binding (${actualAppId.length}B leaf vs ${expectedAppId.length}B expected)`,
    });
    ok = false;
  }

  return ok;
}

/**
 * Apply the cross-stack identity binding: SHA-256 the JCS canonical
 * body naming the caller's identity, byte-compare against the leaf's
 * `attestationChallenge`. Returns true on success; pushes structured
 * errors on each missing or mismatched field.
 */
async function applyIdentityBinding(
  challenge: Uint8Array,
  opts: AndroidKeystoreVerifyOptions,
  errors: AndroidKeystoreVerifyError[],
): Promise<boolean> {
  if (
    typeof opts.expectedIdentityPublicKeyHex !== "string" ||
    opts.expectedIdentityPublicKeyHex.length === 0
  ) {
    errors.push({ message: "identity_bound: expectedIdentityPublicKeyHex not supplied" });
    return false;
  }
  if (typeof opts.expectedMotebitId !== "string" || opts.expectedMotebitId.length === 0) {
    errors.push({
      message: "identity_bound: expectedMotebitId not supplied (required for body re-derivation)",
    });
    return false;
  }
  if (typeof opts.expectedDeviceId !== "string" || opts.expectedDeviceId.length === 0) {
    errors.push({
      message: "identity_bound: expectedDeviceId not supplied (required for body re-derivation)",
    });
    return false;
  }
  if (typeof opts.expectedAttestedAt !== "number" || !Number.isFinite(opts.expectedAttestedAt)) {
    errors.push({
      message: "identity_bound: expectedAttestedAt not supplied (required for body re-derivation)",
    });
    return false;
  }

  const canonicalBody = buildCanonicalAttestationBody({
    attested_at: opts.expectedAttestedAt,
    device_id: opts.expectedDeviceId,
    identity_public_key: opts.expectedIdentityPublicKeyHex.toLowerCase(),
    motebit_id: opts.expectedMotebitId,
  });
  const derived = await sha256Bytes(new TextEncoder().encode(canonicalBody));
  if (bytesEq(derived, challenge)) return true;

  errors.push({
    message:
      "identity_bound: reconstructed SHA256(canonical body) does not equal leaf attestationChallenge — body naming the caller's identity was not the body the device attested over",
  });
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** OID for X.509 basic-constraints extension. */
const BASIC_CONSTRAINTS_OID = "2.5.29.19";

interface ChainVerifyResult {
  readonly valid: boolean;
  readonly reason: string;
}

/**
 * Walk the cert chain from leaf → intermediates → pinned anchor.
 * Mirrors the App Attest / TPM chain verifier invariants:
 *   1. `X509ChainBuilder.build(leaf)` returns a chain terminating at
 *      a self-signed cert reachable from the supplied + pinned pool.
 *   2. The terminal cert's DER byte-equals one of the pinned roots.
 *   3. Every non-leaf cert carries `basicConstraints.cA === true`.
 *   4. Every signature verifies under its issuer's public key.
 *   5. Every cert is within its validity window at `nowDate`.
 */
async function verifyChain(input: {
  readonly leaf: x509.X509Certificate;
  readonly intermediates: readonly x509.X509Certificate[];
  readonly pinnedRoots: readonly x509.X509Certificate[];
  readonly nowDate: Date;
}): Promise<ChainVerifyResult> {
  const { leaf, intermediates, pinnedRoots, nowDate } = input;

  if (pinnedRoots.length === 0) {
    return { valid: false, reason: "no pinned trust anchors configured" };
  }

  const builder = new x509.X509ChainBuilder({
    certificates: [leaf, ...intermediates, ...pinnedRoots],
  });
  const chain = await builder.build(leaf);

  const terminal = chain[chain.length - 1]!;
  const terminalSelfSigned = await terminal.isSelfSigned();
  if (!terminalSelfSigned) {
    return { valid: false, reason: "chain does not terminate at a self-signed root" };
  }
  const terminalDer = new Uint8Array(terminal.rawData);
  const matchesPinned = pinnedRoots.some((root) =>
    bytesEq(terminalDer, new Uint8Array(root.rawData)),
  );
  if (!matchesPinned) {
    return {
      valid: false,
      reason:
        "chain terminal cert DER does not match any pinned Google Hardware Attestation root (RSA / ECDSA P-384)",
    };
  }

  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    if (nowDate < cert.notBefore || nowDate > cert.notAfter) {
      return {
        valid: false,
        reason: `cert at chain position ${i} is outside its validity window at ${nowDate.toISOString()}`,
      };
    }
    const isLeaf = i === 0;
    if (!isLeaf && !certHasCaTrue(cert)) {
      return {
        valid: false,
        reason: `cert at chain position ${i} lacks basicConstraints.cA=true (CA constraint not enforced)`,
      };
    }
    const issuer = i === chain.length - 1 ? cert : chain[i + 1]!;
    const sigOk = await cert.verify({ publicKey: issuer.publicKey, date: nowDate });
    if (!sigOk) {
      return {
        valid: false,
        reason: `cert at chain position ${i} signature did not verify under its issuer's public key`,
      };
    }
  }

  return { valid: true, reason: "ok" };
}

function certHasCaTrue(cert: x509.X509Certificate): boolean {
  const ext = cert.getExtension<x509.BasicConstraintsExtension>(BASIC_CONSTRAINTS_OID);
  if (!ext) return false;
  return ext.ca === true;
}

/**
 * Reconstruct the byte-identical canonical body the Kotlin
 * `expo-android-keystore` mint path composes at attestation time.
 *
 * Ordering: alphabetical (JCS):
 *   attested_at, device_id, identity_public_key, motebit_id, platform,
 *   version.
 *
 * `platform` is always `"android_keystore"` and `version` is always
 * `"1"` — both constants, matching the App Attest / TPM canonical-body
 * shape exactly.
 */
function buildCanonicalAttestationBody(input: {
  readonly attested_at: number;
  readonly device_id: string;
  readonly identity_public_key: string;
  readonly motebit_id: string;
}): string {
  return (
    `{"attested_at":${input.attested_at}` +
    `,"device_id":${jsonEscapeString(input.device_id)}` +
    `,"identity_public_key":${jsonEscapeString(input.identity_public_key)}` +
    `,"motebit_id":${jsonEscapeString(input.motebit_id)}` +
    `,"platform":"android_keystore"` +
    `,"version":"1"}`
  );
}

function jsonEscapeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  out += '"';
  return out;
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function fromBase64Url(str: string): Uint8Array {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  else if (pad === 1) throw new Error("invalid base64url length");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
