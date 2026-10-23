/**
 * The live federation test's own discover sender (`scripts/lib/federation-live-v2.mjs`,
 * used by `scripts/test-federation-live.mjs` Phase 3 "Direct federation
 * discover") against a real relay, so a drift between the script's
 * dependency-free v2 mirror and the relay's verifier (relay-federation@1.5
 * §3.5, §4.1.1) is red here rather than on the next staging run.
 *
 * The synthetic peer is peered with the relay through the real handshake, as
 * Phase 2 does. Its discover, signed by the script for the relay's key, is
 * answered with the relay's agent; the same signer addressed to another
 * relay's key is refused `wrong_recipient_key`; the pre-1.5 body the script
 * used to send (`timestamp` + hex `signature`, no `message`) is refused 400 by
 * name.
 */
import { createPrivateKey } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct crypto
import { bytesToHex, generateKeypair } from "@motebit/encryption";

import type { SyncRelay } from "../index.js";
import { initRelayIdentity, type RelayIdentity } from "../federation.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { signedConfirm } from "./federation-messages.js";
/* eslint-disable import/no-relative-packages -- the live script's own signer, run against a relay; scripts/ is not a package to depend on */
import {
  canonicalJson,
  directDiscoverRequest,
} from "../../../../scripts/lib/federation-live-v2.mjs";
/* eslint-enable import/no-relative-packages */

const RELAY_URL = "http://relay-live-signer.test:3000";
const PEER_URL = "https://synthetic-peer.live-signer.test";
const CAPABILITY = "live-signer-cap";

let relay: SyncRelay;
let relayId: RelayIdentity;
let peer: { id: string; publicKeyHex: string; privateKey: Uint8Array };
let agentId: string;

/** A Node KeyObject over a raw Ed25519 seed, as the live script's `makePrivKeyObj`. */
function keyObject(seed: Uint8Array) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
}

async function post(path: string, body: unknown): Promise<Response> {
  return relay.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  relay = await createTestRelay({
    enableDeviceAuth: false,
    federation: { endpointUrl: RELAY_URL, displayName: "Relay" },
  });
  relayId = await initRelayIdentity(relay.moteDb.db);

  // The synthetic peer, peered through the real propose + confirm (Phase 2).
  const kp = await generateKeypair();
  peer = {
    id: `synthetic-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`,
    publicKeyHex: bytesToHex(kp.publicKey),
    privateKey: kp.privateKey,
  };
  const proposed = (await (
    await post("/federation/v1/peer/propose", {
      relay_id: peer.id,
      public_key: peer.publicKeyHex,
      endpoint_url: PEER_URL,
      nonce: crypto.randomUUID(),
    })
  ).json()) as { nonce: string };
  const confirmed = await post("/federation/v1/peer/confirm", {
    relay_id: peer.id,
    ...(await signedConfirm({
      sender: peer.id,
      recipient: relayId.relayMotebitId,
      recipientPublicKey: relayId.publicKeyHex,
      nonce: proposed.nonce,
      endpointUrl: PEER_URL,
      privateKey: peer.privateKey,
    })),
  });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);

  // An agent the discover should find.
  const agentKp = await generateKeypair();
  const json = { "Content-Type": "application/json", ...AUTH_HEADER };
  agentId = (
    (await (
      await relay.app.request("/identity", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ owner_id: "live-signer" }),
      })
    ).json()) as { motebit_id: string }
  ).motebit_id;
  const reg = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      motebit_id: agentId,
      endpoint_url: "http://localhost:0/mcp",
      capabilities: [CAPABILITY],
      public_key: bytesToHex(agentKp.publicKey),
    }),
  });
  expect(reg.status).toBeLessThan(300);
});

afterEach(async () => {
  await relay.close();
});

describe("the live federation test's discover sender (scripts/lib/federation-live-v2.mjs)", () => {
  it("signed for this relay's key: accepted, and the relay's agent is found", async () => {
    const body = directDiscoverRequest({
      sender: peer.id,
      recipient: { relayMotebitId: relayId.relayMotebitId, publicKey: relayId.publicKeyHex },
      capability: CAPABILITY,
      queryId: crypto.randomUUID(),
      privKeyObj: keyObject(peer.privateKey),
    });
    const res = await post("/federation/v1/discover", body);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const agents = (JSON.parse(text) as { agents: Array<{ motebit_id: string }> }).agents;
    expect(agents.map((a) => a.motebit_id)).toContain(agentId);
  });

  it("signed for another relay's key: refused wrong_recipient_key", async () => {
    const other = await generateKeypair();
    const body = directDiscoverRequest({
      sender: peer.id,
      recipient: { relayMotebitId: relayId.relayMotebitId, publicKey: bytesToHex(other.publicKey) },
      capability: CAPABILITY,
      queryId: crypto.randomUUID(),
      privKeyObj: keyObject(peer.privateKey),
    });
    const res = await post("/federation/v1/discover", body);
    const text = await res.text();
    expect(res.status, text).toBe(400);
    expect(text).toMatch(/wrong_recipient_key/);
  });

  it("the pre-1.5 body the script used to send (timestamp + hex signature): refused 400 by name", async () => {
    const payload = {
      query: { capability: CAPABILITY, limit: 10 },
      hop_count: 0,
      max_hops: 1,
      visited: [peer.id],
      query_id: crypto.randomUUID(),
      origin_relay: peer.id,
      sender_relay: peer.id,
      timestamp: Date.now(),
    };
    const { sign } = await import("node:crypto");
    const signature = sign(
      null,
      Buffer.from(canonicalJson(payload)),
      keyObject(peer.privateKey),
    ).toString("hex");
    const res = await post("/federation/v1/discover", { ...payload, signature });
    const text = await res.text();
    expect(res.status, text).toBe(400);
    expect(text).toMatch(/v1 is refused/);
  });
});
