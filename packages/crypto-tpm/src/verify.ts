/**
 * TPM 2.0 quote verifier — the core judgment function this package
 * exports.
 *
 * Flow (matches the TCG verification recipe for TPM2_Quote, plus the
 * motebit-specific identity-key binding step):
 *
 *   1. Split the receipt into (tpmsAttestBase64, signatureBase64,
 *      akCertDerBase64, intermediateCertsDerBase64Joined).
 *   2. Parse the TPMS_ATTEST bytes. Assert magic = TPM_GENERATED_VALUE
 *      and type = TPM_ST_ATTEST_QUOTE.
 *   3. Parse the AK leaf + any intermediates as X.509. Walk the chain
 *      from AK leaf → intermediate → vendor root. Every non-leaf must
 *      carry `basicConstraints.cA === true`. Every signature must
 *      verify under its issuer's public key. Every validity window
 *      must include `now`. The terminal cert's DER must byte-equal
 *      ONE of the pinned vendor roots.
 *   4. Verify the AK signature over SHA-256(TPMS_ATTEST_BYTES) using
 *      the AK certificate's public key.
 *   5. Re-derive `extraData` from the JCS-canonical body
 *      {attested_at, device_id, identity_public_key, motebit_id,
 *      platform: "tpm", version: "1"} — SHA-256 of the canonical body
 *      — and byte-compare against the transmitted `extraData`. This is
 *      the cross-stack binding — without it every other step would
 *      prove only that *some* TPM-enrolled device did something, not
 *      that the Ed25519 key the credential subject claims is bound
 *      to that device.
 *
 * The TPM's own EK certificate provisioning path is NOT verified here
 * — that would require contacting the vendor's EK provisioning service
 * and is out of scope for v1. The outer chain + extraData binding is
 * enough for third-party self-verification of TPM-attested identity.
 */

import * as x509 from "@peculiar/x509";

import type { HardwareAttestationClaim } from "@motebit/protocol";

import { DEFAULT_PINNED_TPM_ROOTS } from "./tpm-roots.js";
import { parseTpmsAttest, TPM_GENERATED_VALUE, TPM_ST_ATTEST_QUOTE } from "./tpm-parse.js";

export interface TpmVerifyOptions {
  /**
   * Ed25519 identity key (lowercase hex) the motebit VC claims. The
   * TPM quote's extraData MUST bind this key.
   */
  readonly expectedIdentityPublicKeyHex: string;
  /**
   * motebit_id from the credential subject. Participates in the JCS
   * body the Rust bridge hashes into extraData; re-derived here and
   * byte-compared against the transmitted extraData so a malicious
   * native client cannot substitute a different body.
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
   * Override the pinned vendor roots. Tests fabricate their own root
   * so chain verification exercises the same code path without needing
   * real vendor-signed leaves. Defaults to `DEFAULT_PINNED_TPM_ROOTS`.
   */
  readonly rootPems?: readonly string[];
  /**
   * Clock for chain-validity checks. Defaults to `Date.now`. Tests
   * inject a fixed clock to keep certificate validity windows
   * deterministic.
   */
  readonly now?: () => number;
}

export interface TpmVerifyError {
  readonly message: string;
}

export interface TpmVerifyResult {
  readonly valid: boolean;
  readonly cert_chain_valid: boolean;
  readonly quote_signature_valid: boolean;
  readonly quote_shape_valid: boolean;
  readonly identity_bound: boolean;
  readonly errors: readonly TpmVerifyError[];
}

/** OID for X.509 basic-constraints extension — carries the CA bit. */
const BASIC_CONSTRAINTS_OID = "2.5.29.19";

/**
 * TPM 2.0 quote verifier.
 *
 * Pure. No network. No filesystem. Deterministic given `now()`.
 *
 * `claim` is the `HardwareAttestationClaim` as carried inside the
 * motebit AgentTrustCredential. For TPM, the `attestation_receipt`
 * field is expected to be four base64url segments separated by `.`:
 *
 *   `{tpmsAttestB64}.{signatureB64}.{akCertDerB64}.{intermediatesJoinedB64}`
 *
 * `intermediatesJoinedB64` may itself be an empty segment (`""`) when
 * the AK cert chains directly to a pinned root, or a `,`-joined
 * concatenation of base64url-encoded DER intermediates in leaf-
 * proximal-first order otherwise.
 */
export async function verifyTpmQuote(
  claim: HardwareAttestationClaim,
  opts: TpmVerifyOptions,
): Promise<TpmVerifyResult> {
  const errors: TpmVerifyError[] = [];
  let cert_chain_valid = false;
  let quote_signature_valid = false;
  let quote_shape_valid = false;
  let identity_bound = false;

  if (!claim.attestation_receipt) {
    errors.push({ message: "tpm claim missing `attestation_receipt`" });
    return fail(errors);
  }

  const parts = claim.attestation_receipt.split(".");
  if (parts.length !== 4) {
    errors.push({
      message: `attestation_receipt must be 4 base64url parts (tpmsAttest.signature.akCert.intermediates); got ${parts.length}`,
    });
    return fail(errors);
  }
  const [attestB64, sigB64, akCertB64, intermediatesB64] = parts as [
    string,
    string,
    string,
    string,
  ];

  let attestBytes: Uint8Array;
  let sigBytes: Uint8Array;
  let akCertBytes: Uint8Array;
  let intermediateCertsBytes: Uint8Array[];
  try {
    attestBytes = fromBase64Url(attestB64);
    sigBytes = fromBase64Url(sigB64);
    akCertBytes = fromBase64Url(akCertB64);
    intermediateCertsBytes =
      intermediatesB64.length === 0 ? [] : intermediatesB64.split(",").map((p) => fromBase64Url(p));
  } catch (err) {
    errors.push({ message: `base64url decode failed: ${messageOf(err)}` });
    return fail(errors);
  }

  // ── Step 2: quote shape ─────────────────────────────────────────
  let attest;
  try {
    attest = parseTpmsAttest(attestBytes);
  } catch (err) {
    errors.push({ message: `TPMS_ATTEST parse: ${messageOf(err)}` });
    return fail(errors, {
      cert_chain_valid,
      quote_signature_valid,
      quote_shape_valid,
      identity_bound,
    });
  }

  if (attest.magic !== TPM_GENERATED_VALUE) {
    errors.push({
      message: `TPMS_ATTEST magic is 0x${attest.magic.toString(16)}; expected 0x${TPM_GENERATED_VALUE.toString(16)} (TPM_GENERATED_VALUE)`,
    });
  } else if (attest.type !== TPM_ST_ATTEST_QUOTE) {
    errors.push({
      message: `TPMS_ATTEST type is 0x${attest.type.toString(16)}; expected 0x${TPM_ST_ATTEST_QUOTE.toString(16)} (TPM_ST_ATTEST_QUOTE)`,
    });
  } else {
    quote_shape_valid = true;
  }

  // ── Step 3: chain verify AK → intermediates → pinned vendor root ─
  let akCert: x509.X509Certificate;
  let intermediates: x509.X509Certificate[];
  let rootCerts: x509.X509Certificate[];
  try {
    akCert = new x509.X509Certificate(toArrayBuffer(akCertBytes));
    intermediates = intermediateCertsBytes.map((b) => new x509.X509Certificate(toArrayBuffer(b)));
    const pems = opts.rootPems ?? DEFAULT_PINNED_TPM_ROOTS;
    rootCerts = pems.map((pem) => new x509.X509Certificate(pem));
  } catch (err) {
    errors.push({ message: `x509 parse: ${messageOf(err)}` });
    return fail(errors, {
      cert_chain_valid,
      quote_signature_valid,
      quote_shape_valid,
      identity_bound,
    });
  }

  const nowDate = new Date(opts.now ? opts.now() : Date.now());

  try {
    const chainResult = await verifyTpmCertChain({
      leaf: akCert,
      intermediates,
      pinnedRoots: rootCerts,
      nowDate,
    });
    cert_chain_valid = chainResult.valid;
    if (!cert_chain_valid) {
      errors.push({ message: chainResult.reason });
    }
  } catch (err) {
    errors.push({ message: `chain verify crashed: ${messageOf(err)}` });
    return fail(errors, {
      cert_chain_valid,
      quote_signature_valid,
      quote_shape_valid,
      identity_bound,
    });
  }

  // ── Step 4: AK signature over SHA-256(attestBytes) ──────────────
  // TPM 2.0 AKs are most commonly ECDSA-P256 (the TCG's recommended
  // profile). Future RSA-2048 AKs land as an additional dispatch arm
  // once a real-RSA-TPM fixture is captured; today ECDSA is the only
  // shape our test surface exercises and the only shape the Rust
  // bridge will produce at landing.
  //
  // We route BOTH the `publicKey.export(...)` call AND the
  // `subtle.verify(...)` call through the SAME crypto provider — the
  // one registered with `@peculiar/x509`'s `cryptoProvider`. Mixing a
  // CryptoKey minted by `@peculiar/webcrypto` with Node's native
  // `globalThis.crypto.subtle.verify` throws "2nd argument is not of
  // type CryptoKey" because the two providers mint different internal
  // shapes. Staying on one provider keeps the SAB boundary clean.
  try {
    const provider = x509.cryptoProvider.get();
    const cryptoKey = await akCert.publicKey.export(
      { name: "ECDSA", namedCurve: "P-256" } as EcKeyImportParams,
      ["verify"],
      provider,
    );
    const sigOk = await provider.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" } as EcdsaParams,
      cryptoKey,
      sigBytes as BufferSource,
      attestBytes as BufferSource,
    );
    if (sigOk) {
      quote_signature_valid = true;
    } else {
      errors.push({
        message:
          "AK signature does not verify against SHA-256(TPMS_ATTEST) — quote may be tampered or AK mismatch",
      });
    }
  } catch (err) {
    errors.push({ message: `AK signature verify crashed: ${messageOf(err)}` });
  }

  // ── Step 5: identity binding via extraData ──────────────────────
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
      const canonicalBody = buildCanonicalTpmBody({
        attested_at: opts.expectedAttestedAt,
        device_id: opts.expectedDeviceId,
        identity_public_key: opts.expectedIdentityPublicKeyHex.toLowerCase(),
        motebit_id: opts.expectedMotebitId,
      });
      const derived = await sha256Bytes(new TextEncoder().encode(canonicalBody));
      if (bytesEq(derived, attest.extraData)) {
        identity_bound = true;
      } else {
        errors.push({
          message:
            "identity_bound: reconstructed SHA256(canonical body) does not equal transmitted extraData — body naming the caller's identity was not the body the TPM signed over",
        });
      }
    }
  } catch (err) {
    errors.push({ message: `identity binding crashed: ${messageOf(err)}` });
  }

  return {
    valid: cert_chain_valid && quote_signature_valid && quote_shape_valid && identity_bound,
    cert_chain_valid,
    quote_signature_valid,
    quote_shape_valid,
    identity_bound,
    errors,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function fail(
  errors: TpmVerifyError[],
  partial?: Partial<Omit<TpmVerifyResult, "valid" | "errors">>,
): TpmVerifyResult {
  return {
    valid: false,
    cert_chain_valid: partial?.cert_chain_valid ?? false,
    quote_signature_valid: partial?.quote_signature_valid ?? false,
    quote_shape_valid: partial?.quote_shape_valid ?? false,
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

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface ChainVerifyResult {
  readonly valid: boolean;
  readonly reason: string;
}

/**
 * Walk the TPM cert chain from AK → intermediates → one of the pinned
 * vendor roots. Enforces:
 *
 *   1. `X509ChainBuilder.build(leaf)` with the AK + intermediates + all
 *      pinned roots as the candidate pool produces a complete chain
 *      terminating at a self-signed cert.
 *   2. The chain's terminal cert's DER equals at least ONE of the pinned
 *      vendor roots — the only acceptable trust anchors.
 *   3. Every non-leaf cert in the chain carries
 *      `basicConstraints.cA === true`. A misissued leaf presented as an
 *      intermediate fails here even if its signature chains.
 *   4. Every cert's signature verifies under its issuer's public key.
 *   5. Every cert is within its validity window at `nowDate`.
 */
async function verifyTpmCertChain(input: {
  readonly leaf: x509.X509Certificate;
  readonly intermediates: readonly x509.X509Certificate[];
  readonly pinnedRoots: readonly x509.X509Certificate[];
  readonly nowDate: Date;
}): Promise<ChainVerifyResult> {
  const { leaf, intermediates, pinnedRoots, nowDate } = input;

  const builder = new x509.X509ChainBuilder({
    certificates: [leaf, ...intermediates, ...pinnedRoots],
  });
  const chain = await builder.build(leaf);

  const terminal = chain[chain.length - 1]!;
  const terminalSelfSigned = await terminal.isSelfSigned();
  if (!terminalSelfSigned) {
    return {
      valid: false,
      reason: "chain does not terminate at a self-signed root",
    };
  }

  // Terminal DER must byte-equal at least one pinned vendor root. This
  // is what defines "this is a TPM we accept" — the self-signed check
  // alone would allow an attacker-chosen root to pass.
  const terminalDer = new Uint8Array(terminal.rawData);
  const matchedPinnedRoot = pinnedRoots.some((r) =>
    bytesEq(terminalDer, new Uint8Array(r.rawData)),
  );
  if (!matchedPinnedRoot) {
    return {
      valid: false,
      reason:
        "chain terminal cert DER does not match any pinned TPM vendor root " +
        "(Infineon / Nuvoton / STMicro / Intel PTT)",
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
 * Reconstruct the byte-identical canonical body the Rust TPM bridge
 * composes at quote time. Must stay byte-equal to what
 * `apps/desktop/src-tauri/src/tpm.rs::canonical_body` will emit when
 * the full `tss-esapi`-backed path lands.
 *
 * Ordering: alphabetical (JCS):
 *   attested_at, device_id, identity_public_key, motebit_id, platform,
 *   version.
 *
 * `platform` is always `"tpm"` and `version` is always `"1"` — both
 * constants, matching the sibling App Attest path's shape exactly.
 */
function buildCanonicalTpmBody(input: {
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
    `,"platform":"tpm"` +
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
