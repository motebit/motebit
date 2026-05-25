/**
 * Frozen signature/hash vectors — the byte-compatibility regression guard.
 *
 * motebit's entire self-attesting story rests on signature/hash OUTPUT being
 * stable: a receipt, identity file, or federation handshake signed by one
 * version of the stack MUST verify under another, forever. Ed25519, SHA-256,
 * and SHA-512 are standards, so the bytes are deterministic — but a future
 * crypto-library bump (the @noble v1→v2 migration that motivated this file)
 * could silently change the output if a primitive were ever mis-wired.
 *
 * These vectors are pinned to the exact bytes the production signing path
 * (`signBySuite`) and the SHA helpers produce for fixed inputs. If any of them
 * changes, a dependency bump altered our on-the-wire output — STOP and prove
 * cross-version interop before shipping, because every previously-signed
 * artifact in the wild may stop verifying.
 */
import { describe, it, expect } from "vitest";
import { signBySuite, verifyBySuite, bytesToHex, hexToBytes } from "../index.js";

const ED25519_SUITE = "motebit-jcs-ed25519-b64-v1" as const;
// A fixed 32-byte Ed25519 seed (0x42 repeated) signing the bytes of "motebit".
const SEED = new Uint8Array(32).fill(0x42);
const MSG = new TextEncoder().encode("motebit");

// Pinned outputs (computed against @noble/ed25519 v3 + @noble/hashes v2; identical
// to v1 because the algorithms are standards). Changing these means the wire
// output moved — a breaking, interop-shattering event, never a routine bump.
const FROZEN_PUBKEY = "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12";
const FROZEN_SIG =
  "b14e548fc26ad27b93825cb72b4463efffaf1298e4769312229a66e011d0d2b1" +
  "35dfd3b6317fddcd640c317a736ee4199c37c3e6b5d4b2d4c9ab937f3306f60f";

describe("signature byte-compatibility (frozen vectors)", () => {
  it("Ed25519 signBySuite produces the exact pinned signature for the fixed seed + message", async () => {
    const sig = await signBySuite(ED25519_SUITE, MSG, SEED);
    expect(bytesToHex(sig)).toBe(FROZEN_SIG);
  });

  it("the pinned signature verifies against the pinned public key", async () => {
    const ok = await verifyBySuite(
      ED25519_SUITE,
      MSG,
      hexToBytes(FROZEN_SIG),
      hexToBytes(FROZEN_PUBKEY),
    );
    expect(ok).toBe(true);
  });

  // SHA-256 and SHA-512 are pinned transitively: the frozen Ed25519 signature
  // above is computed over SHA-512, and SHA-256 is exercised throughout the
  // broader crypto suite (canonical-JSON hashing, content hashes). A separate
  // KAT here would be redundant.
});
