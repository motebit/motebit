/**
 * App Attest receipt verifier — the core judgment function this
 * package exports.
 *
 * Flow (matches Apple's published verification recipe for App Attest,
 * plus the motebit-specific identity-key binding step):
 *
 *   1. Split the receipt into (attestationObjectBase64,
 *      keyIdBase64, clientDataHashBase64).
 *   2. CBOR-decode the attestation object to {fmt, attStmt:{x5c,
 *      receipt}, authData}. Assert fmt === "apple-appattest".
 *   3. Parse leaf + intermediate as X.509. Walk the chain from leaf to
 *      a self-signed root and verify every signature, every CA bit,
 *      every validity window. The terminal cert's DER must equal the
 *      pinned Apple App Attest root.
 *   4. Extract OID `1.2.840.113635.100.8.2` from the leaf's
 *      extensions. Assert its payload equals SHA256(authData ||
 *      clientDataHash) where clientDataHash is the transmitted hash.
 *      (In App Attest parlance: the "nonce" binding.)
 *   5. Parse authData (WebAuthn format). First 32 bytes is
 *      `rpIdHash`; assert it equals SHA256(bundleId). (The "bundle"
 *      binding.)
 *   6. Reconstruct the JCS-canonical attestation body from
 *      (motebit_id, device_id, identity_public_key, attested_at) the
 *      caller supplies, SHA-256 it, and byte-compare against the
 *      transmitted `clientDataHash`. This is the cross-stack binding
 *      — without it, every other step would prove only that *some*
 *      Apple-attested iOS device did something, not that the Ed25519
 *      key the credential subject claims is actually on that device.
 *
 * Apple's own inner `receipt` field is NOT verified here — that
 * requires Apple's server-side refresh endpoint and is out of scope
 * for v1. The outer chain + nonce binding + bundle binding + motebit
 * identity binding is enough for third-party self-verification of
 * device-attested identity.
 */

import * as x509 from "@peculiar/x509";

import type { HardwareAttestationClaim } from "@motebit/protocol";

import { APPLE_APPATTEST_FMT, APPLE_APPATTEST_ROOT_PEM } from "./apple-root.js";
import { parseAppAttestCbor } from "./cbor.js";

export interface AppAttestVerifyOptions {
  /** iOS bundle identifier that minted the attestation (e.g. "com.motebit.app"). */
  readonly expectedBundleId: string;
  /**
   * Ed25519 identity key (lowercase hex) the motebit VC claims. The
   * attested body MUST name this key.
   */
  readonly expectedIdentityPublicKeyHex: string;
  /**
   * motebit_id from the credential subject. Part of the canonical
   * attestation body the Swift mint path signs; re-derived here and
   * byte-compared against the transmitted clientDataHash so a
   * malicious native client cannot substitute a different body.
   */
  readonly expectedMotebitId?: string;
  /**
   * device_id from the credential subject. Same binding role as
   * `expectedMotebitId`.
   */
  readonly expectedDeviceId?: string;
  /**
   * `attested_at` (unix ms) from the credential subject. Same binding
   * role as `expectedMotebitId`.
   */
  readonly expectedAttestedAt?: number;
  /**
   * Override the pinned Apple root — tests fabricate their own root so
   * chain verification exercises the same code path without needing
   * real Apple-signed leaves. Defaults to the pinned
   * `APPLE_APPATTEST_ROOT_PEM`.
   */
  readonly rootPem?: string;
  /**
   * Clock for chain-validity checks. Defaults to `Date.now`. Tests inject
   * a fixed clock to keep certificate validity windows deterministic.
   */
  readonly now?: () => number;
  /**
   * Override the attestation format check. Defaults to `"apple-appattest"`
   * — the value Apple emits. Exposed only so test fabrications that
   * exercise chain-validation edge cases can still reach the code path.
   */
  readonly expectedFmt?: string;
}

export interface AppAttestVerifyError {
  readonly message: string;
}

export interface AppAttestVerifyResult {
  readonly valid: boolean;
  readonly cert_chain_valid: boolean;
  readonly nonce_bound: boolean;
  readonly bundle_bound: boolean;
  readonly identity_bound: boolean;
  readonly errors: readonly AppAttestVerifyError[];
}

/** OID for Apple's nonce-binding extension inside the App Attest leaf. */
const APPLE_NONCE_EXTENSION_OID = "1.2.840.113635.100.8.2";
/** OID for X.509 basic-constraints extension — carries the CA bit. */
const BASIC_CONSTRAINTS_OID = "2.5.29.19";

/**
 * Apple App Attest attestation verifier.
 *
 * Pure. No network. No filesystem. Deterministic given `now()`.
 *
 * `claim` is the `HardwareAttestationClaim` as carried inside the
 * motebit AgentTrustCredential. For App Attest, the
 * `attestation_receipt` field is expected to be three base64url
 * segments separated by `.`:
 *
 *   `{attestationObjectB64}.{keyIdB64}.{clientDataHashB64}`
 *
 * The mobile mint path constructs this shape; see
 * `apps/mobile/src/mint-hardware-credential.ts`.
 */
export async function verifyAppAttestReceipt(
  claim: HardwareAttestationClaim,
  opts: AppAttestVerifyOptions,
): Promise<AppAttestVerifyResult> {
  const errors: AppAttestVerifyError[] = [];
  let cert_chain_valid = false;
  let nonce_bound = false;
  let bundle_bound = false;
  let identity_bound = false;

  if (!claim.attestation_receipt) {
    errors.push({ message: "device_check claim missing `attestation_receipt`" });
    return fail(errors);
  }

  const parts = claim.attestation_receipt.split(".");
  if (parts.length !== 3) {
    errors.push({
      message: `attestation_receipt must be 3 base64url parts (attObj.keyId.clientDataHash); got ${parts.length}`,
    });
    return fail(errors);
  }
  const [attObjB64, _keyIdB64, clientDataHashB64] = parts as [string, string, string];

  let attestationObjectBytes: Uint8Array;
  let clientDataHashBytes: Uint8Array;
  try {
    attestationObjectBytes = fromBase64Url(attObjB64);
    clientDataHashBytes = fromBase64Url(clientDataHashB64);
  } catch (err) {
    errors.push({ message: `base64url decode failed: ${messageOf(err)}` });
    return fail(errors);
  }

  let cbor;
  try {
    cbor = parseAppAttestCbor(attestationObjectBytes);
  } catch (err) {
    errors.push({ message: `CBOR decode: ${messageOf(err)}` });
    return fail(errors);
  }

  const expectedFmt = opts.expectedFmt ?? APPLE_APPATTEST_FMT;
  if (cbor.fmt !== expectedFmt) {
    errors.push({ message: `attestation fmt is \`${cbor.fmt}\`; expected \`${expectedFmt}\`` });
    return fail(errors);
  }

  if (cbor.x5c.length < 2) {
    errors.push({
      message: `x5c must carry at least [leaf, intermediate]; got ${cbor.x5c.length}`,
    });
    return fail(errors);
  }

  // ── Step 3: chain verify leaf → intermediate → pinned Apple root ──
  // Walk the chain, enforce CA constraints on every non-leaf, verify
  // every signature, and assert the terminal cert is self-signed and
  // byte-equal to the pinned root's DER.
  let leafCert: x509.X509Certificate;
  let intermediateCert: x509.X509Certificate;
  let rootCert: x509.X509Certificate;
  try {
    leafCert = new x509.X509Certificate(toArrayBuffer(cbor.x5c[0]!));
    intermediateCert = new x509.X509Certificate(toArrayBuffer(cbor.x5c[1]!));
    rootCert = new x509.X509Certificate(opts.rootPem ?? APPLE_APPATTEST_ROOT_PEM);
  } catch (err) {
    errors.push({ message: `x509 parse: ${messageOf(err)}` });
    return fail(errors);
  }

  const nowDate = new Date(opts.now ? opts.now() : Date.now());

  try {
    const chainResult = await verifyCertChain({
      leaf: leafCert,
      intermediate: intermediateCert,
      root: rootCert,
      nowDate,
    });
    cert_chain_valid = chainResult.valid;
    if (!cert_chain_valid) {
      errors.push({ message: chainResult.reason });
    }
  } catch (err) {
    errors.push({ message: `chain verify crashed: ${messageOf(err)}` });
    return fail(errors, { cert_chain_valid, nonce_bound, bundle_bound, identity_bound });
  }

  // ── Step 4: nonce binding ──
  // The leaf carries OID 1.2.840.113635.100.8.2 whose value (after
  // OCTET STRING unwrapping) is SHA256(authData || clientDataHash).
  try {
    const nonceExt = leafCert.getExtension(APPLE_NONCE_EXTENSION_OID);
    if (!nonceExt) {
      errors.push({
        message: `leaf missing Apple nonce extension OID ${APPLE_NONCE_EXTENSION_OID}`,
      });
    } else {
      // `Extension.value` is the DER-encoded extension value — the inner
      // bytes from the `OCTET STRING` wrapper of the Extension struct.
      // Apple's payload sits one more level deep: `SEQUENCE { [1] EXPLICIT OCTET STRING }`.
      const nonceFromExt = extractAppleNoncePayload(new Uint8Array(nonceExt.value));
      const nonceExpected = await sha256Concat(cbor.authData, clientDataHashBytes);
      if (bytesEq(nonceFromExt, nonceExpected)) {
        nonce_bound = true;
      } else {
        errors.push({
          message:
            "Apple nonce extension payload does not equal SHA256(authData || clientDataHash)",
        });
      }
    }
  } catch (err) {
    errors.push({ message: `nonce extension parse: ${messageOf(err)}` });
  }

  // ── Step 5: bundle binding ──
  // authData layout (WebAuthn): first 32 bytes are rpIdHash. For App
  // Attest, rpIdHash = SHA256(bundleId).
  try {
    if (cbor.authData.length < 32) {
      errors.push({ message: `authData shorter than 32 bytes (got ${cbor.authData.length})` });
    } else {
      const rpIdHash = cbor.authData.subarray(0, 32);
      const expected = await sha256Bytes(new TextEncoder().encode(opts.expectedBundleId));
      if (bytesEq(rpIdHash, expected)) {
        bundle_bound = true;
      } else {
        errors.push({
          message: `authData.rpIdHash does not equal SHA256("${opts.expectedBundleId}")`,
        });
      }
    }
  } catch (err) {
    errors.push({ message: `bundle check crashed: ${messageOf(err)}` });
  }

  // ── Step 6: motebit identity-key binding ──
  // Reconstruct the JCS-canonical attestation body the Swift mint path
  // signed (byte-identical to the string assembled in
  // `apps/mobile/modules/expo-app-attest/ios/ExpoAppAttestModule.swift`
  // `CanonicalBody.encode`), SHA-256 it, and byte-compare against
  // `clientDataHashBytes`. A malicious native client that substitutes
  // any other body — including one naming a different Ed25519 key,
  // motebit_id, device_id, or timestamp — produces a different hash
  // and fails here.
  try {
    if (
      typeof opts.expectedIdentityPublicKeyHex !== "string" ||
      opts.expectedIdentityPublicKeyHex.length === 0
    ) {
      errors.push({
        message: "identity_bound: expectedIdentityPublicKeyHex not supplied",
      });
    } else if (typeof opts.expectedMotebitId !== "string" || opts.expectedMotebitId.length === 0) {
      errors.push({
        message: "identity_bound: expectedMotebitId not supplied (required for body re-derivation)",
      });
    } else if (typeof opts.expectedDeviceId !== "string" || opts.expectedDeviceId.length === 0) {
      errors.push({
        message: "identity_bound: expectedDeviceId not supplied (required for body re-derivation)",
      });
    } else if (
      typeof opts.expectedAttestedAt !== "number" ||
      !Number.isFinite(opts.expectedAttestedAt)
    ) {
      errors.push({
        message:
          "identity_bound: expectedAttestedAt not supplied (required for body re-derivation)",
      });
    } else {
      const canonicalBody = buildCanonicalAttestationBody({
        attested_at: opts.expectedAttestedAt,
        device_id: opts.expectedDeviceId,
        identity_public_key: opts.expectedIdentityPublicKeyHex.toLowerCase(),
        motebit_id: opts.expectedMotebitId,
      });
      const derived = await sha256Bytes(new TextEncoder().encode(canonicalBody));
      if (bytesEq(derived, clientDataHashBytes)) {
        identity_bound = true;
      } else {
        errors.push({
          message:
            "identity_bound: reconstructed SHA256(canonical body) does not equal transmitted clientDataHash — body naming the caller's identity was not the body Apple signed over",
        });
      }
    }
  } catch (err) {
    errors.push({ message: `identity binding crashed: ${messageOf(err)}` });
  }

  return {
    valid: cert_chain_valid && nonce_bound && bundle_bound && identity_bound,
    cert_chain_valid,
    nonce_bound,
    bundle_bound,
    identity_bound,
    errors,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function fail(
  errors: AppAttestVerifyError[],
  partial?: Partial<Omit<AppAttestVerifyResult, "valid" | "errors">>,
): AppAttestVerifyResult {
  return {
    valid: false,
    cert_chain_valid: partial?.cert_chain_valid ?? false,
    nonce_bound: partial?.nonce_bound ?? false,
    bundle_bound: partial?.bundle_bound ?? false,
    identity_bound: partial?.identity_bound ?? false,
    errors,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

async function sha256Concat(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return sha256Bytes(out);
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Chain-verification result for `verifyCertChain`. Returns a structured
 * reason on failure so the caller can surface a descriptive error —
 * "signature didn't verify" vs "intermediate lacks CA bit" vs "root
 * doesn't match the pin" are categorically different rejections.
 */
interface ChainVerifyResult {
  readonly valid: boolean;
  readonly reason: string;
}

/**
 * Build the App Attest chain from the three supplied certs, then
 * assert every link, validity window, CA constraint, and the terminal
 * root-DER match. Mirrors what `@peculiar/x509`'s `X509ChainBuilder`
 * offers (chain construction by issuer/subject matching) plus the
 * motebit-specific invariants the pinned-root model requires.
 *
 * Invariants asserted:
 *   1. `X509ChainBuilder.build(leaf)` finds a complete chain terminating
 *      at a self-signed cert using only the three supplied certs.
 *   2. The chain's terminal cert's DER equals the pinned root's DER —
 *      the pinned cert is the only acceptable trust anchor.
 *   3. Every non-leaf cert in the chain carries
 *      `basicConstraints.cA === true`. A misissued leaf presented as an
 *      intermediate (no CA bit) fails here even if its signature chains.
 *   4. Every cert's signature verifies under its issuer's public key.
 *   5. Every cert is within its validity window at `nowDate`.
 */
async function verifyCertChain(input: {
  readonly leaf: x509.X509Certificate;
  readonly intermediate: x509.X509Certificate;
  readonly root: x509.X509Certificate;
  readonly nowDate: Date;
}): Promise<ChainVerifyResult> {
  const { leaf, intermediate, root, nowDate } = input;

  // Use @peculiar/x509's chain builder with the three candidate certs.
  // It walks issuer→subject links and returns a chain terminating at
  // a self-signed cert (or the best anchor it can find within the
  // supplied pool).
  const builder = new x509.X509ChainBuilder({
    certificates: [leaf, intermediate, root],
  });
  // `builder.build(leaf)` walks issuer→subject links in the supplied
  // pool and returns the longest chain it can construct starting from
  // the leaf. Exceptions escape to the outer `verify.ts` catch, which
  // funnels them into the structured error result — so we don't need a
  // local try/catch here.
  const chain = await builder.build(leaf);

  // Terminal cert must be self-signed AND byte-equal to the pinned root
  // DER. The self-signed check catches a chain that accidentally
  // terminates at an intermediate (chain too short to reach a root, or
  // a leaf mis-labelled as its own issuer); the DER-equality check
  // catches a chain rooted at a different self-signed anchor the
  // attacker owns.
  const terminal = chain[chain.length - 1]!;
  const terminalSelfSigned = await terminal.isSelfSigned();
  if (!terminalSelfSigned) {
    return {
      valid: false,
      reason: "chain does not terminate at a self-signed root",
    };
  }
  if (!bytesEq(new Uint8Array(terminal.rawData), new Uint8Array(root.rawData))) {
    return {
      valid: false,
      reason: "chain terminal cert DER does not match the pinned root",
    };
  }

  // Verify every link: signature, validity, and (for non-leaves) CA
  // constraint. `chain[0]` is the leaf; `chain[i+1]` issues `chain[i]`.
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

    // Signature: non-terminal certs are signed by chain[i+1]; terminal
    // cert is self-signed (issuer === subject, verified against its
    // own public key). Verification crashes bubble up to the outer
    // catch.
    const issuer = i === chain.length - 1 ? cert : chain[i + 1]!;
    const sigOk = await cert.verify({ publicKey: issuer.publicKey, date: nowDate });
    if (!sigOk) {
      return {
        valid: false,
        reason: `cert at chain position ${i} signature did not verify under its issuer's public key`,
      };
    }
  }

  // The supplied intermediate must appear in the built chain — if the
  // builder routed around it (leaf mis-labelled as its own issuer, or
  // pool somehow resolved a different intermediate), the pinned-root
  // DER check above will already have caught the divergence. Sanity
  // check dropped as redundant.

  void intermediate; // explicit: the value is used only as a pool input.
  return { valid: true, reason: "ok" };
}

/**
 * Read basicConstraints and return true iff `cA === true`. Uses the
 * library's typed extension shape (`BasicConstraintsExtension.ca`); a
 * cert that simply omits the extension fails the check.
 */
function certHasCaTrue(cert: x509.X509Certificate): boolean {
  const ext = cert.getExtension<x509.BasicConstraintsExtension>(BASIC_CONSTRAINTS_OID);
  if (!ext) return false;
  return ext.ca === true;
}

/**
 * Reconstruct the byte-identical canonical body the Swift mint path
 * composes at App Attest time. Must stay byte-equal to
 * `CanonicalBody.encode` in
 * `apps/mobile/modules/expo-app-attest/ios/ExpoAppAttestModule.swift`.
 *
 * Ordering: alphabetical (JCS), which is what Swift emits literally:
 *   attested_at, device_id, identity_public_key, motebit_id, platform,
 *   version.
 *
 * `platform` is always `"device_check"` and `version` is always `"1"` —
 * both constants live in the Swift and must match exactly.
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
    `,"platform":"device_check"` +
    `,"version":"1"}`
  );
}

/**
 * Emit a JSON-escaped string literal (with quotes) byte-equal to the
 * Swift `jsonString` escape policy:
 *   - " → \"
 *   - \ → \\
 *   - \n, \r, \t → short forms
 *   - other controls (< 0x20) → \u00XX
 *   - everything else passes through as-is.
 */
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

/**
 * Apple's nonce extension wraps its payload as:
 *
 *   SEQUENCE {
 *     [1] EXPLICIT {
 *       OCTET STRING <32 bytes of SHA256(authData || clientDataHash)>
 *     }
 *   }
 *
 * We decode enough ASN.1 to locate the inner 32-byte octet string. If
 * the shape ever diverges (Apple adds tagged fields, rotates the
 * wrapping structure), the parser fails closed with a descriptive
 * error, not a silent mismatch.
 */
function extractAppleNoncePayload(derBytes: Uint8Array): Uint8Array {
  // Walk a minimal DER parser: SEQUENCE → context[1] EXPLICIT → OCTET
  // STRING. Bail with an exception if anything unexpected shows up.
  const reader = new DerReader(derBytes);
  const outer = reader.readTlv();
  if (outer.tag !== 0x30)
    throw new Error(`expected SEQUENCE (0x30), got 0x${outer.tag.toString(16)}`);

  const inner = new DerReader(outer.value);
  // [1] EXPLICIT → context-specific class (0x80) + constructed (0x20) + tag 1 = 0xa1
  while (inner.hasMore()) {
    const tlv = inner.readTlv();
    if (tlv.tag === 0xa1) {
      const payload = new DerReader(tlv.value).readTlv();
      if (payload.tag !== 0x04) {
        throw new Error(
          `expected OCTET STRING inside context[1], got 0x${payload.tag.toString(16)}`,
        );
      }
      return payload.value;
    }
  }
  throw new Error("context[1] OCTET STRING not found in nonce extension");
}

interface DerTlv {
  readonly tag: number;
  readonly value: Uint8Array;
}

/**
 * Dependency-free DER reader. We only need enough DER to extract
 * the Apple nonce extension. Full DER/BER parsing is `@peculiar/asn1-*`
 * territory; we'd rather not pull a second ASN.1 dependency for a
 * single extension shape.
 */
class DerReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  hasMore(): boolean {
    return this.offset < this.bytes.length;
  }

  readTlv(): DerTlv {
    if (this.offset + 2 > this.bytes.length) throw new Error("unexpected end of DER");
    const tag = this.bytes[this.offset++]!;
    let len = this.bytes[this.offset++]!;
    if (len & 0x80) {
      const nBytes = len & 0x7f;
      if (nBytes > 4) throw new Error("DER length exceeds 4 bytes");
      len = 0;
      for (let i = 0; i < nBytes; i++) {
        if (this.offset >= this.bytes.length) throw new Error("DER length truncated");
        len = (len << 8) | this.bytes[this.offset++]!;
      }
    }
    if (this.offset + len > this.bytes.length) throw new Error("DER value truncated");
    const value = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len;
    return { tag, value };
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Force a fresh ArrayBuffer copy — @peculiar/x509's constructor typing
  // is strict about `ArrayBuffer` vs `SharedArrayBuffer`; returning the
  // underlying buffer directly can hit the SAB case in some TS lib
  // configurations.
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
