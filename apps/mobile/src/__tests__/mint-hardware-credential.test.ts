/**
 * Tests for mobile's `mintHardwareCredential` — the composer that
 * stitches mint-attestation + credential-signing into a single
 * verifiable artifact.
 *
 * Sibling of `apps/desktop/src/__tests__/mint-hardware-credential.test.ts` —
 * same SE-signed vs software-fallback matrix, same end-to-end
 * round-trip through `@motebit/crypto::verify`. The iOS native module
 * is simulated with `@noble/curves/p256` (see `simulateSeMint`) so the
 * tests never need an actual Secure Enclave at test time — the Swift
 * code's real-hardware behaviour is exercised in integration on a
 * physical device.
 *
 * What this verifies:
 *   1. SE happy path produces `platform: "secure_enclave"` with a
 *      two-part attestation receipt.
 *   2. SE credential round-trips through `verify()` with
 *      `hardware_attestation.valid === true`.
 *   3. When the SE is unavailable, the credential still mints with a
 *      truthful `platform: "software"` fallback.
 *   4. Software credentials still verify end-to-end
 *      (`hardware_attestation.valid === false` is the correct report
 *      for "no hardware channel", not a failure).
 *   5. Envelope shape invariants: issuer === subject.id, type array
 *      includes VerifiableCredential + AgentTrustCredential, proof is
 *      eddsa-jcs-2022, hex is lowercase-normalized.
 *   6. JSON serialization round-trip still verifies (motebit emits
 *      credentials as JSON across the wire).
 */

import { describe, expect, it, beforeAll, vi } from "vitest";

// Mock `expo`'s `requireNativeModule` before the mint-hardware-credential
// module evaluates — otherwise each shim's top-level
// `requireNativeModule("Expo*")` call would throw in Node. Each test
// injects its own fake native module, so the global stub is a no-op
// whose methods are never actually called.
vi.mock("expo", () => ({
  requireNativeModule: (name: string) => {
    if (name === "ExpoAppAttest") {
      return { appAttestAvailable: vi.fn(), appAttestMint: vi.fn() };
    }
    if (name === "ExpoPlayIntegrity") {
      return { playIntegrityAvailable: vi.fn(), playIntegrityMint: vi.fn() };
    }
    return { seAvailable: vi.fn(), seMintAttestation: vi.fn() };
  },
}));

// `react-native` ships a non-trivial runtime; all we need from it is
// `Platform.OS` as a default for the cascade, and every test overrides
// that via the `platform` option anyway. Stubbing keeps the unit tests
// Node-portable without pulling in the RN module graph.
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";

import { verify } from "@motebit/crypto";
import { canonicalJson, toBase64Url } from "@motebit/crypto";

import { mintHardwareCredential } from "../mint-hardware-credential.js";
import type { NativeSecureEnclave } from "../../modules/expo-secure-enclave/src/ExpoSecureEnclaveModule";
import type { SeMintResult } from "../../modules/expo-secure-enclave/src/ExpoSecureEnclave.types";
import type { NativeAppAttest } from "../../modules/expo-app-attest/src/ExpoAppAttestModule";
import type { AppAttestMintResult } from "../../modules/expo-app-attest/src/ExpoAppAttest.types";
import type { NativePlayIntegrity } from "../../modules/expo-play-integrity/src/ExpoPlayIntegrityModule";
import type { PlayIntegrityMintResult } from "../../modules/expo-play-integrity/src/ExpoPlayIntegrity.types";

beforeAll(() => {
  if (!ed.hashes.sha512) {
    ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  }
});

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeIdentity(): Promise<{
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyHex: toHex(publicKey) };
}

/**
 * Simulate the iOS Swift SE bridge: given the canonical body the Swift
 * side would compose, generate an in-process P-256 keypair, sign
 * `SHA256(body)`, and return the same `{ body_base64, signature_der_base64 }`
 * shape the real native module emits. Matches the desktop
 * `simulateSeMint` helper byte-for-byte — canonical JSON, JCS-ordered
 * fields, base64url-no-pad output.
 *
 * The real Swift code uses
 * `SecKeyCreateSignature(..., .ecdsaSignatureMessageX962SHA256, ...)`
 * which hashes internally with SHA-256; the `@noble/curves/p256.sign`
 * call here with `prehash: false` over `sha256(body)` produces the
 * same DER-encoded signature format the verifier consumes.
 */
function simulateSeMint(args: {
  motebitId: string;
  deviceId: string;
  identityPublicKeyHex: string;
  attestedAt: number;
}): SeMintResult {
  const sePrivate = p256.utils.randomPrivateKey();
  const sePublicBytes = p256.getPublicKey(sePrivate, true);
  const sePublicHex = toHex(sePublicBytes);

  const bodyJson = canonicalJson({
    version: "1",
    algorithm: "ecdsa-p256-sha256",
    motebit_id: args.motebitId,
    device_id: args.deviceId,
    identity_public_key: args.identityPublicKeyHex.toLowerCase(),
    se_public_key: sePublicHex,
    attested_at: args.attestedAt,
  });
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const digest = sha256(bodyBytes);
  const sig = p256.sign(digest, sePrivate, { prehash: false });
  const sigDer = sig.toDERRawBytes();

  return {
    body_base64: toBase64Url(bodyBytes),
    signature_der_base64: toBase64Url(sigDer),
  };
}

/** Build a `NativeSecureEnclave` fake with the given behaviours. */
function makeNative(opts: {
  available: boolean;
  mint?: (args: {
    motebitId: string;
    deviceId: string;
    identityPublicKeyHex: string;
    attestedAt: number;
  }) => SeMintResult | Promise<SeMintResult>;
  mintThrows?: unknown;
}): NativeSecureEnclave {
  return {
    seAvailable: async () => opts.available,
    seMintAttestation: async (args: {
      motebitId: string;
      deviceId: string;
      identityPublicKeyHex: string;
      attestedAt: number;
    }) => {
      if (opts.mintThrows !== undefined) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- simulating native-module rejection shape
        throw opts.mintThrows;
      }
      if (!opts.mint) throw new Error("no mint impl provided");
      return opts.mint(args);
    },
  } as unknown as NativeSecureEnclave;
}

/** Build a `NativeAppAttest` fake with the given behaviours. */
function makeNativeAppAttest(opts: {
  available: boolean;
  mint?: (args: {
    motebitId: string;
    deviceId: string;
    identityPublicKeyHex: string;
    attestedAt: number;
  }) => AppAttestMintResult | Promise<AppAttestMintResult>;
  mintThrows?: unknown;
}): NativeAppAttest {
  return {
    appAttestAvailable: async () => opts.available,
    appAttestMint: async (args: {
      motebitId: string;
      deviceId: string;
      identityPublicKeyHex: string;
      attestedAt: number;
    }) => {
      if (opts.mintThrows !== undefined) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- simulating native-module rejection shape
        throw opts.mintThrows;
      }
      if (!opts.mint) throw new Error("no mint impl provided");
      return opts.mint(args);
    },
  } as unknown as NativeAppAttest;
}

/** A minimal App Attest shape — opaque bytes in each segment. */
function fakeAppAttestMint(): AppAttestMintResult {
  return {
    attestation_object_base64: toBase64Url(new TextEncoder().encode("cbor-attestation-object")),
    key_id_base64: toBase64Url(new TextEncoder().encode("fake-key-id")),
    client_data_hash_base64: toBase64Url(new Uint8Array(32)),
  };
}

/** Build a `NativePlayIntegrity` fake with the given behaviours. */
function makeNativePlayIntegrity(opts: {
  available: boolean;
  mint?: (args: {
    motebitId: string;
    deviceId: string;
    identityPublicKeyHex: string;
    attestedAt: number;
  }) => PlayIntegrityMintResult | Promise<PlayIntegrityMintResult>;
  mintThrows?: unknown;
}): NativePlayIntegrity {
  return {
    playIntegrityAvailable: async () => opts.available,
    playIntegrityMint: async (args: {
      motebitId: string;
      deviceId: string;
      identityPublicKeyHex: string;
      attestedAt: number;
    }) => {
      if (opts.mintThrows !== undefined) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- simulating native-module rejection shape
        throw opts.mintThrows;
      }
      if (!opts.mint) throw new Error("no mint impl provided");
      return opts.mint(args);
    },
  } as unknown as NativePlayIntegrity;
}

/** A minimal Play Integrity shape — an opaque JWT string + echoed nonce. */
function fakePlayIntegrityMint(): PlayIntegrityMintResult {
  const header = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: "kid-fake" })),
  );
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ nonce: "fake" })));
  const sig = toBase64Url(new Uint8Array(64));
  return {
    jwt: `${header}.${payload}.${sig}`,
    nonce_base64url: "fake",
  };
}

// ── Android Play Integrity happy path ───────────────────────────────

describe("mintHardwareCredential — Play Integrity happy path (Android)", () => {
  it("emits platform:'play_integrity' with the raw JWT as the receipt when PI is available", async () => {
    const id = await makeIdentity();
    const nativePlayIntegrity = makeNativePlayIntegrity({
      available: true,
      mint: fakePlayIntegrityMint,
    });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "android-dev-1",
      now: () => 1_700_000_000_000,
      platform: "android",
      nativePlayIntegrity,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("play_integrity");
    const receipt = cred.credentialSubject.hardware_attestation.attestation_receipt;
    expect(receipt).toBeDefined();
    // The Play Integrity wire format is the raw JWT — 3 segments by
    // construction.
    expect(receipt!.split(".").length).toBe(3);
  });

  it("falls back to software on Android when Play Integrity is unavailable", async () => {
    const id = await makeIdentity();
    const nativePlayIntegrity = makeNativePlayIntegrity({ available: false });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "android-dev-1",
      now: () => 1_700_000_000_000,
      platform: "android",
      nativePlayIntegrity,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
  });

  it("falls back to software on Android when Play Integrity mint throws", async () => {
    const id = await makeIdentity();
    const nativePlayIntegrity = makeNativePlayIntegrity({
      available: true,
      mintThrows: Object.assign(new Error("google services unavailable"), {
        code: "platform_blocked",
      }),
    });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "android-dev-1",
      now: () => 1_700_000_000_000,
      platform: "android",
      nativePlayIntegrity,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
  });

  it("does not consult App Attest / SE on Android even if their fakes claim available", async () => {
    // The cascade is OS-scoped: on Android the iOS adapters are never
    // consulted, regardless of their stub behaviour. This test documents
    // that routing intent.
    const id = await makeIdentity();
    const nativePlayIntegrity = makeNativePlayIntegrity({ available: false });
    const nativeAppAttest = makeNativeAppAttest({ available: true, mint: fakeAppAttestMint });
    const native = makeNative({ available: true, mint: simulateSeMint });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "android-dev-1",
      now: () => 1_700_000_000_000,
      platform: "android",
      nativePlayIntegrity,
      nativeAppAttest,
      native,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
  });
});

// ── App Attest happy path ───────────────────────────────────────────

describe("mintHardwareCredential — App Attest happy path", () => {
  it("emits platform:'device_check' with a 3-segment receipt when App Attest is available", async () => {
    const id = await makeIdentity();
    const nativeAppAttest = makeNativeAppAttest({
      available: true,
      mint: fakeAppAttestMint,
    });
    // Explicitly pass an SE fake that claims unavailable so the test
    // documents the routing intent — App Attest wins regardless.
    const native = makeNative({ available: false });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      now: () => 1_700_000_000_000,
      native,
      nativeAppAttest,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("device_check");
    const receipt = cred.credentialSubject.hardware_attestation.attestation_receipt;
    expect(receipt).toBeDefined();
    expect(receipt!.split(".").length).toBe(3);
  });

  it("falls back to SE when App Attest mint throws", async () => {
    const id = await makeIdentity();
    const nativeAppAttest = makeNativeAppAttest({
      available: true,
      mintThrows: Object.assign(new Error("device check unavailable"), { code: "not_supported" }),
    });
    const native = makeNative({ available: true, mint: simulateSeMint });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      now: () => 1_700_000_000_000,
      native,
      nativeAppAttest,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("secure_enclave");
  });

  it("delegates VC envelope composition even for App Attest receipts", async () => {
    // The drift gate enforces that every surface uses
    // composeHardwareAttestationCredential. The outer signature is
    // eddsa-jcs-2022 regardless of the inner hardware platform.
    const id = await makeIdentity();
    const nativeAppAttest = makeNativeAppAttest({
      available: true,
      mint: fakeAppAttestMint,
    });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      nativeAppAttest,
      native: makeNative({ available: false }),
    });
    expect(cred.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(cred.type).toEqual(["VerifiableCredential", "AgentTrustCredential"]);
  });
});

// ── SE happy path ───────────────────────────────────────────────────

describe("mintHardwareCredential — SE happy path", () => {
  it("produces a credential with platform:'secure_enclave' when the native module signs", async () => {
    const id = await makeIdentity();
    const native = makeNative({
      available: true,
      mint: simulateSeMint,
    });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "01234567-89ab-cdef-0123-456789abcdef",
      deviceId: "iphone-1",
      now: () => 1_700_000_000_000,
      native,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("secure_enclave");
    expect(cred.credentialSubject.hardware_attestation.attestation_receipt).toMatch(/\./);
  });

  it("SE credential verifies end-to-end — hardware: secure_enclave ✓", async () => {
    const id = await makeIdentity();
    const native = makeNative({
      available: true,
      mint: simulateSeMint,
    });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "01234567-89ab-cdef-0123-456789abcdef",
      deviceId: "iphone-1",
      now: () => Date.now(),
      native,
    });
    const result = await verify(cred);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);
    if (result.type !== "credential") throw new Error("expected credential");
    expect(result.hardware_attestation).toBeDefined();
    expect(result.hardware_attestation!.valid).toBe(true);
    expect(result.hardware_attestation!.platform).toBe("secure_enclave");
  });
});

// ── SE unavailable fallback ─────────────────────────────────────────

describe("mintHardwareCredential — SE unavailable fallback", () => {
  it("emits platform:'software' when seAvailable returns false", async () => {
    const id = await makeIdentity();
    const native = makeNative({ available: false });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot_test",
      deviceId: "android_test",
      now: () => 1_700_000_000_000,
      native,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
    expect(cred.credentialSubject.hardware_attestation.key_exported).toBe(false);
  });

  it("software-fallback credential still verifies — hardware: software ✗ (truthful)", async () => {
    const id = await makeIdentity();
    const native = makeNative({ available: false });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot_test",
      deviceId: "android_test",
      now: () => Date.now(),
      native,
    });
    const result = await verify(cred);
    expect(result.valid).toBe(true);
    if (result.type !== "credential") throw new Error("expected credential");
    expect(result.hardware_attestation?.platform).toBe("software");
    expect(result.hardware_attestation?.valid).toBe(false); // software sentinel = no hw channel
  });

  it("degrades to software when the mint call rejects with permission_denied", async () => {
    // Real-world: the user declined the biometric prompt the SE
    // required. The mint path treats every error reason as a graceful
    // fallback to software — never surfaces the error, never emits a
    // false hardware claim.
    const id = await makeIdentity();
    const native = makeNative({
      available: true,
      mintThrows: Object.assign(new Error("user cancelled"), { code: "permission_denied" }),
    });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      now: () => 1_700_000_000_000,
      native,
    });
    expect(cred.credentialSubject.hardware_attestation.platform).toBe("software");
  });
});

// ── Envelope shape ──────────────────────────────────────────────────

describe("mintHardwareCredential — envelope shape", () => {
  it("self-attestation: issuer === subject.id === did:key of public key", async () => {
    const id = await makeIdentity();
    const native = makeNative({ available: false });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      native,
    });
    expect(cred.issuer).toMatch(/^did:key:z/);
    expect(cred.credentialSubject.id).toBe(cred.issuer);
  });

  it("type array includes VerifiableCredential + AgentTrustCredential", async () => {
    const id = await makeIdentity();
    const native = makeNative({ available: false });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      native,
    });
    expect(cred.type).toEqual(["VerifiableCredential", "AgentTrustCredential"]);
  });

  it("proof is eddsa-jcs-2022", async () => {
    const id = await makeIdentity();
    const native = makeNative({ available: false });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      native,
    });
    expect(cred.proof.cryptosuite).toBe("eddsa-jcs-2022");
    expect(cred.proof.type).toBe("DataIntegrityProof");
  });

  it("identity_public_key normalized to lowercase", async () => {
    const id = await makeIdentity();
    const native = makeNative({ available: false });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex.toUpperCase(),
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      native,
    });
    expect(cred.credentialSubject.identity_public_key).toBe(id.publicKeyHex.toLowerCase());
  });
});

// ── JSON roundtrip ──────────────────────────────────────────────────

describe("mintHardwareCredential — JSON roundtrip", () => {
  it("serializes + re-parses + re-verifies (wire-format pipe shape)", async () => {
    const id = await makeIdentity();
    const native = makeNative({ available: true, mint: simulateSeMint });
    const cred = await mintHardwareCredential({
      identityPublicKeyHex: id.publicKeyHex,
      privateKey: id.privateKey,
      publicKey: id.publicKey,
      motebitId: "mot",
      deviceId: "dev",
      native,
    });
    const reparsed = JSON.parse(JSON.stringify(cred)) as typeof cred;
    const result = await verify(reparsed);
    expect(result.valid).toBe(true);
    if (result.type !== "credential") throw new Error("expected credential");
    expect(result.hardware_attestation?.valid).toBe(true);
    expect(result.hardware_attestation?.platform).toBe("secure_enclave");
  });
});
