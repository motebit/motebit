/**
 * Agent-side migration orchestrator — flow + fail-closed behavior with a
 * mocked relay fetch (the two-relay end-to-end proof lives in the relay suite).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { generateKeypair } from "@motebit/crypto";
import { performMigration } from "../migration-client.js";
import type { MigrationClientDeps } from "../migration-client.js";

let signingKey: Uint8Array;
beforeAll(async () => {
  signingKey = (await generateKeypair()).privateKey;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch double that serves canned responses keyed by URL substring. */
function routedFetch(routes: Record<string, () => Response>): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make();
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

const baseDeps = (fetchImpl: typeof globalThis.fetch): MigrationClientDeps => ({
  sourceRelayUrl: "https://source.relay",
  destRelayUrl: "https://dest.relay",
  motebitId: "mote-1",
  publicKeyHex: "ab".repeat(32),
  sourceAuth: "source-token",
  signingPrivateKey: signingKey,
  fetch: fetchImpl,
});

const happyRoutes = {
  "/migrate": () => jsonResponse({ ok: true, migration_token: { token_id: "t1" } }),
  "/migration/attestation": () =>
    jsonResponse({ ok: true, departure_attestation: { attestation_id: "a1" } }),
  // Unsigned bundle (the agent signs it) — must carry a suite for the signer.
  "/migration/export": () =>
    jsonResponse({
      ok: true,
      credential_bundle: { motebit_id: "mote-1", suite: "motebit-jcs-ed25519-b64-v1" },
    }),
  "/accept-migration": () => jsonResponse({ ok: true, motebit_id: "mote-1" }),
};

describe("performMigration", () => {
  it("runs the full flow and returns the onboarded motebit id", async () => {
    const result = await performMigration(baseDeps(routedFetch(happyRoutes)));
    expect(result).toEqual({ ok: true, acceptedMotebitId: "mote-1" });
  });

  it("calls source endpoints with the source bearer token, dest with its own", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const spyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const auth = new Headers(init?.headers).get("Authorization");
      calls.push({ url, auth });
      for (const [needle, make] of Object.entries(happyRoutes))
        if (url.includes(needle)) return make();
      return new Response("nf", { status: 404 });
    }) as typeof globalThis.fetch;

    await performMigration({ ...baseDeps(spyFetch), destAuth: "dest-token" });

    const accept = calls.find((c) => c.url.includes("/accept-migration"))!;
    const migrate = calls.find((c) => c.url.includes("/migrate"))!;
    expect(migrate.auth).toBe("Bearer source-token");
    expect(accept.auth).toBe("Bearer dest-token");
  });

  it("supports a per-call token minter for source auth", async () => {
    const mint = vi.fn(async () => "fresh-token");
    await performMigration({ ...baseDeps(routedFetch(happyRoutes)), sourceAuth: mint });
    expect(mint).toHaveBeenCalled();
  });

  it("fails closed at the request step when the source refuses a token", async () => {
    const result = await performMigration(
      baseDeps(
        routedFetch({ ...happyRoutes, "/migrate": () => jsonResponse({ error: "nope" }, 403) }),
      ),
    );
    expect(result).toMatchObject({ ok: false, step: "request", status: 403 });
  });

  it("fails closed at the accept step when the destination rejects (e.g. untrusted source)", async () => {
    const result = await performMigration(
      baseDeps(
        routedFetch({
          ...happyRoutes,
          "/accept-migration": () =>
            jsonResponse({ error: "Cannot establish source relay identity" }, 400),
        }),
      ),
    );
    expect(result).toMatchObject({ ok: false, step: "accept", status: 400 });
  });

  it("reports the export step when the bundle is missing", async () => {
    const result = await performMigration(
      baseDeps(
        routedFetch({ ...happyRoutes, "/migration/export": () => jsonResponse({ ok: true }) }),
      ),
    );
    expect(result).toMatchObject({ ok: false, step: "export" });
  });

  it("surfaces a network throw as a typed step failure, not an exception", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof globalThis.fetch;
    const result = await performMigration(baseDeps(throwingFetch));
    expect(result).toMatchObject({ ok: false, step: "request", reason: "ECONNREFUSED" });
  });
});
