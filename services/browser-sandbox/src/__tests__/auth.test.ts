/**
 * Auth-middleware tests covering the dualAuth shape: legacy shared
 * bearer + relay-signed audience-bound token.
 *
 * Invariants:
 *   1. `verifyRelaySandboxToken` accepts a token signed by the
 *      pinned key with `aud: BROWSER_SANDBOX_AUDIENCE` and a non-
 *      empty `mid`.
 *   2. Cross-audience replay defense — a token with the wrong `aud`
 *      is rejected.
 *   3. A token signed with a different (non-pinned) key is rejected.
 *   4. `requireAuth` accepts EITHER a relay-signed token OR the legacy
 *      shared bearer when both are configured.
 *   5. `requireAuth` rejects a malformed bearer with permission_denied.
 *   6. `requireAuth` requires at least one auth path configured.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { generateKeypair, createSignedToken } from "@motebit/crypto";
import type { SignedTokenPayload } from "@motebit/crypto";
import { BROWSER_SANDBOX_AUDIENCE } from "@motebit/protocol";
import { requireAuth, verifyRelaySandboxToken, extractBearer } from "../auth.js";
import { isServiceError } from "../errors.js";

let relayPublicKey: Uint8Array;
let relayPrivateKey: Uint8Array;
let relayPublicKeyHex: string;

beforeAll(async () => {
  const keypair = await generateKeypair();
  relayPublicKey = keypair.publicKey;
  relayPrivateKey = keypair.privateKey;
  relayPublicKeyHex = Array.from(relayPublicKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
});

async function mintRelayToken(opts: {
  motebitId?: string;
  audience?: string;
  ttlMs?: number;
  signWith?: Uint8Array;
}): Promise<string> {
  const now = Date.now();
  const payload: Omit<SignedTokenPayload, "suite"> = {
    mid: opts.motebitId ?? "motebit-test",
    did: "did:key:zRelay",
    iat: now,
    exp: now + (opts.ttlMs ?? 60_000),
    jti: crypto.randomUUID(),
    aud: opts.audience ?? BROWSER_SANDBOX_AUDIENCE,
  };
  return createSignedToken(payload, opts.signWith ?? relayPrivateKey);
}

describe("verifyRelaySandboxToken", () => {
  it("accepts a token signed by the pinned key with the right audience", async () => {
    const token = await mintRelayToken({ motebitId: "motebit-alice" });
    const verified = await verifyRelaySandboxToken(token, relayPublicKey);
    expect(verified).not.toBeNull();
    expect(verified?.motebitId).toBe("motebit-alice");
    expect(verified?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects a token with the wrong audience (cross-endpoint replay)", async () => {
    const token = await mintRelayToken({ audience: "sync" });
    const verified = await verifyRelaySandboxToken(token, relayPublicKey);
    expect(verified).toBeNull();
  });

  it("rejects a token signed by a different (non-pinned) key", async () => {
    const otherKeypair = await generateKeypair();
    const token = await mintRelayToken({ signWith: otherKeypair.privateKey });
    const verified = await verifyRelaySandboxToken(token, relayPublicKey);
    expect(verified).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await mintRelayToken({ ttlMs: -1000 });
    const verified = await verifyRelaySandboxToken(token, relayPublicKey);
    expect(verified).toBeNull();
  });

  it("rejects a token with empty mid", async () => {
    const token = await mintRelayToken({ motebitId: "" });
    const verified = await verifyRelaySandboxToken(token, relayPublicKey);
    expect(verified).toBeNull();
  });

  it("rejects a malformed token", async () => {
    const verified = await verifyRelaySandboxToken("not-a-jwt", relayPublicKey);
    expect(verified).toBeNull();
  });
});

describe("extractBearer", () => {
  it("extracts the token portion of an Authorization header (case-sensitive Bearer)", () => {
    expect(extractBearer("Bearer abc.def")).toBe("abc.def");
    expect(extractBearer("Bearer    spaced.token")).toBe("spaced.token");
  });

  it("returns null for missing, malformed, or wrong-scheme headers", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
    // RFC 6750 names Bearer case-insensitive but motebit's verifier
    // is strict — match the existing convention.
    expect(extractBearer("bearer abc.def")).toBeNull();
  });
});

describe("requireAuth dualAuth", () => {
  const LEGACY_TOKEN = "test-legacy-token-1234567890";

  function buildApp(opts: {
    legacyApiToken: string | null;
    trustedRelayPublicKeyHex: string | null;
  }): Hono {
    const app = new Hono();
    app.use("*", requireAuth(opts));
    app.get("/protected", (c) => {
      const motebitId = c.get("motebitId" as never) as string | undefined;
      return c.json({ ok: true, motebitId: motebitId ?? null });
    });
    app.onError((err, c) => {
      if (isServiceError(err)) {
        return c.json({ error: { reason: err.reason, message: err.message } }, 401);
      }
      throw err;
    });
    return app;
  }

  it("accepts the relay-signed path when only the relay key is configured", async () => {
    const app = buildApp({
      legacyApiToken: null,
      trustedRelayPublicKeyHex: relayPublicKeyHex,
    });
    const token = await mintRelayToken({ motebitId: "motebit-bob" });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motebitId: string };
    expect(body.motebitId).toBe("motebit-bob");
  });

  it("accepts the legacy bearer when only legacy is configured", async () => {
    const app = buildApp({
      legacyApiToken: LEGACY_TOKEN,
      trustedRelayPublicKeyHex: null,
    });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("dualAuth — accepts either path when both are configured", async () => {
    const app = buildApp({
      legacyApiToken: LEGACY_TOKEN,
      trustedRelayPublicKeyHex: relayPublicKeyHex,
    });

    const relayToken = await mintRelayToken({ motebitId: "motebit-carol" });
    const resRelay = await app.request("/protected", {
      headers: { Authorization: `Bearer ${relayToken}` },
    });
    expect(resRelay.status).toBe(200);
    expect(((await resRelay.json()) as { motebitId: string }).motebitId).toBe("motebit-carol");

    const resLegacy = await app.request("/protected", {
      headers: { Authorization: `Bearer ${LEGACY_TOKEN}` },
    });
    expect(resLegacy.status).toBe(200);
    expect(((await resLegacy.json()) as { motebitId: string | null }).motebitId).toBeNull();
  });

  it("rejects an unsigned bearer that doesn't match the legacy token", async () => {
    const app = buildApp({
      legacyApiToken: LEGACY_TOKEN,
      trustedRelayPublicKeyHex: null,
    });
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { reason: string } };
    expect(body.error.reason).toBe("permission_denied");
  });

  it("rejects a malformed authorization header", async () => {
    const app = buildApp({
      legacyApiToken: LEGACY_TOKEN,
      trustedRelayPublicKeyHex: null,
    });
    const res = await app.request("/protected", {
      headers: { Authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a relay-shape token under wrong-key relay (does not fall through to legacy unless shape mismatch)", async () => {
    // This is the subtle one: a JWT-shape bearer that fails relay
    // verification should NOT then be tested against the legacy
    // token (no fallback on signature failure — only on shape
    // mismatch). Otherwise an attacker who knows the legacy token
    // could wrap it in a JWT-shape envelope to confuse the auth.
    const otherKeypair = await generateKeypair();
    const otherToken = await mintRelayToken({ signWith: otherKeypair.privateKey });
    const app = buildApp({
      legacyApiToken: LEGACY_TOKEN,
      trustedRelayPublicKeyHex: relayPublicKeyHex,
    });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("requires at least one auth path", () => {
    expect(() => requireAuth({ legacyApiToken: null, trustedRelayPublicKeyHex: null })).toThrow(
      /at least one of/i,
    );
  });
});
