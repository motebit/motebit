/**
 * The submission a rotation depends on.
 *
 * Every surface grew its own version of this request and three of the four
 * were wrong in a way no test caught, because each test minted its own
 * token instead of driving the code the surface actually runs. The result
 * was a production relay whose succession table was empty across its whole
 * life (#702). These tests drive the exported primitive.
 */
import { describe, it, expect } from "vitest";
import { submitSuccessionToRelay } from "../succession-client.js";
import type { KeySuccessionRecord } from "@motebit/protocol";
// `@motebit/encryption` is what this package already depends on; the
// record's own signatures are not what these tests are about.
import { generateKeypair, signKeySuccession } from "@motebit/encryption";

const RECORD = {} as KeySuccessionRecord;

async function record(): Promise<{ rec: KeySuccessionRecord; signingKey: Uint8Array }> {
  const oldKp = await generateKeypair();
  const newKp = await generateKeypair();
  const rec = (await signKeySuccession(
    oldKp.privateKey,
    newKp.privateKey,
    newKp.publicKey,
    oldKp.publicKey,
    "test",
  )) as KeySuccessionRecord;
  return { rec, signingKey: oldKp.privateKey };
}

describe("submitSuccessionToRelay", () => {
  it("presents it to the rotate-key route, under the audience the spec names", async () => {
    const { rec, signingKey } = await record();
    let seen: { url: string; auth: string; body: string } | null = null;
    const res = await submitSuccessionToRelay({
      syncUrl: "https://relay.test/",
      motebitId: "m-1",
      deviceId: "d-1",
      signingKey,
      record: rec,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = {
          url,
          auth: (init.headers as Record<string, string>).Authorization ?? "",
          body: init.body as string,
        };
        return new Response(JSON.stringify({ ok: true, applied: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: true, applied: true });
    // The trailing slash is absorbed, and the path is the one the relay
    // actually registers — web and mobile posted to `/key-rotation`, which
    // does not exist, and swallowed the 404.
    expect(seen!.url).toBe("https://relay.test/api/v1/agents/m-1/rotate-key");
    expect(seen!.body).toBe(JSON.stringify(rec));
    const claims = JSON.parse(
      // The token is `payload.signature`, so the payload is the FIRST part.
      Buffer.from(seen!.auth.replace("Bearer ", "").split(".")[0]!, "base64url").toString(),
    ) as { aud: string; mid: string; did: string };
    expect(claims).toMatchObject({ aud: "rotate-key", mid: "m-1", did: "d-1" });
  });

  it("signs with the key being retired — the only one the relay can verify", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();
    let auth = "";
    await submitSuccessionToRelay({
      syncUrl: "https://relay.test",
      motebitId: "m-1",
      deviceId: "d-1",
      signingKey: oldKp.privateKey,
      record: RECORD,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).Authorization ?? "";
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const { verifySignedToken } = await import("@motebit/encryption");
    // Verifies under the OLD key and not the new one. Signing with the new
    // key is unverifiable by construction: the relay checks against the
    // key it still holds, which is the one being replaced.
    expect(await verifySignedToken(auth.replace("Bearer ", ""), oldKp.publicKey)).not.toBeNull();
    expect(await verifySignedToken(auth.replace("Bearer ", ""), newKp.publicKey)).toBeNull();
  });

  it("reports a refusal instead of throwing or swallowing it", async () => {
    const { rec, signingKey } = await record();
    const res = await submitSuccessionToRelay({
      syncUrl: "https://relay.test",
      motebitId: "m-1",
      deviceId: "d-1",
      signingKey,
      record: rec,
      fetchImpl: (async () =>
        new Response("not from the current key", { status: 400 })) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: expect.stringContaining("400") });
  });

  it("reports an unreachable relay rather than letting the caller commit", async () => {
    const { rec, signingKey } = await record();
    const res = await submitSuccessionToRelay({
      syncUrl: "https://relay.test",
      motebitId: "m-1",
      deviceId: "d-1",
      signingKey,
      record: rec,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });

  it("reads `applied: false` as a retry that landed earlier, not a failure", async () => {
    const { rec, signingKey } = await record();
    const res = await submitSuccessionToRelay({
      syncUrl: "https://relay.test",
      motebitId: "m-1",
      deviceId: "d-1",
      signingKey,
      record: rec,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: true, applied: false }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: true, applied: false });
  });

  it("refuses without a device id, because the relay could not resolve a key to verify", async () => {
    const { signingKey } = await record();
    const res = await submitSuccessionToRelay({
      syncUrl: "https://relay.test",
      motebitId: "m-1",
      deviceId: "",
      signingKey,
      record: RECORD,
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
  });
});
