/**
 * DER composer for `KeyDescription` extension bytes — TEST-ONLY.
 *
 * Lives in `__tests__/` rather than `src/` because no production
 * caller composes the extension; only the synthetic chain tests do.
 * Mirror of the parser in `src/asn1.ts` — every byte we emit here
 * must round-trip through `parseKeyDescription` to the same struct.
 *
 * We emit the minimal subset of fields the verifier reads:
 *   - top-level fields 1..6 (attestationVersion, attestationSecurityLevel,
 *     keyMintVersion, keyMintSecurityLevel, attestationChallenge,
 *     uniqueId)
 *   - empty `softwareEnforced` SEQUENCE
 *   - `hardwareEnforced` SEQUENCE carrying [704] rootOfTrust + [709]
 *     attestationApplicationId
 *
 * Other AuthorizationList tags (purpose, algorithm, keySize, etc.) are
 * not emitted — the verifier ignores them, and the parser already
 * tolerates their absence.
 */

import { SECURITY_LEVEL_TRUSTED_ENVIRONMENT, VERIFIED_BOOT_STATE_VERIFIED } from "../asn1.js";

interface ComposeInput {
  /** Default 4 (Keymaster 4 / Android 10). Override to test version-floor branches. */
  readonly attestationVersion?: number;
  /** Default TRUSTED_ENVIRONMENT (1). */
  readonly attestationSecurityLevel?: number;
  /** Default 4. */
  readonly keyMintVersion?: number;
  /** Default TRUSTED_ENVIRONMENT (1). */
  readonly keyMintSecurityLevel?: number;
  readonly attestationChallenge: Uint8Array;
  /** Default empty 16-byte uniqueId. */
  readonly uniqueId?: Uint8Array;
  /** Optional — attach `[704] rootOfTrust` to hardwareEnforced. */
  readonly rootOfTrust?: {
    readonly verifiedBootKey: Uint8Array;
    readonly deviceLocked: boolean;
    readonly verifiedBootState: number;
    readonly verifiedBootHash?: Uint8Array;
  };
  /** Optional — attach `[709] attestationApplicationId` to hardwareEnforced. */
  readonly attestationApplicationId?: Uint8Array;
}

export function composeKeyDescriptionForTest(input: ComposeInput): Uint8Array {
  const fields: Uint8Array[] = [
    encodeInteger(input.attestationVersion ?? 4),
    encodeEnumerated(input.attestationSecurityLevel ?? SECURITY_LEVEL_TRUSTED_ENVIRONMENT),
    encodeInteger(input.keyMintVersion ?? 4),
    encodeEnumerated(input.keyMintSecurityLevel ?? SECURITY_LEVEL_TRUSTED_ENVIRONMENT),
    encodeOctetString(input.attestationChallenge),
    encodeOctetString(input.uniqueId ?? new Uint8Array(16)),
    encodeSequence(new Uint8Array(0)), // softwareEnforced — empty
    encodeSequence(encodeHardwareEnforced(input)),
  ];
  return encodeSequence(concat(...fields));
}

function encodeHardwareEnforced(input: ComposeInput): Uint8Array {
  const items: Uint8Array[] = [];

  if (input.rootOfTrust) {
    const rotFields: Uint8Array[] = [
      encodeOctetString(input.rootOfTrust.verifiedBootKey),
      encodeBoolean(input.rootOfTrust.deviceLocked),
      encodeEnumerated(input.rootOfTrust.verifiedBootState ?? VERIFIED_BOOT_STATE_VERIFIED),
    ];
    if (input.rootOfTrust.verifiedBootHash) {
      rotFields.push(encodeOctetString(input.rootOfTrust.verifiedBootHash));
    }
    const rotBytes = encodeSequence(concat(...rotFields));
    items.push(encodeContextExplicit(704, rotBytes));
  }

  if (input.attestationApplicationId) {
    items.push(encodeContextExplicit(709, encodeOctetString(input.attestationApplicationId)));
  }

  // AuthorizationList SEQUENCE expects context-tagged fields in
  // ascending tag order; 704 < 709 → already correctly ordered.
  return concat(...items);
}

// ── DER encoders ─────────────────────────────────────────────────────

function encodeSequence(content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x30]), encodeLength(content.length), content);
}

function encodeOctetString(content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x04]), encodeLength(content.length), content);
}

function encodeBoolean(value: boolean): Uint8Array {
  return new Uint8Array([0x01, 0x01, value ? 0xff : 0x00]);
}

function encodeInteger(n: number): Uint8Array {
  if (n < 0) throw new Error("encodeInteger: negative not supported");
  if (n === 0) return new Uint8Array([0x02, 0x01, 0x00]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  // Pad with leading 0x00 if MSB is set (DER signed-int rule).
  if (bytes[0]! & 0x80) bytes.unshift(0x00);
  return concat(new Uint8Array([0x02]), encodeLength(bytes.length), new Uint8Array(bytes));
}

function encodeEnumerated(n: number): Uint8Array {
  // ENUMERATED encodes the same as INTEGER with tag 0x0a.
  const intDer = encodeInteger(n);
  // Replace tag byte 0x02 (INTEGER) with 0x0a (ENUMERATED).
  intDer[0] = 0x0a;
  return intDer;
}

/**
 * Encode a context-class, constructed, EXPLICIT context-tagged wrapper
 * for the inner DER bytes. Tag class is `2`, constructed bit set, tag
 * number encoded in high-tag-number form when ≥ 31.
 */
function encodeContextExplicit(tagNumber: number, inner: Uint8Array): Uint8Array {
  if (tagNumber < 0) throw new Error("encodeContextExplicit: negative tag not supported");
  const tagBytes: number[] = [];
  if (tagNumber < 31) {
    // Low-tag-number form: 0xA0 | tagNumber
    tagBytes.push(0xa0 | tagNumber);
  } else {
    // High-tag-number form: 0xBF then base-128 with high bit set on
    // every byte except the last.
    tagBytes.push(0xbf);
    const base128: number[] = [];
    let v = tagNumber;
    while (v > 0) {
      base128.unshift(v & 0x7f);
      v >>>= 7;
    }
    for (let i = 0; i < base128.length - 1; i++) base128[i]! |= 0x80;
    tagBytes.push(...base128);
  }
  return concat(new Uint8Array(tagBytes), encodeLength(inner.length), inner);
}

function encodeLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
