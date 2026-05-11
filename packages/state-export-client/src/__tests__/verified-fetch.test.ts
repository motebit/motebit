/**
 * Verified-fetch tests. Build a signed manifest with a keypair under
 * test, serve it through a mock fetch, assert verification succeeds —
 * and every tamper mode (body, header, key swap) is caught with a
 * typed reason.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeypair, bytesToHex, hexToBytes, signContentArtifact } from "@motebit/crypto";

import {
  verifiedStateExportFetch,
  verifyManifestAgainstBytes,
  MANIFEST_HEADER,
  StateExportFetchError,
} from "../verified-fetch.js";
import type { TransparencyAnchor } from "../transparency-anchor.js";

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
  did: string;
}

async function makeKeys(): Promise<Keys> {
  const kp = await generateKeypair();
  const hex = bytesToHex(kp.publicKey);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: hex,
    did: `did:key:z${hex.slice(0, 16)}`,
  };
}

function anchorFor(keys: Keys): TransparencyAnchor {
  return {
    relayPublicKey: hexToBytes(keys.publicKeyHex),
    relayPublicKeyHex: keys.publicKeyHex.toLowerCase(),
    relayId: "test-relay",
    declaredAt: 1736500000000,
  };
}

function manifestToHeader(manifest: object): string {
  const json = JSON.stringify(manifest);
  // Browser-style base64url: btoa of binary string, then url-safe substitution.
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let signer: Keys;
let attacker: Keys;

beforeAll(async () => {
  signer = await makeKeys();
  attacker = await makeKeys();
});

describe("verifiedStateExportFetch — round trip", () => {
  it("accepts a valid signed response and returns parsed body + verification", async () => {
    const bodyObj = { motebit_id: "test", entries: [] };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObj));
    const manifest = await signContentArtifact(bodyBytes, {
      artifactType: "audit-trail",
      producer: signer.did,
      producerPublicKey: signer.publicKey,
      producerPrivateKey: signer.privateKey,
      claimGenerator: "motebit-relay/test",
    });
    const headerValue = manifestToHeader(manifest);

    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(bodyBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          [MANIFEST_HEADER]: headerValue,
        },
      });

    const result = await verifiedStateExportFetch<typeof bodyObj>(
      "https://relay.example.com/api/v1/audit/x",
      { fetch: mockFetch, anchor: anchorFor(signer) },
    );

    expect(result.body).toEqual(bodyObj);
    expect(result.verification.valid).toBe(true);
    if (result.verification.valid) {
      expect(result.verification.artifactType).toBe("audit-trail");
      expect(result.verification.producerPublicKeyHex).toBe(signer.publicKeyHex.toLowerCase());
      expect(result.verification.producerDid).toBe(signer.did);
    }
  });

  it("verifies without an anchor (self-consistency only)", async () => {
    const bodyBytes = new TextEncoder().encode('{"motebit_id":"x"}');
    const manifest = await signContentArtifact(bodyBytes, {
      artifactType: "state-snapshot",
      producer: signer.did,
      producerPublicKey: signer.publicKey,
      producerPrivateKey: signer.privateKey,
      claimGenerator: "motebit-relay/test",
    });

    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(bodyBytes, {
        status: 200,
        headers: { [MANIFEST_HEADER]: manifestToHeader(manifest) },
      });

    const result = await verifiedStateExportFetch(
      "https://relay.example.com/api/v1/state/x",
      { fetch: mockFetch }, // no anchor
    );
    expect(result.verification.valid).toBe(true);
  });
});

describe("verifiedStateExportFetch — failure modes", () => {
  async function setup(
    bodyBytes: Uint8Array,
    options: {
      tamperBody?: boolean;
      swapKey?: boolean;
      omitHeader?: boolean;
      badHeader?: boolean;
    } = {},
  ): Promise<Awaited<ReturnType<typeof verifiedStateExportFetch>>> {
    const manifest = await signContentArtifact(bodyBytes, {
      artifactType: "audit-trail",
      producer: signer.did,
      producerPublicKey: signer.publicKey,
      producerPrivateKey: signer.privateKey,
      claimGenerator: "motebit-relay/test",
    });
    const headerValue = options.badHeader
      ? "not-a-base64url-manifest!"
      : options.omitHeader
        ? undefined
        : manifestToHeader(manifest);

    const responseBytes = options.tamperBody
      ? (() => {
          const t = new Uint8Array(bodyBytes);
          t[0] = t[0]! ^ 0x01;
          return t;
        })()
      : bodyBytes;

    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(responseBytes, {
        status: 200,
        headers: headerValue !== undefined ? { [MANIFEST_HEADER]: headerValue } : {},
      });

    const anchor = options.swapKey ? anchorFor(attacker) : anchorFor(signer);
    return verifiedStateExportFetch("https://relay.example.com/api/v1/audit/x", {
      fetch: mockFetch,
      anchor,
    });
  }

  it("rejects manifest_header_missing when the header is absent", async () => {
    const bodyBytes = new TextEncoder().encode('{"motebit_id":"x"}');
    const result = await setup(bodyBytes, { omitHeader: true });
    expect(result.verification.valid).toBe(false);
    if (!result.verification.valid)
      expect(result.verification.reason).toBe("manifest_header_missing");
  });

  it("rejects malformed_manifest_header on garbage base64url", async () => {
    const bodyBytes = new TextEncoder().encode('{"motebit_id":"x"}');
    const result = await setup(bodyBytes, { badHeader: true });
    expect(result.verification.valid).toBe(false);
    if (!result.verification.valid)
      expect(result.verification.reason).toBe("malformed_manifest_header");
  });

  it("rejects content_hash_mismatch when the body bytes are tampered", async () => {
    const bodyBytes = new TextEncoder().encode('{"motebit_id":"x"}');
    const result = await setup(bodyBytes, { tamperBody: true });
    expect(result.verification.valid).toBe(false);
    if (!result.verification.valid)
      expect(result.verification.reason).toBe("content_hash_mismatch");
  });

  it("rejects producer_key_mismatch when the anchor differs from the manifest's declared key", async () => {
    const bodyBytes = new TextEncoder().encode('{"motebit_id":"x"}');
    const result = await setup(bodyBytes, { swapKey: true });
    expect(result.verification.valid).toBe(false);
    if (!result.verification.valid)
      expect(result.verification.reason).toBe("producer_key_mismatch");
  });
});

describe("verifyManifestAgainstBytes — pure-function verifier", () => {
  it("verifies a header value + body bytes pair without HTTP", async () => {
    const bodyBytes = new TextEncoder().encode('{"motebit_id":"y","items":[]}');
    const manifest = await signContentArtifact(bodyBytes, {
      artifactType: "memory-export",
      producer: signer.did,
      producerPublicKey: signer.publicKey,
      producerPrivateKey: signer.privateKey,
      claimGenerator: "motebit-relay/test",
    });
    const result = await verifyManifestAgainstBytes(manifestToHeader(manifest), bodyBytes);
    expect(result.valid).toBe(true);
  });

  it("rejects null/empty header values with manifest_header_missing", async () => {
    const bodyBytes = new TextEncoder().encode("{}");
    expect((await verifyManifestAgainstBytes(null, bodyBytes)).valid).toBe(false);
    expect((await verifyManifestAgainstBytes("", bodyBytes)).valid).toBe(false);
  });
});

describe("verifiedStateExportFetch — HTTP error path", () => {
  it("throws StateExportFetchError on non-2xx", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("forbidden", { status: 403, statusText: "Forbidden" });
    await expect(
      verifiedStateExportFetch("https://relay.example.com/api/v1/state/x", { fetch: mockFetch }),
    ).rejects.toBeInstanceOf(StateExportFetchError);
  });
});
