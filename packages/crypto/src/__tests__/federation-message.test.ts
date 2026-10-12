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
/** The recipients' public keys, as the signer verified them (hex). */
const PUB_B = "0b".repeat(32);
const PUB_C = "0c".repeat(32);

async function setup() {
  const kp = await generateKeypair();
  const body = { agent_count: 3, revocations: [] };
  const msg = await signFederationMessage({
    kind: "heartbeat",
    sender: A,
    recipient: B,
    recipientPublicKey: PUB_B,
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
      selfPublicKeyHex: PUB_B,
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
      selfPublicKeyHex: PUB_B,
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
      selfPublicKeyHex: PUB_B,
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
      selfPublicKeyHex: PUB_B,
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
        selfPublicKeyHex: PUB_B,
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
        selfPublicKeyHex: PUB_B,
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
      selfPublicKeyHex: PUB_B,
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
      selfPublicKeyHex: PUB_B,
      senderPublicKeyHex: pub,
      body: { agent_count: 4, revocations: [] },
      now: NOW,
    });
    expect(v).toEqual({ ok: false, reason: "body_mismatch" });
  });

  it("refuses malformed shapes and extra envelope fields", async () => {
    const { body, msg, pub } = await setup();
    const opts = {
      kind: "heartbeat" as const,
      self: B,
      selfPublicKeyHex: PUB_B,
      senderPublicKeyHex: pub,
      body,
      now: NOW,
    };
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
    const opts = {
      kind: "heartbeat" as const,
      self: B,
      selfPublicKeyHex: PUB_B,
      senderPublicKeyHex: pub,
      body,
      now: NOW,
    };
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
        recipientPublicKey: PUB_B,
        body: {},
        privateKey: kp.privateKey,
      }),
    ).rejects.toThrow(/unknown federation message kind/);
    await expect(
      signFederationMessage({
        kind: "peer-remove",
        sender: A,
        recipient: A,
        recipientPublicKey: PUB_B,
        body: {},
        privateKey: kp.privateKey,
      }),
    ).rejects.toThrow(/must differ/);
  });
});

describe("federation message v2 — the signer signs only well-formed text", () => {
  it("refuses an unpaired surrogate in the body or the envelope, signing nothing", async () => {
    const kp = await generateKeypair();
    const base = { kind: "heartbeat" as const, privateKey: kp.privateKey, now: NOW };
    await expect(
      signFederationMessage({
        ...base,
        sender: A,
        recipient: B,
        recipientPublicKey: PUB_B,
        body: { x: "\uD800" },
      }),
    ).rejects.toThrow(/surrogate/i);
    await expect(
      signFederationMessage({
        ...base,
        sender: "relay-\uDC00",
        recipient: B,
        recipientPublicKey: PUB_B,
        body: {},
      }),
    ).rejects.toThrow(/surrogate/i);
  });
});

describe("federation message v2 — the handshake kinds", () => {
  it("a peer-confirm verifies only at the relay that issued the nonce, for the endpoint it names", async () => {
    const kp = await generateKeypair();
    const pub = bytesToHex(kp.publicKey);
    const body = { nonce: "ab".repeat(32), endpoint_url: "https://relay-a.example" };
    const msg = await signFederationMessage({
      kind: "peer-confirm",
      sender: A,
      recipient: B,
      recipientPublicKey: PUB_B,
      body,
      privateKey: kp.privateKey,
      now: NOW,
    });
    const at = (
      self: string,
      b: unknown,
      kind: "peer-confirm" | "peer-challenge" = "peer-confirm",
      selfPublicKeyHex: string = PUB_B,
    ) =>
      verifyFederationMessage(msg, {
        kind,
        self,
        selfPublicKeyHex,
        senderPublicKeyHex: pub,
        body: b,
        now: NOW,
      });
    expect((await at(B, body)).ok).toBe(true);
    expect(await at(C, body)).toEqual({ ok: false, reason: "wrong_recipient" });
    expect(await at(B, { ...body, endpoint_url: "https://attacker.example" })).toEqual({
      ok: false,
      reason: "body_mismatch",
    });
    expect(await at(B, { ...body, nonce: "cd".repeat(32) })).toEqual({
      ok: false,
      reason: "body_mismatch",
    });
    expect(await at(B, body, "peer-challenge")).toEqual({ ok: false, reason: "kind_mismatch" });
    // By key as well as id: a relay holding B's id under another key refuses it.
    expect(await at(B, body, "peer-confirm", PUB_C)).toEqual({
      ok: false,
      reason: "wrong_recipient_key",
    });
  });
});

describe("federation message v2 — the envelope names its recipient by KEY (round 3)", () => {
  it("every kind refuses at a relay whose own key is not the envelope's, before anything else", async () => {
    const kp = await generateKeypair();
    const pub = bytesToHex(kp.publicKey);
    for (const kind of [
      "heartbeat",
      "heartbeat-ack",
      "peer-remove",
      "peer-challenge",
      "peer-confirm",
    ] as const) {
      const msg = await signFederationMessage({
        kind,
        sender: A,
        recipient: B,
        recipientPublicKey: PUB_B,
        body: { k: kind },
        privateKey: kp.privateKey,
        now: NOW,
      });
      expect(msg.envelope.recipient_public_key).toBe(PUB_B);
      // The same id under another key (a relay whose /identity claimed B's
      // id): refused before kind, id, freshness, body or signature are read.
      expect(
        await verifyFederationMessage(msg, {
          kind: "peer-remove",
          self: "anything",
          selfPublicKeyHex: PUB_C,
          senderPublicKeyHex: pub,
          body: {},
          now: NOW + 10 * 300_000,
        }),
      ).toEqual({ ok: false, reason: "wrong_recipient_key" });
      // Rewriting the envelope's key breaks the signature.
      expect(
        await verifyFederationMessage(
          { ...msg, envelope: { ...msg.envelope, recipient_public_key: PUB_C } },
          {
            kind,
            self: B,
            selfPublicKeyHex: PUB_C,
            senderPublicKeyHex: pub,
            body: { k: kind },
            now: NOW,
          },
        ),
      ).toEqual({ ok: false, reason: "bad_signature" });
      expect(
        (
          await verifyFederationMessage(msg, {
            kind,
            self: B,
            selfPublicKeyHex: PUB_B.toUpperCase(),
            senderPublicKeyHex: pub,
            body: { k: kind },
            now: NOW,
          })
        ).ok,
      ).toBe(true);
    }
  });

  it("the signed bytes carry the recipient key inside the canonical envelope", async () => {
    const kp = await generateKeypair();
    const msg = await signFederationMessage({
      kind: "peer-remove",
      sender: A,
      recipient: B,
      recipientPublicKey: PUB_B.toUpperCase(),
      body: { action: "remove" },
      privateKey: kp.privateKey,
      now: NOW,
      nonce: "11".repeat(32),
    });
    const text = new TextDecoder().decode(federationMessageBytes(msg.envelope));
    expect(text).toBe(
      `${FEDERATION_MESSAGE_DOMAIN}\0peer-remove\0{"body_sha256":"${msg.envelope.body_sha256}","kind":"peer-remove","nonce":"${"11".repeat(32)}","recipient":"${B}","recipient_public_key":"${PUB_B}","sender":"${A}","suite":"motebit-jcs-ed25519-hex-v1","ts":${String(NOW)}}`,
    );
  });

  it("a malformed or missing recipient key is malformed; the signer refuses none, a bad one, or its own", async () => {
    const kp = await generateKeypair();
    const pub = bytesToHex(kp.publicKey);
    const msg = await signFederationMessage({
      kind: "heartbeat",
      sender: A,
      recipient: B,
      recipientPublicKey: PUB_B,
      body: {},
      privateKey: kp.privateKey,
      now: NOW,
    });
    const opts = {
      kind: "heartbeat" as const,
      self: B,
      selfPublicKeyHex: PUB_B,
      senderPublicKeyHex: pub,
      body: {},
      now: NOW,
    };
    const { recipient_public_key: _drop, ...without } = msg.envelope;
    for (const env of [
      without,
      { ...msg.envelope, recipient_public_key: PUB_B.toUpperCase() },
      { ...msg.envelope, recipient_public_key: "0b" },
    ])
      expect(await verifyFederationMessage({ ...msg, envelope: env }, opts)).toEqual({
        ok: false,
        reason: "malformed",
      });
    const base = {
      kind: "heartbeat" as const,
      sender: A,
      recipient: B,
      body: {},
      privateKey: kp.privateKey,
    };
    for (const recipientPublicKey of [undefined, "", "zz".repeat(32), "0b".repeat(31)])
      await expect(
        signFederationMessage({ ...base, recipientPublicKey: recipientPublicKey as never }),
      ).rejects.toThrow(/recipient's public key/);
    await expect(signFederationMessage({ ...base, recipientPublicKey: pub })).rejects.toThrow(
      /signer's own key/,
    );
  });
});
