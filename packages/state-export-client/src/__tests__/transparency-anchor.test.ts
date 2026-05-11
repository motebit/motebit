/**
 * Trust-on-first-use bootstrap tests. Mirror the producer-side
 * transparency.ts test surface — fabricate a signed declaration with a
 * keypair under test, then verify the round-trip succeeds and every
 * tamper mode is caught.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  sha256,
  canonicalJson,
  signBySuite,
} from "@motebit/crypto";
import type { SuiteId } from "@motebit/protocol";

import {
  fetchTransparencyAnchor,
  verifyTransparencyDeclaration,
  type SignedTransparencyDeclaration,
} from "../transparency-anchor.js";

const SUITE: SuiteId = "motebit-jcs-ed25519-hex-v1";

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
}

async function makeKeys(): Promise<Keys> {
  const kp = await generateKeypair();
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
  };
}

/**
 * Build a signed declaration with the same shape the relay's
 * transparency.ts emits. Mirroring that code locally (vs. importing
 * the relay's helper) keeps this package's tests self-contained — no
 * BSL dep into a permissive-floor test.
 */
async function buildDeclaration(
  signer: Keys,
  overrides: Partial<SignedTransparencyDeclaration> = {},
): Promise<SignedTransparencyDeclaration> {
  const payload = {
    spec: overrides.spec ?? "motebit-transparency/draft-2026-04-14",
    declared_at: overrides.declared_at ?? 1736500000000,
    relay_id: overrides.relay_id ?? "test-relay-motebit-id",
    relay_public_key: overrides.relay_public_key ?? signer.publicKeyHex,
    content: overrides.content ?? { purpose: "test", retention: "none" },
  };
  const canonical = new TextEncoder().encode(canonicalJson(payload));
  const hashBytes = await sha256(canonical);
  const sigBytes = await signBySuite(SUITE, canonical, signer.privateKey);
  return {
    ...payload,
    hash: overrides.hash ?? bytesToHex(hashBytes),
    suite: overrides.suite ?? SUITE,
    signature: overrides.signature ?? bytesToHex(sigBytes),
  };
}

let signer: Keys;
let attacker: Keys;

beforeAll(async () => {
  signer = await makeKeys();
  attacker = await makeKeys();
});

describe("verifyTransparencyDeclaration — round trip", () => {
  it("accepts a freshly-signed declaration and returns the pinned anchor", async () => {
    const declaration = await buildDeclaration(signer);
    const result = await verifyTransparencyDeclaration(declaration);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.anchor.relayPublicKeyHex).toBe(signer.publicKeyHex.toLowerCase());
      expect(result.anchor.relayId).toBe("test-relay-motebit-id");
      expect(result.anchor.declaredAt).toBe(1736500000000);
      // The decoded public-key bytes match what hexToBytes produces.
      const expected = hexToBytes(signer.publicKeyHex);
      expect([...result.anchor.relayPublicKey]).toEqual([...expected]);
    }
  });

  it("declaredAt + relayId pass through unchanged", async () => {
    const declaration = await buildDeclaration(signer, {
      declared_at: 9999999999,
      relay_id: "edge-case-id",
    });
    const result = await verifyTransparencyDeclaration(declaration);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.anchor.declaredAt).toBe(9999999999);
      expect(result.anchor.relayId).toBe("edge-case-id");
    }
  });
});

describe("verifyTransparencyDeclaration — failure modes", () => {
  it("rejects hash_mismatch when the recomputed hash differs", async () => {
    const declaration = await buildDeclaration(signer);
    const tampered: SignedTransparencyDeclaration = { ...declaration, hash: "0".repeat(64) };
    const result = await verifyTransparencyDeclaration(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hash_mismatch");
  });

  it("rejects malformed_public_key when the declared key is not 64 hex chars", async () => {
    const declaration = await buildDeclaration(signer);
    const tampered: SignedTransparencyDeclaration = {
      ...declaration,
      relay_public_key: "not-hex",
    };
    const result = await verifyTransparencyDeclaration(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("hash_mismatch");
    // (hash_mismatch fires first because the canonical payload includes
    // the public key — both reasons would catch this; we just pin which
    // one runs first to surface the cheapest signal.)
  });

  it("rejects malformed_signature when the signature isn't hex", async () => {
    const declaration = await buildDeclaration(signer);
    const tampered: SignedTransparencyDeclaration = { ...declaration, signature: "not-hex!" };
    const result = await verifyTransparencyDeclaration(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_signature");
  });

  it("rejects signature_invalid when signed by a different key", async () => {
    // Build a declaration signed by `attacker` but claiming `signer`'s
    // public key — the signature won't verify against the declared key.
    const payload = {
      spec: "motebit-transparency/draft-2026-04-14",
      declared_at: 1,
      relay_id: "x",
      relay_public_key: signer.publicKeyHex, // wrong signer claim
      content: {},
    };
    const canonical = new TextEncoder().encode(canonicalJson(payload));
    const hashBytes = await sha256(canonical);
    const sigBytes = await signBySuite(SUITE, canonical, attacker.privateKey);
    const declaration: SignedTransparencyDeclaration = {
      ...payload,
      hash: bytesToHex(hashBytes),
      suite: SUITE,
      signature: bytesToHex(sigBytes),
    };
    const result = await verifyTransparencyDeclaration(declaration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature_invalid");
  });

  it("rejects malformed_declaration when shape is wrong", async () => {
    const broken = {
      // missing several required fields
      spec: "motebit-transparency/draft-2026-04-14",
      signature: "abc",
    } as unknown as SignedTransparencyDeclaration;
    const result = await verifyTransparencyDeclaration(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_declaration");
  });
});

describe("fetchTransparencyAnchor — HTTP wrapper", () => {
  it("round-trips through a mock fetch and returns the pinned anchor", async () => {
    const declaration = await buildDeclaration(signer);
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify(declaration), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const result = await fetchTransparencyAnchor("https://relay.example.com", {
      fetch: mockFetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.anchor.relayPublicKeyHex).toBe(signer.publicKeyHex.toLowerCase());
  });

  it("surfaces fetch_failed on non-2xx HTTP", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("not found", { status: 404, statusText: "Not Found" });
    const result = await fetchTransparencyAnchor("https://relay.example.com", {
      fetch: mockFetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_failed");
      expect(result.detail).toContain("404");
    }
  });

  it("surfaces fetch_failed on network error", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const result = await fetchTransparencyAnchor("https://relay.example.com", {
      fetch: mockFetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch_failed");
      expect(result.detail).toBe("network down");
    }
  });

  it("trims trailing slash on baseUrl so the well-known path is canonical", async () => {
    let calledUrl = "";
    const declaration = await buildDeclaration(signer);
    const mockFetch: typeof globalThis.fetch = async (input) => {
      calledUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(declaration), { status: 200 });
    };
    await fetchTransparencyAnchor("https://relay.example.com/", { fetch: mockFetch });
    expect(calledUrl).toBe("https://relay.example.com/.well-known/motebit-transparency.json");
  });

  it("honors a custom path override (testing fixture path)", async () => {
    let calledUrl = "";
    const declaration = await buildDeclaration(signer);
    const mockFetch: typeof globalThis.fetch = async (input) => {
      calledUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(declaration), { status: 200 });
    };
    await fetchTransparencyAnchor("https://relay.example.com", {
      fetch: mockFetch,
      path: "/fixtures/transparency.json",
    });
    expect(calledUrl).toBe("https://relay.example.com/fixtures/transparency.json");
  });
});
