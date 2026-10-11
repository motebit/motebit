/**
 * `motebit federation peer` handshake (relay-federation@1.5 §3.1, cold review
 * F1): the operator's tooling never has its relay sign a bare nonce. It
 * checks the counterparty's `peer-challenge` (from the counterparty's key,
 * to this relay, answering this relay's own nonce, for this relay's
 * endpoint) before minting, and the mint it asks for names the counterparty
 * as recipient and this relay's own endpoint.
 *
 * The two relays are stubbed at the fetch layer; the counterparty's
 * challenge is signed with the real v2 signer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, generateKeypair, signFederationMessage } from "@motebit/encryption";

import { runPeerHandshake } from "../subcommands/federation.js";

const A_URL = "https://relay-a.example";
const B_URL = "https://relay-b.example";
const A_ID = "relay-a-id";
const B_ID = "relay-b-id";
const ISSUED = "ab".repeat(32);

interface Stub {
  /** What B's propose answers: its challenge is built from the propose body. */
  challenge: (propose: { nonce: string; endpoint_url: string }) => Promise<unknown>;
  bPublicKeyHex: string;
}

let stub: Stub;
let mints: Array<Record<string, unknown>>;
let confirms: Array<Record<string, unknown>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  const bKey = await generateKeypair();
  mints = [];
  confirms = [];
  stub = {
    bPublicKeyHex: bytesToHex(bKey.publicKey),
    challenge: (p) =>
      signFederationMessage({
        kind: "peer-challenge",
        sender: B_ID,
        recipient: A_ID,
        body: { request_nonce: p.nonce, nonce: ISSUED, proposer_endpoint_url: p.endpoint_url },
        privateKey: bKey.privateKey,
      }),
  };
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (url === `${A_URL}/federation/v1/identity`)
      return json({ relay_motebit_id: A_ID, public_key: "aa".repeat(32) });
    if (url === `${B_URL}/federation/v1/identity`)
      return json({ relay_motebit_id: B_ID, public_key: stub.bPublicKeyHex });
    if (url === `${B_URL}/federation/v1/peer/propose`) {
      const p = body as { nonce: string; endpoint_url: string };
      return json({ relay_id: B_ID, nonce: ISSUED, challenge: await stub.challenge(p) });
    }
    if (url === `${A_URL}/api/v1/admin/federation/peer-confirm-signature`) {
      mints.push(body);
      return json({ relay_id: A_ID, nonce: body.nonce, endpoint_url: A_URL, message: { m: 1 } });
    }
    if (url === `${B_URL}/federation/v1/peer/confirm`) {
      confirms.push(body);
      return json({ status: "active" });
    }
    throw new Error(`unrouted: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runPeerHandshake — the confirm is bound before it is minted", () => {
  it("a verified challenge: the mint names the counterparty and this relay's endpoint", async () => {
    const r = await runPeerHandshake({ url: A_URL, headers: {} }, { url: B_URL });
    expect(r).toMatchObject({ ok: true, half: true });
    expect(mints).toEqual([{ nonce: ISSUED, recipient: B_ID, endpoint_url: A_URL }]);
    expect(confirms).toEqual([{ message: { m: 1 }, nonce: ISSUED }]);
  });

  it("a challenge not from the counterparty's key: nothing is minted", async () => {
    const other = await generateKeypair();
    stub.bPublicKeyHex = bytesToHex(other.publicKey); // identity claims a key the challenge was not signed by
    const r = await runPeerHandshake({ url: A_URL, headers: {} }, { url: B_URL });
    expect(r).toMatchObject({ ok: false, step: "challenge-a-to-b" });
    expect(mints).toEqual([]);
    expect(confirms).toEqual([]);
  });

  it("a challenge for another endpoint (the propose was re-pointed in transit): nothing is minted", async () => {
    const sign = stub.challenge;
    stub.challenge = (p) => sign({ ...p, endpoint_url: "https://attacker.example" });
    const r = await runPeerHandshake({ url: A_URL, headers: {} }, { url: B_URL });
    expect(r).toMatchObject({ ok: false, step: "challenge-a-to-b" });
    expect(mints).toEqual([]);
  });

  it("a challenge answering another nonce (a nonce lifted from elsewhere): nothing is minted", async () => {
    const sign = stub.challenge;
    stub.challenge = (p) => sign({ ...p, nonce: "cd".repeat(32) });
    const r = await runPeerHandshake({ url: A_URL, headers: {} }, { url: B_URL });
    expect(r).toMatchObject({ ok: false, step: "challenge-a-to-b" });
    expect(mints).toEqual([]);
  });

  it("a bare hex challenge (a 1.4 relay): nothing is minted", async () => {
    stub.challenge = () => Promise.resolve("ab".repeat(64));
    const r = await runPeerHandshake({ url: A_URL, headers: {} }, { url: B_URL });
    expect(r).toMatchObject({ ok: false, step: "challenge-a-to-b" });
    expect(mints).toEqual([]);
  });
});
