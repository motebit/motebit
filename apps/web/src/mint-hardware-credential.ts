/**
 * Web path for minting a hardware-attested `AgentTrustCredential`.
 *
 * Sibling of:
 *   - `apps/desktop/src/mint-hardware-credential.ts` — macOS Secure
 *     Enclave via Rust / Tauri bridge.
 *   - `apps/mobile/src/mint-hardware-credential.ts` — iOS App Attest /
 *     Secure Enclave via Expo native module.
 *   - `apps/cli/src/subcommands/attest.ts` — Node process, software
 *     claim only.
 *
 * All surfaces delegate the VC envelope + eddsa-jcs-2022 signing to
 * `composeHardwareAttestationCredential` from `@motebit/encryption` —
 * the single source of truth. Only the hardware_attestation claim
 * varies per surface.
 *
 * Web's cascade (strongest proof first):
 *   1. WebAuthn platform authenticator (`platform: "webauthn"`) — browser-
 *      minted packed attestation. When `x5c` is present, chain-verified
 *      against the pinned FIDO roots (Apple, Yubico, Microsoft) by
 *      `@motebit/crypto-webauthn`; when absent (self-attestation), the
 *      credential's own key signs the challenge — weaker proof but still
 *      hardware-bound. Only available in browsers that expose
 *      `navigator.credentials` AND support `authenticatorAttachment: "platform"`
 *      with `userVerification: "required"`.
 *   2. Software (`platform: "software"`) — truthful "no hardware
 *      channel" sentinel. Safe to ship; scored lower by the semiring.
 *
 * SSR safety: the browser-only `navigator.credentials.create` path is
 * guarded. In a Node SSR build, `webauthnAvailable` returns false and
 * the software fallback is emitted. Tests inject a fake
 * `NativeWebAuthn` implementation to exercise the WebAuthn path.
 *
 * Kept pure — no DOM access beyond `navigator.credentials`, no storage
 * writes, no network. Deterministic given a fixed `now()`; tests inject
 * a clock.
 */

import {
  composeHardwareAttestationCredential,
  type HardwareAttestationCredentialSubject,
  type VerifiableCredential,
} from "@motebit/encryption";
import type { HardwareAttestationClaim } from "@motebit/sdk";

/**
 * Browser-side native WebAuthn contract. Injected so tests can
 * exercise the minting path without a real browser. Production code
 * binds to the global `navigator.credentials` via `defaultWebAuthn` at
 * call site; SSR paths detect the missing global and fall back to
 * software.
 */
export interface NativeWebAuthn {
  available(): boolean | Promise<boolean>;
  create(args: WebAuthnCreateArgs): Promise<WebAuthnCreateResult>;
}

export interface WebAuthnCreateArgs {
  readonly rpId: string;
  readonly rpName: string;
  readonly userId: Uint8Array;
  readonly userName: string;
  readonly userDisplayName: string;
  /** SHA256(canonical body) — the browser embeds this in clientDataJSON.challenge. */
  readonly challenge: Uint8Array;
}

export interface WebAuthnCreateResult {
  readonly attestation_object_base64: string;
  readonly client_data_json_base64: string;
}

/**
 * Default native WebAuthn binding for production. Returns `available:
 * false` when `navigator.credentials` is missing (SSR / Node / old
 * browser); otherwise calls `navigator.credentials.create` with the
 * canonical platform-authenticator settings.
 */
export const defaultWebAuthn: NativeWebAuthn = {
  available(): boolean {
    return (
      typeof globalThis !== "undefined" &&
      typeof (globalThis as { navigator?: { credentials?: unknown } }).navigator?.credentials !==
        "undefined" &&
      typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !== "undefined"
    );
  },
  async create(args: WebAuthnCreateArgs): Promise<WebAuthnCreateResult> {
    const nav = (
      globalThis as unknown as {
        navigator: {
          credentials: {
            create: (opts: unknown) => Promise<unknown>;
          };
        };
      }
    ).navigator;
    const credential = (await nav.credentials.create({
      publicKey: {
        rp: { id: args.rpId, name: args.rpName },
        user: {
          id: args.userId,
          name: args.userName,
          displayName: args.userDisplayName,
        },
        challenge: args.challenge,
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256
        attestation: "direct",
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
        },
      },
    })) as {
      response: {
        attestationObject: ArrayBuffer;
        clientDataJSON: ArrayBuffer;
      };
    } | null;
    if (!credential) {
      throw new Error("navigator.credentials.create returned null");
    }
    return {
      attestation_object_base64: toBase64Url(new Uint8Array(credential.response.attestationObject)),
      client_data_json_base64: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
    };
  },
};

export interface MintHardwareCredentialOptions {
  /** Ed25519 identity public key, lowercase hex (64 chars). */
  readonly identityPublicKeyHex: string;
  /** Ed25519 private key bytes (32 bytes). */
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly motebitId: string;
  readonly deviceId: string;
  /** WebAuthn Relying Party ID (e.g. "motebit.com" in prod; "localhost" in dev). */
  readonly rpId: string;
  /** Human-readable RP name presented to the user by the browser. */
  readonly rpName?: string;
  /** Injected for test determinism. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable native WebAuthn — tests pass a fake; production defaults. */
  readonly native?: NativeWebAuthn;
}

/**
 * Mint a hardware-attested self-signed `AgentTrustCredential` on the
 * web surface. Cascades WebAuthn → software. The VC envelope +
 * eddsa-jcs-2022 signing is always delegated to
 * `composeHardwareAttestationCredential` — the single source of truth
 * shared with CLI, desktop, and mobile.
 */
export async function mintHardwareCredential(
  opts: MintHardwareCredentialOptions,
): Promise<VerifiableCredential<HardwareAttestationCredentialSubject>> {
  const attestation = await mintAttestationClaim(opts);
  const now = (opts.now ?? Date.now)();
  return composeHardwareAttestationCredential({
    publicKey: opts.publicKey,
    publicKeyHex: opts.identityPublicKeyHex,
    privateKey: opts.privateKey,
    hardwareAttestation: attestation,
    now,
  });
}

/**
 * Build a fresh `HardwareAttestationClaim` for the caller's Ed25519
 * identity. Tries WebAuthn first (browser platform authenticator —
 * TouchID, FaceID, Windows Hello, passkey), then falls back to a
 * truthful software sentinel. Never throws in the routine path — the
 * fallback IS the failure mode, by design, matching mobile + desktop.
 */
export async function mintAttestationClaim(
  opts: MintHardwareCredentialOptions,
): Promise<HardwareAttestationClaim> {
  const attestedAt = (opts.now ?? Date.now)();
  const native = opts.native ?? defaultWebAuthn;

  if (await native.available()) {
    try {
      // Canonical body the verifier will re-derive. Byte-identical to
      // `buildCanonicalAttestationBody` in
      // `packages/crypto-webauthn/src/verify.ts`.
      const canonicalBody = buildCanonicalAttestationBody({
        attested_at: attestedAt,
        device_id: opts.deviceId,
        identity_public_key: opts.identityPublicKeyHex.toLowerCase(),
        motebit_id: opts.motebitId,
      });
      const challenge = await sha256Bytes(new TextEncoder().encode(canonicalBody));
      const userId = new TextEncoder().encode(opts.motebitId);
      const result = await native.create({
        rpId: opts.rpId,
        rpName: opts.rpName ?? "Motebit",
        userId,
        userName: opts.motebitId,
        userDisplayName: opts.motebitId,
        challenge,
      });
      return {
        platform: "webauthn",
        key_exported: false,
        // Wire format: attObj.clientDataJSON — two base64url segments the
        // verifier in @motebit/crypto-webauthn splits on `.`. DISTINCT
        // from App Attest (three segments) and Secure Enclave (two, but
        // different fields); the platform discriminator tells the
        // verifier which split to use.
        attestation_receipt: `${result.attestation_object_base64}.${result.client_data_json_base64}`,
      };
    } catch {
      // Every WebAuthn error reason (user cancelled, no platform
      // authenticator, timeout) degrades to software. Never surface an
      // error to the user; never emit a false hardware claim.
    }
  }

  return softwareFallback();
}

function softwareFallback(): HardwareAttestationClaim {
  return {
    platform: "software",
    key_exported: false,
  };
}

// ── Canonical body reconstruction ────────────────────────────────────
//
// Must stay byte-equal to `buildCanonicalAttestationBody` in
// `packages/crypto-webauthn/src/verify.ts` — the verifier re-derives
// this same string and byte-compares SHA-256 against the browser-
// returned clientDataJSON.challenge.

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

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(buf);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
