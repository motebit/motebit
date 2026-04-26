/**
 * Minimal DER reader for the Android Key Attestation extension.
 *
 * Why hand-rolled: the `KeyDescription` ASN.1 schema (Android Open
 * Source Project, `attestation_record.cpp` / `keymint_attest.asn1`)
 * has ~50 optional context-tagged fields in `AuthorizationList`. Two
 * of them carry the policy-relevant material — `[704] rootOfTrust`
 * and `[709] attestationApplicationId` — and the rest are
 * key-shape parameters we do not gate on. A schema-driven parser
 * (e.g. `@peculiar/asn1-schema`) would have to declare all 50 fields
 * just to skip past the ones we ignore, or use Any-typed slots and
 * lose type safety. Walking the DER directly costs ~150 lines and
 * stays scoped to exactly what verification needs — same trade-off
 * `@motebit/crypto-tpm` made for `TPMS_ATTEST` parsing.
 *
 * Specs referenced:
 *   - Android Open Source Project, `attestation_record.cpp`:
 *     https://source.android.com/docs/security/features/keystore/attestation
 *   - X.690 (DER encoding rules) — high-tag-number form for tags ≥ 31,
 *     long-form length encoding for content > 127 bytes.
 *
 * The parser is fail-closed: any structural anomaly throws a typed
 * error rather than silently skipping. Callers wrap the parse call in
 * try/catch and convert the throw into a structured `errors[]` entry.
 */

/** Raw DER tag-class identifiers (top 2 bits of the tag byte). */
const TAG_CLASS_UNIVERSAL = 0;
const TAG_CLASS_CONTEXT = 2;

/** Universal-class ASN.1 tag numbers we read. */
const UTAG_BOOLEAN = 1;
const UTAG_INTEGER = 2;
const UTAG_OCTET_STRING = 4;
const UTAG_ENUMERATED = 10;
const UTAG_SEQUENCE = 16;

/**
 * AuthorizationList context-tag numbers we care about. All other tags
 * in the AuthorizationList SEQUENCE are skipped. These are the only
 * two whose values gate canonical motebit verification — additional
 * tags (`purpose`, `algorithm`, `keySize`, `ec_curve`, etc.) describe
 * key-shape parameters and are out of scope for v1.
 */
const AUTH_LIST_TAG_ROOT_OF_TRUST = 704;
const AUTH_LIST_TAG_ATTESTATION_APPLICATION_ID = 709;

/** A decoded DER node — class, constructed flag, tag number, content view. */
interface DerNode {
  readonly tagClass: number;
  readonly constructed: boolean;
  readonly tagNumber: number;
  readonly contentBytes: Uint8Array;
}

/**
 * Android `attestationSecurityLevel` / `keymintSecurityLevel` ENUMERATED.
 * Values are stable across KeyMaster and KeyMint versions.
 */
export const SECURITY_LEVEL_SOFTWARE = 0;
export const SECURITY_LEVEL_TRUSTED_ENVIRONMENT = 1;
export const SECURITY_LEVEL_STRONG_BOX = 2;

/**
 * Android `verifiedBootState` ENUMERATED — published in
 * https://source.android.com/docs/security/features/verifiedboot.
 *   - VERIFIED (0): full chain of trust to a Google-signed bootloader
 *   - SELF_SIGNED (1): user-installed root of trust (GrapheneOS,
 *     CalyxOS, etc.)
 *   - UNVERIFIED (2): unlocked bootloader; no boot-image guarantee
 *   - FAILED (3): verification attempted and failed
 */
export const VERIFIED_BOOT_STATE_VERIFIED = 0;
export const VERIFIED_BOOT_STATE_SELF_SIGNED = 1;
export const VERIFIED_BOOT_STATE_UNVERIFIED = 2;
export const VERIFIED_BOOT_STATE_FAILED = 3;

export interface RootOfTrust {
  /** SHA-256 of the boot-image verification public key. */
  readonly verifiedBootKey: Uint8Array;
  readonly deviceLocked: boolean;
  readonly verifiedBootState: number;
  /** Optional — present on KeyMint 2+ devices. */
  readonly verifiedBootHash: Uint8Array | null;
}

export interface AuthorizationList {
  readonly rootOfTrust: RootOfTrust | null;
  /** Raw bytes of `[709] attestationApplicationId` — caller decides
   *  whether to JSON-decode further (it's a wrapped sequence of the
   *  package name + signing-cert SHA-256 set). */
  readonly attestationApplicationId: Uint8Array | null;
}

export interface KeyDescription {
  readonly attestationVersion: number;
  readonly attestationSecurityLevel: number;
  readonly keyMintVersion: number;
  readonly keyMintSecurityLevel: number;
  /** The challenge the caller passed to `setAttestationChallenge` —
   *  for motebit this is `SHA256(canonical body naming the
   *  identity)`. */
  readonly attestationChallenge: Uint8Array;
  readonly uniqueId: Uint8Array;
  readonly softwareEnforced: AuthorizationList;
  readonly hardwareEnforced: AuthorizationList;
}

/**
 * Parse the Android Key Attestation extension value into a typed
 * `KeyDescription`. `extValue` is the `extnValue` OCTET STRING's
 * inner content — the bytes inside the OCTET STRING wrapper that
 * `@peculiar/x509`'s `cert.getExtension(OID).value` returns as a
 * Uint8Array.
 */
export function parseKeyDescription(extValue: Uint8Array): KeyDescription {
  const seq = readDerNode(extValue, 0);
  if (seq.node.tagClass !== TAG_CLASS_UNIVERSAL || seq.node.tagNumber !== UTAG_SEQUENCE) {
    throw new Error(
      `KeyDescription: outer tag is not SEQUENCE (got class=${seq.node.tagClass} tagNumber=${seq.node.tagNumber})`,
    );
  }
  const children = readSequenceChildren(seq.node.contentBytes);
  if (children.length < 8) {
    throw new Error(`KeyDescription: SEQUENCE has ${children.length} fields, expected ≥ 8`);
  }

  return {
    attestationVersion: readUniversalInteger(children[0]!, "attestationVersion"),
    attestationSecurityLevel: readUniversalEnumerated(children[1]!, "attestationSecurityLevel"),
    keyMintVersion: readUniversalInteger(children[2]!, "keyMintVersion"),
    keyMintSecurityLevel: readUniversalEnumerated(children[3]!, "keyMintSecurityLevel"),
    attestationChallenge: readUniversalOctetString(children[4]!, "attestationChallenge"),
    uniqueId: readUniversalOctetString(children[5]!, "uniqueId"),
    softwareEnforced: parseAuthorizationList(children[6]!, "softwareEnforced"),
    hardwareEnforced: parseAuthorizationList(children[7]!, "hardwareEnforced"),
  };
}

/**
 * Parse an `AuthorizationList` SEQUENCE into the two fields we care
 * about. All other context-tagged fields are intentionally skipped —
 * the AOSP spec defines ~50 optional context tags carrying key-shape
 * parameters; motebit verification gates only on `rootOfTrust` and
 * `attestationApplicationId`.
 */
function parseAuthorizationList(node: DerNode, fieldName: string): AuthorizationList {
  if (node.tagClass !== TAG_CLASS_UNIVERSAL || node.tagNumber !== UTAG_SEQUENCE) {
    throw new Error(`${fieldName}: not a SEQUENCE`);
  }
  let rootOfTrust: RootOfTrust | null = null;
  let attestationApplicationId: Uint8Array | null = null;

  for (const child of readSequenceChildren(node.contentBytes)) {
    if (child.tagClass !== TAG_CLASS_CONTEXT) continue;
    if (child.tagNumber === AUTH_LIST_TAG_ROOT_OF_TRUST) {
      // [704] EXPLICIT RootOfTrust — the outer context-tag wraps the
      // inner SEQUENCE. Read the SEQUENCE and parse its fields.
      const inner = readDerNode(child.contentBytes, 0).node;
      rootOfTrust = parseRootOfTrust(inner);
    } else if (child.tagNumber === AUTH_LIST_TAG_ATTESTATION_APPLICATION_ID) {
      // [709] EXPLICIT OCTET STRING.
      const inner = readDerNode(child.contentBytes, 0).node;
      if (inner.tagClass !== TAG_CLASS_UNIVERSAL || inner.tagNumber !== UTAG_OCTET_STRING) {
        throw new Error(
          `${fieldName}.attestationApplicationId: inner tag is not OCTET STRING (got class=${inner.tagClass} tagNumber=${inner.tagNumber})`,
        );
      }
      attestationApplicationId = inner.contentBytes.slice();
    }
    // All other context tags are key-shape parameters — skip silently.
  }

  return { rootOfTrust, attestationApplicationId };
}

function parseRootOfTrust(node: DerNode): RootOfTrust {
  if (node.tagClass !== TAG_CLASS_UNIVERSAL || node.tagNumber !== UTAG_SEQUENCE) {
    throw new Error("rootOfTrust: not a SEQUENCE");
  }
  const children = readSequenceChildren(node.contentBytes);
  if (children.length < 3) {
    throw new Error(`rootOfTrust: SEQUENCE has ${children.length} fields, expected ≥ 3`);
  }
  const verifiedBootKey = readUniversalOctetString(children[0]!, "rootOfTrust.verifiedBootKey");
  const deviceLocked = readUniversalBoolean(children[1]!, "rootOfTrust.deviceLocked");
  const verifiedBootState = readUniversalEnumerated(children[2]!, "rootOfTrust.verifiedBootState");
  const verifiedBootHash =
    children.length >= 4
      ? readUniversalOctetString(children[3]!, "rootOfTrust.verifiedBootHash")
      : null;
  return { verifiedBootKey, deviceLocked, verifiedBootState, verifiedBootHash };
}

// ── Universal-tag readers ─────────────────────────────────────────────

function readUniversalInteger(node: DerNode, fieldName: string): number {
  if (node.tagClass !== TAG_CLASS_UNIVERSAL || node.tagNumber !== UTAG_INTEGER) {
    throw new Error(`${fieldName}: not an INTEGER`);
  }
  // Attestation versions are small (current is 400 = KeyMint 4.0).
  // We do not need a bigint reader for v1.
  let n = 0;
  for (const b of node.contentBytes) {
    n = (n << 8) | b;
    if (n > Number.MAX_SAFE_INTEGER) {
      throw new Error(`${fieldName}: INTEGER exceeds Number.MAX_SAFE_INTEGER`);
    }
  }
  return n;
}

function readUniversalEnumerated(node: DerNode, fieldName: string): number {
  if (node.tagClass !== TAG_CLASS_UNIVERSAL || node.tagNumber !== UTAG_ENUMERATED) {
    throw new Error(`${fieldName}: not an ENUMERATED`);
  }
  // ENUMERATED encodes the same as INTEGER.
  let n = 0;
  for (const b of node.contentBytes) {
    n = (n << 8) | b;
  }
  return n;
}

function readUniversalOctetString(node: DerNode, fieldName: string): Uint8Array {
  if (node.tagClass !== TAG_CLASS_UNIVERSAL || node.tagNumber !== UTAG_OCTET_STRING) {
    throw new Error(`${fieldName}: not an OCTET STRING`);
  }
  return node.contentBytes.slice();
}

function readUniversalBoolean(node: DerNode, fieldName: string): boolean {
  if (node.tagClass !== TAG_CLASS_UNIVERSAL || node.tagNumber !== UTAG_BOOLEAN) {
    throw new Error(`${fieldName}: not a BOOLEAN`);
  }
  if (node.contentBytes.length !== 1) {
    throw new Error(`${fieldName}: BOOLEAN content length ${node.contentBytes.length} ≠ 1`);
  }
  return node.contentBytes[0] !== 0;
}

// ── DER walker ────────────────────────────────────────────────────────

interface ReadResult {
  readonly node: DerNode;
  readonly nextOffset: number;
}

/**
 * Read one DER tag-length-value triple from `bytes` starting at
 * `offset`. Handles X.690 high-tag-number form (multi-byte tag) and
 * long-form length encoding.
 */
function readDerNode(bytes: Uint8Array, offset: number): ReadResult {
  if (offset >= bytes.length) {
    throw new Error(`DER: read past end (offset=${offset}, length=${bytes.length})`);
  }
  let i = offset;
  const tagByte = bytes[i++]!;
  const tagClass = (tagByte >> 6) & 0x03;
  const constructed = (tagByte & 0x20) !== 0;
  let tagNumber = tagByte & 0x1f;

  if (tagNumber === 0x1f) {
    // High-tag-number form: subsequent bytes encode tag in base-128,
    // with high bit set on every byte except the last.
    tagNumber = 0;
    let b: number;
    let safety = 0;
    do {
      if (i >= bytes.length) throw new Error("DER: truncated high-tag-number form");
      if (++safety > 4) {
        // 4 bytes covers tag numbers up to 2^28 — far beyond anything
        // AOSP defines; refuse to decode arbitrarily large tags.
        throw new Error("DER: high-tag-number form exceeds 4 bytes");
      }
      b = bytes[i++]!;
      tagNumber = (tagNumber << 7) | (b & 0x7f);
    } while ((b & 0x80) !== 0);
  }

  if (i >= bytes.length) throw new Error("DER: truncated length");
  const lenByte = bytes[i++]!;
  let length: number;
  if ((lenByte & 0x80) === 0) {
    length = lenByte;
  } else {
    const lenBytes = lenByte & 0x7f;
    if (lenBytes === 0) {
      throw new Error("DER: indefinite-length encoding not allowed in DER");
    }
    if (lenBytes > 4) {
      // A 4-byte length is 4 GiB — far beyond anything we'd see in a
      // cert extension; refuse rather than overflow.
      throw new Error(`DER: long-form length exceeds 4 bytes (got ${lenBytes})`);
    }
    length = 0;
    for (let j = 0; j < lenBytes; j++) {
      if (i >= bytes.length) throw new Error("DER: truncated long-form length");
      length = (length << 8) | bytes[i++]!;
    }
  }

  if (i + length > bytes.length) {
    throw new Error(
      `DER: content runs past buffer (start=${i}, length=${length}, buffer=${bytes.length})`,
    );
  }

  return {
    node: { tagClass, constructed, tagNumber, contentBytes: bytes.subarray(i, i + length) },
    nextOffset: i + length,
  };
}

function readSequenceChildren(seqContent: Uint8Array): DerNode[] {
  const out: DerNode[] = [];
  let offset = 0;
  while (offset < seqContent.length) {
    const r = readDerNode(seqContent, offset);
    out.push(r.node);
    offset = r.nextOffset;
  }
  return out;
}
