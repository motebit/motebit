/**
 * The client half of key rotation, at the seam a relay sees
 * (`docs/proposals/key-rotation-client-v1.md`).
 *
 * `readSuccessionState` is the resume path: it classifies the relay from
 * the public succession route so the client never re-signs or replays. Each
 * case is a row of the design note's state table. `submitSuccessionToRelay`
 * is the forward path: which key signs, which audience, and — the part
 * three shipped clients got wrong — a failure is returned and says which
 * kind it is, never swallowed.
 */
import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signKeySuccession,
  verifySignedToken,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";

import { readSuccessionState, submitSuccessionToRelay } from "../succession-client.js";

const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);
const MID = "mid-1";

function relayAnswering(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function link(from: KeyPair, to: KeyPair) {
  return signKeySuccession(from.privateKey, to.privateKey, to.publicKey, from.publicKey);
}

describe("readSuccessionState — the resume path READS the relay's own answer", () => {
  // The relay answers `departable` for `?from=<local key>` with the same
  // function its rotate-key rule enforces, and names `held_public_key`. The
  // client classifies from THAT, never from the chain and registry alone —
  // it cannot see device rows, and its precedence would invert the relay's.

  it("asks the relay about the local key, and takes its answer: departable ⇒ current", async () => {
    const a = await generateKeypair();
    let asked = "";
    const r = await readSuccessionState({
      syncUrl: "http://relay/",
      motebitId: MID,
      localPublicKey: hex(a),
      fetchImpl: (async (url: string) => {
        asked = url;
        return new Response(
          JSON.stringify({ chain: [], held_public_key: hex(a), departable: true }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    expect(asked).toBe(`http://relay/api/v1/agents/${MID}/succession?from=${hex(a)}`);
    expect(r).toMatchObject({ state: "current", relayKey: hex(a) });
  });

  it("device rung: the relay holds nothing in registry or chain but says departable — current, from the local key", async () => {
    // The daemon-shut-down state a re-deriving client misread as UNREGISTERED.
    const a = await generateKeypair();
    const r = await readSuccessionState({
      syncUrl: "http://relay",
      motebitId: MID,
      localPublicKey: hex(a),
      fetchImpl: relayAnswering({ chain: [], held_public_key: null, departable: true }),
    });
    expect(r).toMatchObject({ state: "current", relayKey: hex(a) });
  });

  it("S1: not departable, and the relay holds the key a write-ahead rotates to ⇒ applied", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const r = await readSuccessionState({
      syncUrl: "http://relay",
      motebitId: MID,
      localPublicKey: hex(a),
      heldNewPublicKey: hex(b),
      fetchImpl: relayAnswering({
        chain: [await link(a, b)],
        held_public_key: hex(b),
        departable: false,
      }),
    });
    expect(r).toMatchObject({ state: "applied", relayKey: hex(b) });
  });

  it("S4: not departable, no held key, no chain ⇒ unregistered", async () => {
    const a = await generateKeypair();
    const r = await readSuccessionState({
      syncUrl: "http://relay",
      motebitId: MID,
      localPublicKey: hex(a),
      fetchImpl: relayAnswering({ chain: [], held_public_key: null, departable: false }),
    });
    expect(r).toEqual({ state: "unregistered", relayKey: null, chain: [] });
  });

  it("S5: not departable and the relay holds another key ⇒ diverged, naming the SERVED held key, not a re-derived one", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const c = await generateKeypair();
    // Chain tail says b; the relay's own precedence says c (registry). The
    // served `held_public_key` wins — the client does not re-derive.
    const r = await readSuccessionState({
      syncUrl: "http://relay",
      motebitId: MID,
      localPublicKey: hex(a),
      fetchImpl: relayAnswering({
        chain: [await link(a, b)],
        held_public_key: hex(c),
        departable: false,
      }),
    });
    expect(r).toMatchObject({ state: "diverged", relayKey: hex(c) });
  });

  it("a relay that does not answer the departure question is UNREACHABLE — guessing is what this read replaces", async () => {
    const a = await generateKeypair();
    const r = await readSuccessionState({
      syncUrl: "http://relay",
      motebitId: MID,
      localPublicKey: hex(a),
      fetchImpl: relayAnswering({ chain: [], current_public_key: hex(a) }),
    });
    expect(r).toMatchObject({ state: "unreachable" });
    expect((r as { reason: string }).reason).toContain("upgrade");
  });

  it("S6: unreachable, a non-2xx, or a body that is not a relay's ⇒ unreachable — never unregistered", async () => {
    const a = await generateKeypair();
    const base = { syncUrl: "http://relay", motebitId: MID, localPublicKey: hex(a) };
    const thrown = await readSuccessionState({
      ...base,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(thrown).toMatchObject({ state: "unreachable", reason: "ECONNREFUSED" });
    const five = await readSuccessionState({ ...base, fetchImpl: relayAnswering({}, 503) });
    expect(five).toMatchObject({ state: "unreachable" });
    const portal = await readSuccessionState({
      ...base,
      fetchImpl: (async () =>
        new Response("<html>login</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(portal).toMatchObject({ state: "unreachable" });
  });
});

describe("submitSuccessionToRelay — the forward path", () => {
  it("presents the record to the rotate-key route, signed by the RETIRING key, under the audience the spec names", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const record = await link(a, b);
    let seen: { url: string; init: RequestInit } | null = null;
    const res = await submitSuccessionToRelay({
      syncUrl: "http://relay/",
      motebitId: MID,
      deviceId: "d-1",
      signingKey: a.privateKey,
      record,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ ok: true, motebit_id: MID, applied: true }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: true, applied: true });
    expect(seen!.url).toBe(`http://relay/api/v1/agents/${MID}/rotate-key`);
    expect(JSON.parse(seen!.init.body as string)).toEqual(record);
    const bearer = (seen!.init.headers as Record<string, string>)["Authorization"]!.replace(
      "Bearer ",
      "",
    );
    // Verifiable by A (the relay's key on file), NOT by B — and it names
    // the device and the audience the spec assigns to this route.
    expect(await verifySignedToken(bearer, a.publicKey)).toMatchObject({
      mid: MID,
      did: "d-1",
      aud: "rotate-key",
    });
    expect(await verifySignedToken(bearer, b.publicKey)).toBeNull();
  });

  it("a 4xx is REFUSED — the caller must not commit", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const res = await submitSuccessionToRelay({
      syncUrl: "http://relay",
      motebitId: MID,
      deviceId: "d-1",
      signingKey: a.privateKey,
      record: await link(a, b),
      fetchImpl: (async () =>
        new Response("not from current key", { status: 400 })) as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, kind: "refused", status: 400 });
  });

  it("no answer, a 5xx, or a body that is not a relay's is UNKNOWN — the relay may have applied it", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const base = {
      syncUrl: "http://relay",
      motebitId: MID,
      deviceId: "d-1",
      signingKey: a.privateKey,
      record: await link(a, b),
    };
    const thrown = await submitSuccessionToRelay({
      ...base,
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch,
    });
    expect(thrown).toMatchObject({ ok: false, kind: "unknown", reason: "socket hang up" });
    const five = await submitSuccessionToRelay({
      ...base,
      fetchImpl: (async () =>
        new Response("bad gateway", { status: 502 })) as unknown as typeof fetch,
    });
    expect(five).toMatchObject({ ok: false, kind: "unknown" });
    const portal = await submitSuccessionToRelay({
      ...base,
      fetchImpl: (async () =>
        new Response("<html>login</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(portal).toMatchObject({ ok: false, kind: "unknown" });
  });

  it("reads `applied: false` as a retry that landed earlier, not a failure", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const res = await submitSuccessionToRelay({
      syncUrl: "http://relay",
      motebitId: MID,
      deviceId: "d-1",
      signingKey: a.privateKey,
      record: await link(a, b),
      fetchImpl: relayAnswering({ ok: true, motebit_id: MID, applied: false }),
    });
    expect(res).toEqual({ ok: true, applied: false });
  });

  it("refuses an empty device id before any request — the relay refuses an empty did before any key lookup", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    let called = false;
    const res = await submitSuccessionToRelay({
      syncUrl: "http://relay",
      motebitId: MID,
      deviceId: "",
      signingKey: a.privateKey,
      record: await link(a, b),
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, kind: "refused" });
    expect(called).toBe(false);
  });
});
