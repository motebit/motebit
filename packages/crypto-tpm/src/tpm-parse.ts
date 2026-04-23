/**
 * Minimal TPM 2.0 binary-format parser.
 *
 * The TPM marshals structured data as big-endian size-prefixed bytes —
 * distinct from CBOR / DER / JSON and wholly specific to the TCG's TPM
 * Structures specification. Verification of a TPM quote requires
 * extracting exactly three fields from the `TPMS_ATTEST` structure:
 *
 *   - `magic`           — 4-byte constant, must equal `TPM_GENERATED_VALUE`.
 *   - `type`            — 2-byte constant, `TPM_ST_ATTEST_QUOTE` for quotes.
 *   - `qualifiedSigner` — length-prefixed `TPM2B_NAME`, identifies the AK.
 *   - `extraData`       — length-prefixed `TPM2B_DATA`, this is where
 *                         motebit threads the identity binding.
 *
 * We deliberately skip the remainder (clockInfo, firmwareVersion, the
 * attested quote body containing PCR digests) — motebit's claim is
 * about identity binding, not platform-state attestation. The body's
 * signature (produced by TPM2_Quote using the AK) covers the entire
 * serialized `TPMS_ATTEST`; any byte drift would invalidate it.
 *
 * Hand-rolled over `node-tpm2-pts`: the parser is ~80 LOC and covers
 * exactly our needs. Pulling a dep for that would cross a larger
 * attack surface than the struct we parse.
 *
 * References:
 *   - TCG TPM 2.0 Library, Part 2: Structures — §10.12 `TPMS_ATTEST`.
 *   - TCG TPM 2.0 Library, Part 1: Architecture — §36.1 `TPM2B_*` types.
 */

/** Constant magic value every TPM-signed attest carries. */
export const TPM_GENERATED_VALUE = 0xff544347; // ASCII "ÿTCG"

/** `TPM_ST_ATTEST_QUOTE` — the structure-tag identifying a quote attestation. */
export const TPM_ST_ATTEST_QUOTE = 0x8018;

/**
 * Parsed view of a `TPMS_ATTEST` structure's header + identity-binding
 * fields. Callers verify signature bytes against the full structure;
 * this view exposes only the fields participating in motebit's
 * verification rules.
 */
export interface TpmsAttest {
  /** Must equal `TPM_GENERATED_VALUE` (`0xff544347`). */
  readonly magic: number;
  /** Structure tag, e.g. `TPM_ST_ATTEST_QUOTE`. */
  readonly type: number;
  /** Qualified signer name — `TPM2B_NAME` bytes (hash-alg + digest). */
  readonly qualifiedSigner: Uint8Array;
  /** Caller-supplied extra-data — `TPM2B_DATA` bytes. Identity binding lives here. */
  readonly extraData: Uint8Array;
  /** The rest of the serialized body, kept so callers can re-verify the signature. */
  readonly trailer: Uint8Array;
}

/**
 * Parse a TPM 2.0 `TPMS_ATTEST` structure. Throws on malformed input;
 * the outer `verify.ts` catches and converts to the fail-closed result
 * shape.
 *
 * Wire layout:
 *   uint32 magic                     ; 4 bytes
 *   uint16 type                      ; 2 bytes
 *   TPM2B_NAME qualifiedSigner       ; uint16 size || bytes
 *   TPM2B_DATA extraData             ; uint16 size || bytes
 *   TPMS_CLOCK_INFO clockInfo        ; 17 bytes (fixed)
 *   uint64 firmwareVersion           ; 8 bytes
 *   TPMU_ATTEST attested             ; variable, tag-specific
 *
 * We extract magic / type / qualifiedSigner / extraData and stash the
 * rest in `trailer` so the caller can reconstruct the full signed
 * bytes when verifying the AK signature. The caller retains the
 * original buffer; this view points into it via length-accurate
 * subarray copies.
 */
export function parseTpmsAttest(bytes: Uint8Array): TpmsAttest {
  if (bytes.length < 4 + 2 + 2 + 2) {
    throw new Error(
      `TPMS_ATTEST too short: ${bytes.length} bytes (need at least 10 for header fields)`,
    );
  }

  const reader = new TpmReader(bytes);
  const magic = reader.readUint32();
  const type = reader.readUint16();
  const qualifiedSigner = reader.readTpm2B();
  const extraData = reader.readTpm2B();
  const trailer = reader.remaining();

  return { magic, type, qualifiedSigner, extraData, trailer };
}

/**
 * Build a minimal `TPMS_ATTEST` byte sequence for tests.
 *
 * Tests fabricate a valid-shape attest so the verifier's parsing +
 * extraData-binding code paths exercise without a real TPM. Production
 * minting lives in the Rust bridge — never call `composeTpmsAttest`
 * outside `__tests__/` or you'll drift from what a real TPM would sign.
 *
 * `trailer` defaults to a deterministic 17-byte clockInfo + 8-byte
 * firmwareVersion filler + 4-byte quote filler so the resulting bytes
 * pass the minimum-length check during parsing; tests that need the
 * real trailing fields can override.
 */
export function composeTpmsAttestForTest(input: {
  readonly magic?: number;
  readonly type?: number;
  readonly qualifiedSigner: Uint8Array;
  readonly extraData: Uint8Array;
  readonly trailer?: Uint8Array;
}): Uint8Array {
  const magic = input.magic ?? TPM_GENERATED_VALUE;
  const type = input.type ?? TPM_ST_ATTEST_QUOTE;
  const trailer = input.trailer ?? new Uint8Array(17 + 8 + 4);

  const out = new TpmWriter();
  out.writeUint32(magic);
  out.writeUint16(type);
  out.writeTpm2B(input.qualifiedSigner);
  out.writeTpm2B(input.extraData);
  out.writeRaw(trailer);
  return out.toBytes();
}

// ── Internal helpers ────────────────────────────────────────────────

class TpmReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readUint16(): number {
    if (this.offset + 2 > this.bytes.length) {
      throw new Error(`TPM reader: uint16 at offset ${this.offset} would overrun buffer`);
    }
    const hi = this.bytes[this.offset]!;
    const lo = this.bytes[this.offset + 1]!;
    this.offset += 2;
    return (hi << 8) | lo;
  }

  readUint32(): number {
    if (this.offset + 4 > this.bytes.length) {
      throw new Error(`TPM reader: uint32 at offset ${this.offset} would overrun buffer`);
    }
    const b0 = this.bytes[this.offset]!;
    const b1 = this.bytes[this.offset + 1]!;
    const b2 = this.bytes[this.offset + 2]!;
    const b3 = this.bytes[this.offset + 3]!;
    this.offset += 4;
    // Use unsigned-right-shift by 0 to force a non-negative 32-bit value.
    return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  }

  readTpm2B(): Uint8Array {
    const size = this.readUint16();
    if (this.offset + size > this.bytes.length) {
      throw new Error(
        `TPM reader: TPM2B length ${size} at offset ${this.offset} would overrun buffer ` +
          `(length ${this.bytes.length})`,
      );
    }
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    // Return a detached copy — consumers may treat the result as owned.
    return new Uint8Array(value);
  }

  remaining(): Uint8Array {
    const rest = this.bytes.subarray(this.offset);
    return new Uint8Array(rest);
  }
}

class TpmWriter {
  private chunks: Uint8Array[] = [];

  writeUint16(v: number): void {
    const buf = new Uint8Array(2);
    buf[0] = (v >> 8) & 0xff;
    buf[1] = v & 0xff;
    this.chunks.push(buf);
  }

  writeUint32(v: number): void {
    const buf = new Uint8Array(4);
    buf[0] = (v >>> 24) & 0xff;
    buf[1] = (v >>> 16) & 0xff;
    buf[2] = (v >>> 8) & 0xff;
    buf[3] = v & 0xff;
    this.chunks.push(buf);
  }

  writeTpm2B(bytes: Uint8Array): void {
    this.writeUint16(bytes.length);
    this.chunks.push(new Uint8Array(bytes));
  }

  writeRaw(bytes: Uint8Array): void {
    this.chunks.push(new Uint8Array(bytes));
  }

  toBytes(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}
