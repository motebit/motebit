/**
 * WebAuthn platform-authenticator attestation verifier — the core
 * judgment function this package exports.
 *
 * Flow (matches the W3C WebAuthn `packed` attestation verification
 * recipe, plus the motebit-specific identity-key binding step):
 *
 *   1. Split the receipt into (attestationObjectBase64, clientDataJSONBase64).
 *   2. CBOR-decode the attestation object to {fmt, attStmt:{alg, sig, x5c?},
 *      authData}. Assert fmt === "packed" in v1. Other fmts are named-not-
 *      supported errors (tpm / android-key / android-safetynet / fido-u2f /
 *      apple / none) — each is a separate additive arm future passes can add.
 *   3a. Full attestation (x5c present): parse leaf, walk the chain against
 *       the pinned FIDO roots. Every non-leaf must carry basicConstraints.cA
 *       === true; every signature must verify; every cert must be within
 *       its validity window; the terminal cert's DER must equal one of the
 *       pinned roots byte-for-byte. Then verify `attStmt.sig` over
 *       `authData || clientDataHash` using the leaf's public key and alg.
 *   3b. Self attestation (no x5c): extract the credential public key from
 *       `authData.attestedCredentialData`. Verify `attStmt.sig` over
 *       `authData || clientDataHash` using that key. Self-attested
 *       credentials carry no vendor chain and score as hardware-exported-
 *       equivalent (0.5) in the semiring — still better than software
 *       because the binding is still hardware-held, just not chain-proven.
 *   4. Parse `clientDataJSON` (UTF-8 JSON): assert its `challenge` field
 *      (base64url-decoded) byte-equals the reconstructed
 *      SHA256(canonical body) the caller threads in via
 *      (motebit_id, device_id, identity_public_key, attested_at). The
 *      identity-binding step — byte-identical contract to App Attest.
 *   5. Parse `authData` minimally: `rpIdHash` is the first 32 bytes; the
 *      caller's RP ID (e.g. "motebit.com") hashed with SHA-256 must match
 *      byte-for-byte. Bundle/RP binding.
 *
 * FIDO Metadata Service (MDS) dynamic fetch is explicitly out of scope —
 * the pinned-roots model keeps the verifier sovereign and offline.
 * Rotations land as additive constants in `fido-roots.ts`.
 */

import * as x509 from "@peculiar/x509";
import { decode as cborDecode } from "cbor2";

import type { HardwareAttestationClaim } from "@motebit/protocol";

import { parseWebAuthnAttestationObjectCbor } from "./cbor.js";
import { DEFAULT_FIDO_ROOTS, WEBAUTHN_FMT_PACKED } from "./fido-roots.js";

export interface WebAuthnVerifyOptions {
  /**
   * Relying Party ID the credential was minted for (e.g. "motebit.com").
   * Hashed with SHA-256 and byte-compared against authData.rpIdHash.
   */
  readonly expectedRpId: string;
  /**
   * Ed25519 identity key (lowercase hex) the motebit VC claims. The
   * reconstructed attestation body MUST name this key.
   */
  readonly expectedIdentityPublicKeyHex: string;
  /**
   * motebit_id from the credential subject. Participates in the canonical
   * body the web mint path signs; re-derived here and byte-compared
   * against clientDataJSON.challenge so a malicious client cannot
   * substitute a different body.
   */
  readonly expectedMotebitId?: string;
  /** device_id from the credential subject. */
  readonly expectedDeviceId?: string;
  /** attested_at (unix ms) from the credential subject. */
  readonly expectedAttestedAt?: number;
  /**
   * Override the pinned FIDO-root accept-set. Tests fabricate their own
   * chain and supply its root PEM here so chain verification exercises
   * the same code path without a real vendor-signed leaf.
   */
  readonly rootPems?: ReadonlyArray<string>;
  /** Clock for chain-validity checks. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Override the accepted attestation-format string. Defaults to
   * `"packed"`. Exposed only so test fabrications that exercise chain-
   * validation edge cases can still reach the code path without
   * colliding with a production fmt.
   */
  readonly expectedFmt?: string;
}

export interface WebAuthnVerifyError {
  readonly message: string;
}

export interface WebAuthnVerifyResult {
  readonly valid: boolean;
  readonly cert_chain_valid: boolean;
  /**
   * True when the signature verifies AND the signer is the same key
   * the credential subject claims (chain-rooted for full attestation;
   * the credential public key itself for self attestation).
   */
  readonly signature_valid: boolean;
  /** True when `authData.rpIdHash === SHA256(expectedRpId)`. */
  readonly rp_bound: boolean;
  /**
   * True when `clientDataJSON.challenge` (base64url-decoded) equals
   * SHA256(reconstructed canonical body naming the caller's identity).
   */
  readonly identity_bound: boolean;
  /**
   * Attestation kind chosen by the presence / absence of x5c in the
   * attestation object. `"self"` scores lower in the semiring (0.5 —
   * treated as hardware-exported equivalent) because the binding is not
   * chain-rooted; `"full"` scores 1.0.
   */
  readonly attestation_kind: "full" | "self" | null;
  readonly errors: readonly WebAuthnVerifyError[];
}

/** COSE algorithm identifiers we support in v1. */
const COSE_ALG_ES256 = -7; // ECDSA w/ SHA-256 on P-256

/** OID for X.509 basic-constraints extension. */
const BASIC_CONSTRAINTS_OID = "2.5.29.19";

/**
 * WebAuthn platform-authenticator attestation verifier.
 *
 * Pure. No network. No filesystem. Deterministic given `now()`.
 *
 * `claim` is the `HardwareAttestationClaim` as carried inside the motebit
 * AgentTrustCredential. For WebAuthn, the `attestation_receipt` field is
 * two base64url segments separated by `.`:
 *
 *   `{attestationObjectB64}.{clientDataJSONB64}`
 *
 * The web mint path constructs this shape; see
 * `apps/web/src/mint-hardware-credential.ts`.
 */
export async function verifyWebAuthnAttestation(
  claim: HardwareAttestationClaim,
  opts: WebAuthnVerifyOptions,
): Promise<WebAuthnVerifyResult> {
  const errors: WebAuthnVerifyError[] = [];
  let cert_chain_valid = false;
  let signature_valid = false;
  let rp_bound = false;
  let identity_bound = false;
  let attestation_kind: "full" | "self" | null = null;

  if (!claim.attestation_receipt) {
    errors.push({ message: "webauthn claim missing `attestation_receipt`" });
    return fail(errors, {
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
    });
  }

  const parts = claim.attestation_receipt.split(".");
  if (parts.length !== 2) {
    errors.push({
      message: `attestation_receipt must be 2 base64url parts (attObj.clientDataJSON); got ${parts.length}`,
    });
    return fail(errors, {
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
    });
  }
  const [attObjB64, clientDataJsonB64] = parts as [string, string];

  let attestationObjectBytes: Uint8Array;
  let clientDataJsonBytes: Uint8Array;
  try {
    attestationObjectBytes = fromBase64Url(attObjB64);
    clientDataJsonBytes = fromBase64Url(clientDataJsonB64);
  } catch (err) {
    errors.push({ message: `base64url decode failed: ${messageOf(err)}` });
    return fail(errors, {
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
    });
  }

  let cbor;
  try {
    cbor = parseWebAuthnAttestationObjectCbor(attestationObjectBytes);
  } catch (err) {
    errors.push({ message: `CBOR decode: ${messageOf(err)}` });
    return fail(errors, {
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
    });
  }

  const expectedFmt = opts.expectedFmt ?? WEBAUTHN_FMT_PACKED;
  if (cbor.fmt !== expectedFmt) {
    errors.push({
      message: `attestation fmt is \`${cbor.fmt}\`; only \`${expectedFmt}\` is supported in v1 (tpm / android-key / android-safetynet / fido-u2f / apple / none are additive future arms)`,
    });
    return fail(errors, {
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
    });
  }

  if (cbor.sig === null) {
    errors.push({ message: "attStmt.sig missing — packed attestation requires a signature" });
    return fail(errors, {
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
    });
  }
  if (cbor.alg === null) {
    errors.push({ message: "attStmt.alg missing — packed attestation requires an algorithm" });
    return fail(errors, {
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
    });
  }
  if (cbor.alg !== COSE_ALG_ES256) {
    errors.push({
      message: `attStmt.alg ${cbor.alg} not supported in v1 (only ES256 / -7; RS256 and EdDSA are additive future arms)`,
    });
    return fail(errors, {
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
    });
  }

  const nowDate = new Date(opts.now ? opts.now() : Date.now());

  // Compute the signed bytes common to both attestation kinds: the
  // WebAuthn spec prescribes verifying the packed signature over
  // `authData || clientDataHash` where clientDataHash = SHA256(clientDataJSON).
  const clientDataHash = await sha256Bytes(clientDataJsonBytes);
  const signedBytes = concatBytes(cbor.authData, clientDataHash);

  attestation_kind = cbor.x5c.length > 0 ? "full" : "self";

  // ── Signature + chain verification ────────────────────────────────
  if (attestation_kind === "full") {
    // Full attestation — verify chain against pinned FIDO roots, then
    // verify signature under the leaf's public key.
    try {
      const leaf = new x509.X509Certificate(toArrayBuffer(cbor.x5c[0]!));
      const chainCerts: x509.X509Certificate[] = [leaf];
      for (let i = 1; i < cbor.x5c.length; i++) {
        chainCerts.push(new x509.X509Certificate(toArrayBuffer(cbor.x5c[i]!)));
      }

      const rootPems = opts.rootPems ?? DEFAULT_FIDO_ROOTS;
      if (rootPems.length === 0) {
        errors.push({ message: "no pinned FIDO roots configured" });
        return fail(errors, {
          cert_chain_valid,
          signature_valid,
          rp_bound,
          identity_bound,
          attestation_kind,
        });
      }

      let parsedRoots: x509.X509Certificate[];
      try {
        parsedRoots = rootPems.map((pem) => new x509.X509Certificate(pem));
      } catch (err) {
        errors.push({ message: `x509 root parse: ${messageOf(err)}` });
        return fail(errors, {
          cert_chain_valid,
          signature_valid,
          rp_bound,
          identity_bound,
          attestation_kind,
        });
      }

      const chainResult = await verifyCertChain({
        supplied: chainCerts,
        roots: parsedRoots,
        nowDate,
      });
      cert_chain_valid = chainResult.valid;
      if (!cert_chain_valid) {
        errors.push({ message: chainResult.reason });
      } else {
        // Chain verified — now verify the packed signature under leaf.
        try {
          const ok = await verifyP256Signature(leaf.publicKey, cbor.sig, signedBytes);
          signature_valid = ok;
          if (!ok) {
            errors.push({
              message: "packed signature did not verify under leaf public key",
            });
          }
        } catch (err) {
          errors.push({ message: `packed signature verify crashed: ${messageOf(err)}` });
        }
      }
    } catch (err) {
      errors.push({ message: `x509 leaf parse: ${messageOf(err)}` });
    }
  } else {
    // Self attestation — no chain; verify signature against the credential
    // public key embedded in authData.attestedCredentialData. The credential
    // key is the `one` key the authenticator is asserting ownership of —
    // proving it signed the challenge is the only claim self-attestation
    // makes.
    try {
      const credPubKey = extractCredentialPublicKeyFromAuthData(cbor.authData);
      const ok = await verifyP256SignatureFromCoseKey(credPubKey, cbor.sig, signedBytes);
      // Chain-validity is trivially true for self attestation — there is
      // no chain, so we report `cert_chain_valid: true` to mean "no chain
      // was required for this kind". The kind field is the discriminator
      // the scorer reads.
      cert_chain_valid = true;
      signature_valid = ok;
      if (!ok) {
        errors.push({
          message: "self-attestation signature did not verify under credential public key",
        });
      }
    } catch (err) {
      errors.push({ message: `self-attestation verify crashed: ${messageOf(err)}` });
    }
  }

  // ── RP binding ────────────────────────────────────────────────────
  try {
    if (cbor.authData.length < 32) {
      errors.push({ message: `authData shorter than 32 bytes (got ${cbor.authData.length})` });
    } else {
      const rpIdHash = cbor.authData.subarray(0, 32);
      const expected = await sha256Bytes(new TextEncoder().encode(opts.expectedRpId));
      if (bytesEq(rpIdHash, expected)) {
        rp_bound = true;
      } else {
        errors.push({
          message: `authData.rpIdHash does not equal SHA256("${opts.expectedRpId}")`,
        });
      }
    }
  } catch (err) {
    errors.push({ message: `rp binding crashed: ${messageOf(err)}` });
  }

  // ── Identity binding ──────────────────────────────────────────────
  // Parse clientDataJSON, decode its `challenge` (base64url), and
  // byte-compare against the SHA256 of the reconstructed canonical body
  // naming the caller's identity. This is the cross-stack binding —
  // without it, every other step would prove only that SOME WebAuthn
  // platform authenticator did something, not that the Ed25519 key the
  // credential subject claims is actually on this device.
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
      const clientData = JSON.parse(new TextDecoder().decode(clientDataJsonBytes)) as unknown;
      if (clientData === null || typeof clientData !== "object") {
        errors.push({ message: "identity_bound: clientDataJSON is not a JSON object" });
      } else {
        const challengeB64 = (clientData as Record<string, unknown>).challenge;
        if (typeof challengeB64 !== "string") {
          errors.push({
            message: "identity_bound: clientDataJSON.challenge missing or not a string",
          });
        } else {
          let challengeBytes: Uint8Array;
          try {
            challengeBytes = fromBase64Url(challengeB64);
          } catch (err) {
            errors.push({
              message: `identity_bound: clientDataJSON.challenge base64url decode failed: ${messageOf(err)}`,
            });
            return buildResult();
          }
          const canonicalBody = buildCanonicalAttestationBody({
            attested_at: opts.expectedAttestedAt,
            device_id: opts.expectedDeviceId,
            identity_public_key: opts.expectedIdentityPublicKeyHex.toLowerCase(),
            motebit_id: opts.expectedMotebitId,
          });
          const derived = await sha256Bytes(new TextEncoder().encode(canonicalBody));
          if (bytesEq(derived, challengeBytes)) {
            identity_bound = true;
          } else {
            errors.push({
              message:
                "identity_bound: reconstructed SHA256(canonical body) does not equal clientDataJSON.challenge — body naming the caller's identity was not the body the browser signed over",
            });
          }
        }
      }
    }
  } catch (err) {
    errors.push({ message: `identity binding crashed: ${messageOf(err)}` });
  }

  return buildResult();

  function buildResult(): WebAuthnVerifyResult {
    return {
      valid: cert_chain_valid && signature_valid && rp_bound && identity_bound,
      cert_chain_valid,
      signature_valid,
      rp_bound,
      identity_bound,
      attestation_kind,
      errors,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function fail(
  errors: WebAuthnVerifyError[],
  partial: {
    cert_chain_valid: boolean;
    signature_valid: boolean;
    rp_bound: boolean;
    identity_bound: boolean;
    attestation_kind: "full" | "self" | null;
  },
): WebAuthnVerifyResult {
  return {
    valid: false,
    cert_chain_valid: partial.cert_chain_valid,
    signature_valid: partial.signature_valid,
    rp_bound: partial.rp_bound,
    identity_bound: partial.identity_bound,
    attestation_kind: partial.attestation_kind,
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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

/**
 * Reconstruct the byte-identical canonical body the web mint path
 * composes at WebAuthn creation time. Must stay byte-equal to
 * `buildCanonicalAttestationBody` in
 * `apps/web/src/mint-hardware-credential.ts`.
 *
 * Ordering: alphabetical (JCS), which is what the browser-side mint emits:
 *   attested_at, device_id, identity_public_key, motebit_id, platform,
 *   version.
 *
 * `platform` is always `"webauthn"` and `version` is always `"1"` — both
 * constants live in the web mint path and must match exactly.
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
    `,"platform":"webauthn"` +
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

interface ChainVerifyResult {
  readonly valid: boolean;
  readonly reason: string;
}

/**
 * Build and verify a FIDO attestation chain. The supplied certs begin
 * with the leaf and walk toward the issuer; the caller supplies the
 * pinned-root accept-set. We match one of the roots by subject DN and
 * byte-equal DER after chain traversal. Mirrors the App Attest chain
 * verifier's invariants:
 *
 *   1. `X509ChainBuilder.build(leaf)` returns a chain terminating at a
 *      self-signed cert reachable from the pool of (supplied, roots).
 *   2. The terminal cert's DER byte-equals one of the pinned roots.
 *   3. Every non-leaf cert carries `basicConstraints.cA === true`.
 *   4. Every signature verifies under its issuer's public key.
 *   5. Every cert is within its validity window at `nowDate`.
 */
async function verifyCertChain(input: {
  readonly supplied: ReadonlyArray<x509.X509Certificate>;
  readonly roots: ReadonlyArray<x509.X509Certificate>;
  readonly nowDate: Date;
}): Promise<ChainVerifyResult> {
  const { supplied, roots, nowDate } = input;
  const leaf = supplied[0]!;

  const builder = new x509.X509ChainBuilder({
    certificates: [...supplied, ...roots],
  });
  const chain = await builder.build(leaf);

  const terminal = chain[chain.length - 1]!;
  const terminalSelfSigned = await terminal.isSelfSigned();
  if (!terminalSelfSigned) {
    return { valid: false, reason: "chain does not terminate at a self-signed root" };
  }
  // Byte-equal against the pinned accept-set — any of the supplied roots
  // is acceptable, but the terminal MUST match one.
  const terminalDer = new Uint8Array(terminal.rawData);
  const matchesPinned = roots.some((root) => bytesEq(terminalDer, new Uint8Array(root.rawData)));
  if (!matchesPinned) {
    return {
      valid: false,
      reason: "chain terminal cert DER does not match any pinned FIDO root",
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
 * Verify an ECDSA-P256 signature using a `@peculiar/x509` public-key
 * handle. The leaf's `publicKey` is already a `PublicKey` wrapper; we
 * import into WebCrypto with SHA-256 and verify the DER-encoded
 * signature (packed fmt ships the signature in ASN.1 DER).
 */
async function verifyP256Signature(
  leafPublicKey: x509.PublicKey,
  signatureDer: Uint8Array,
  signedBytes: Uint8Array,
): Promise<boolean> {
  // Import the leaf's public key into the same WebCrypto provider
  // `globalThis.crypto` exposes — `leafPublicKey.rawData` is the
  // SubjectPublicKeyInfo DER bytes the cert carries; WebCrypto accepts
  // it via the `spki` import format. This keeps the CryptoKey handle
  // bound to the caller-installed `crypto` provider so the subsequent
  // `subtle.verify` call doesn't hit the "2nd argument is not of type
  // CryptoKey" cross-provider mismatch.
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "spki",
    leafPublicKey.rawData as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const rawSig = derToRawP256(signatureDer);
  const ok = await globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    rawSig as BufferSource,
    signedBytes as BufferSource,
  );
  return ok;
}

/**
 * Verify an ECDSA-P256 signature using a COSE_Key-encoded public key
 * extracted from `authData.attestedCredentialData` (self-attestation
 * path).
 */
async function verifyP256SignatureFromCoseKey(
  coseKeyBytes: Uint8Array,
  signatureDer: Uint8Array,
  signedBytes: Uint8Array,
): Promise<boolean> {
  const { x, y } = parseCoseEc2P256(coseKeyBytes);
  // Assemble an uncompressed SEC1 public key: 0x04 || x(32) || y(32)
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 33);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const rawSig = derToRawP256(signatureDer);
  return globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    rawSig as BufferSource,
    signedBytes as BufferSource,
  );
}

/**
 * WebAuthn `authData` layout (bytes):
 *   rpIdHash(32) || flags(1) || counter(4) || [attestedCredentialData] || [extensions]
 *
 * `attestedCredentialData` (when flags.AT set):
 *   aaguid(16) || credentialIdLen(2) || credentialId(credentialIdLen) || credentialPublicKey (COSE_Key CBOR)
 *
 * Returns the raw COSE_Key CBOR bytes. The COSE_Key parser does the
 * field-level extraction in `parseCoseEc2P256`.
 */
function extractCredentialPublicKeyFromAuthData(authData: Uint8Array): Uint8Array {
  if (authData.length < 37) {
    throw new Error(`authData too short for attestedCredentialData (${authData.length} < 37)`);
  }
  const flags = authData[32]!;
  const atFlag = (flags & 0x40) !== 0;
  if (!atFlag) {
    throw new Error("authData.flags.AT is not set — attestedCredentialData missing");
  }
  // Skip rpIdHash(32) + flags(1) + counter(4) = 37, then aaguid(16) = 53
  if (authData.length < 55) {
    throw new Error("authData too short to carry aaguid + credentialIdLen");
  }
  const credIdLen = (authData[53]! << 8) | authData[54]!;
  const credIdEnd = 55 + credIdLen;
  if (authData.length < credIdEnd) {
    throw new Error("authData too short to carry credentialId");
  }
  // The remainder of authData (minus any trailing extensions) is the
  // COSE_Key CBOR. For v1 we do not support extensions, so we consume
  // to the end.
  return authData.subarray(credIdEnd);
}

/**
 * Parse the subset of COSE_Key fields needed to reconstruct an ES256
 * public key: kty=2 (EC2), alg=-7 (ES256), crv=1 (P-256), x, y.
 *
 * COSE_Key is a CBOR map with integer keys. The shape is well-defined
 * and fixed for ES256 credentials — we delegate the CBOR parse to
 * `cbor2` and validate the int-keyed field presence here.
 */
function parseCoseEc2P256(coseBytes: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  const decoded: unknown = cborDecode(coseBytes);
  if (!(decoded instanceof Map)) {
    throw new Error("COSE_Key is not a CBOR map");
  }
  // cbor2 types its Map as `Map<any, any>`; narrow via `unknown` reads
  // so the COSE_Key field-presence checks below are type-safe.
  const map = decoded as Map<unknown, unknown>;
  const kty: unknown = map.get(1);
  const alg: unknown = map.get(3);
  const crv: unknown = map.get(-1);
  const x: unknown = map.get(-2);
  const y: unknown = map.get(-3);
  if (kty !== 2) throw new Error(`COSE_Key.kty ${String(kty)} is not EC2 (2)`);
  if (alg !== -7) throw new Error(`COSE_Key.alg ${String(alg)} is not ES256 (-7)`);
  if (crv !== 1) throw new Error(`COSE_Key.crv ${String(crv)} is not P-256 (1)`);
  if (!(x instanceof Uint8Array) || x.length !== 32) {
    throw new Error(`COSE_Key.x missing or wrong length`);
  }
  if (!(y instanceof Uint8Array) || y.length !== 32) {
    throw new Error(`COSE_Key.y missing or wrong length`);
  }
  return {
    x: new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice(),
    y: new Uint8Array(y.buffer, y.byteOffset, y.byteLength).slice(),
  };
}

/**
 * Convert an ASN.1 DER-encoded ECDSA signature to the raw r||s form
 * WebCrypto expects (64 bytes for P-256).
 *
 *   SEQUENCE { INTEGER r, INTEGER s }
 *
 * DER integers are signed big-endian with a leading 0x00 if the MSB of
 * the unsigned value is set; we strip leading zeros and left-pad to 32.
 */
function derToRawP256(derSig: Uint8Array): Uint8Array {
  let i = 0;
  if (derSig[i++] !== 0x30) throw new Error("ECDSA signature not a DER SEQUENCE");
  let seqLen = derSig[i++]!;
  if (seqLen & 0x80) {
    const nBytes = seqLen & 0x7f;
    seqLen = 0;
    for (let j = 0; j < nBytes; j++) seqLen = (seqLen << 8) | derSig[i++]!;
  }
  void seqLen;
  if (derSig[i++] !== 0x02) throw new Error("ECDSA signature.r not a DER INTEGER");
  const rLen = derSig[i++]!;
  const r = derSig.subarray(i, i + rLen);
  i += rLen;
  if (derSig[i++] !== 0x02) throw new Error("ECDSA signature.s not a DER INTEGER");
  const sLen = derSig[i++]!;
  const s = derSig.subarray(i, i + sLen);

  const rPadded = leftPadTo32(stripLeadingZero(r));
  const sPadded = leftPadTo32(stripLeadingZero(s));
  const out = new Uint8Array(64);
  out.set(rPadded, 0);
  out.set(sPadded, 32);
  return out;
}

function stripLeadingZero(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0x00) i++;
  return bytes.subarray(i);
}

function leftPadTo32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32)
    throw new Error(`ECDSA integer longer than 32 bytes (got ${bytes.length})`);
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}
