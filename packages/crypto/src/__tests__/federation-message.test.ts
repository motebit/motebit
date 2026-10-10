/**
 * Federation signed messages v2 — one producer, one verifier, every v2 kind.
 * Each domain-separation axis (role, signer, verifier, freshness, body) is
 * flipped alone and must refuse with its own reason.
 */
import { describe, expect, it } from "vitest";

import {
  FEDERATION_MESSAGE_DOMAIN,
  federationMessageBytes,
  parseFederationMessage,
  signFederationMessage,
  verifyFederationMessage,
  type SignedFederationMessage,
} from "../federation-message.js";
import { bytesToHex, generateKeypair } from "../index.js";

const A = "relay-a";
const B = "relay-b";
const C = "relay-c";
const NOW = 1_800_000_000_000;

async function setup() {
  const kp = await generateKeypair();
  const body = { agent_count: 3, revocations: [] };
  const msg = await signFederationMessage({
    kind: "heartbeat",
    sender: A,
    recipient: B,
    body,
    privateKey: kp.privateKey,
    now: NOW,
  });
  return { kp, body, msg, pub: bytesToHex(kp.publicKey) };
}

describe("federation message v2", () => {
  it("verifies at the named recipient under the sender's key", async () => {
    const { body, msg, pub } = await setup();
    const v = await verifyFederationMessage(msg, {
      kind: "heartbeat",
      self: B,
      expectedSender: A,
      senderPublicKeyHex: pub,
      body,
      now: NOW + 1_000,
    });
    expect(v).toEqual({ ok: true, envelope: msg.envelope });
  });

  it("signs the domain-tagged, kind-prefixed canonical envelope", async () => {
    const { msg } = await setup();
    const text = new TextDecoder().decode(federationMessageBytes(msg.envelope));
    expect(text.startsWith(`${FEDERATION_MESSAGE_DOMAIN}\0heartbeat\0{`)).toBe(true);
    expect(msg.envelope.nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses at any relay but the recipient (a heartbeat for B replayed at C)", async () => {
    const { body, msg, pub } = await setup();
    const v = await verifyFederationMessage(msg, {
      kind: "heartbeat",
      self: C,
      senderPublicKeyHex: pub,
      body,
      now: NOW,
    });
    expect(v).toEqual({ ok: false, reason: "wrong_recipient" });
  });

  it("refuses as another kind (role separation)", async () => {
    const { body, msg, pub } = await setup();
    const v = await verifyFederationMessage(msg, {
      kind: "peer-remove",
      self: B,
      senderPublicKeyHex: pub,
      body,
      now: NOW,
    });
    expect(v).toEqual({ ok: false, reason: "kind_mismatch" });
  });

  it("refuses a relabelled kind inside the envelope (the kind is under the signature)", async () => {
    const { body, msg, pub } = await setup();
    const forged: SignedFederationMessage = {
      ...msg,
      envelope: { ...msg.envelope, kind: "heartbeat-ack" },
    };
    const v = await verifyFederationMessage(forged, {
      kind: "heartbeat-ack",
      self: B,
      senderPublicKeyHex: pub,
      body,
      now: NOW,
    });
    expect(v).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses an unexpected sender and a stranger's key", async () => {
    const { body, msg, pub } = await setup();
    expect(
      await verifyFederationMessage(msg, {
        kind: "heartbeat",
        self: B,
        expectedSender: C,
        senderPublicKeyHex: pub,
        body,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "wrong_sender" });
    const other = bytesToHex((await generateKeypair()).publicKey);
    expect(
      await verifyFederationMessage(msg, {
        kind: "heartbeat",
        self: B,
        senderPublicKeyHex: other,
        body,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses outside the freshness window", async () => {
    const { body, msg, pub } = await setup();
    const v = await verifyFederationMessage(msg, {
      kind: "heartbeat",
      self: B,
      senderPublicKeyHex: pub,
      body,
      now: NOW + 300_001,
    });
    expect(v).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a different body than the one committed to", async () => {
    const { msg, pub } = await setup();
    const v = await verifyFederationMessage(msg, {
      kind: "heartbeat",
      self: B,
      senderPublicKeyHex: pub,
      body: { agent_count: 4, revocations: [] },
      now: NOW,
    });
    expect(v).toEqual({ ok: false, reason: "body_mismatch" });
  });

  it("refuses malformed shapes and extra envelope fields", async () => {
    const { body, msg, pub } = await setup();
    const opts = { kind: "heartbeat" as const, self: B, senderPublicKeyHex: pub, body, now: NOW };
    for (const bad of [
      null,
      "x",
      { envelope: msg.envelope },
      { ...msg, signature: "zz" },
      { ...msg, envelope: { ...msg.envelope, extra: 1 } },
      { ...msg, envelope: { ...msg.envelope, nonce: "short" } },
    ]) {
      expect(await verifyFederationMessage(bad, opts)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(parseFederationMessage({ ...msg, envelope: { ...msg.envelope, extra: 1 } })).toBeNull();
  });

  it("refuses an unknown kind and an unsupported suite", async () => {
    const { body, msg, pub } = await setup();
    const opts = { kind: "heartbeat" as const, self: B, senderPublicKeyHex: pub, body, now: NOW };
    expect(
      await verifyFederationMessage({ ...msg, envelope: { ...msg.envelope, kind: "nope" } }, opts),
    ).toEqual({ ok: false, reason: "unknown_kind" });
    expect(
      await verifyFederationMessage(
        { ...msg, envelope: { ...msg.envelope, suite: "motebit-concat-ed25519-hex-v1" } },
        opts,
      ),
    ).toEqual({ ok: false, reason: "unsupported_suite" });
  });

  it("refuses to sign an unknown kind or a message to oneself", async () => {
    const { kp } = await setup();
    await expect(
      signFederationMessage({
        kind: "nope" as never,
        sender: A,
        recipient: B,
        body: {},
        privateKey: kp.privateKey,
      }),
    ).rejects.toThrow(/unknown federation message kind/);
    await expect(
      signFederationMessage({
        kind: "peer-remove",
        sender: A,
        recipient: A,
        body: {},
        privateKey: kp.privateKey,
      }),
    ).rejects.toThrow(/must differ/);
  });
});
