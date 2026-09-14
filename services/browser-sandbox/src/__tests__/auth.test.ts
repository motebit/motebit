/**
 * Auth-middleware tests: relay-signed audience-bound tokens are the ONLY
 * admitted credential (the v1 shared bearer was retired 2026-09-14).
 *
 * Invariants:
 *   1. `verifyRelaySandboxToken` accepts a token signed by the
 *      pinned key with `aud: BROWSER_SANDBOX_AUDIENCE` and a non-
 *      empty `mid`.
 *   2. Cross-audience replay defense — a token with the wrong `aud`
 *      is rejected.
 *   3. A token signed with a different (non-pinned) key is rejected.
 *   4. `requireAuth` accepts a relay-signed token and refuses an opaque
 *      shared-secret bearer, a foreign-key token, and a wrong audience.
 *   5. `requireAuth` rejects a malformed bearer with permission_denied.
 *   6. `requireAuth` refuses to build without a well-formed pinned key.
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

describe("requireAuth — relay-signed tokens only", () => {
  function buildApp(trustedRelayPublicKeyHex: string): Hono {
    const app = new Hono();
    app.use("*", requireAuth({ trustedRelayPublicKeyHex }));
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

  it("accepts a relay-signed token and attributes the request to its motebit", async () => {
    const app = buildApp(relayPublicKeyHex);
    const token = await mintRelayToken({ motebitId: "motebit-bob" });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { motebitId: string }).motebitId).toBe("motebit-bob");
  });

  it("rejects an opaque shared-secret bearer — the retired v1 shape has no path", async () => {
    const app = buildApp(relayPublicKeyHex);
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer test-legacy-token-1234567890" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe(
      "permission_denied",
    );
  });

  it("rejects a token signed by a non-pinned key and one bound to another audience", async () => {
    const app = buildApp(relayPublicKeyHex);
    const other = await generateKeypair();
    const foreign = await mintRelayToken({ signWith: other.privateKey });
    expect(
      (await app.request("/protected", { headers: { Authorization: `Bearer ${foreign}` } })).status,
    ).toBe(401);
    const wrongAud = await mintRelayToken({ audience: "task:submit" });
    expect(
      (await app.request("/protected", { headers: { Authorization: `Bearer ${wrongAud}` } }))
        .status,
    ).toBe(401);
  });

  it("rejects a malformed authorization header", async () => {
    const app = buildApp(relayPublicKeyHex);
    const res = await app.request("/protected", { headers: { Authorization: "Basic abc" } });
    expect(res.status).toBe(401);
  });

  it("refuses to build without a well-formed pinned key", () => {
    expect(() => requireAuth({ trustedRelayPublicKeyHex: "" })).toThrowError(/64-char hex/);
  });
});
