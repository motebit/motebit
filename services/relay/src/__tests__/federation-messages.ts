/**
 * Test-side federation v2 helpers (relay-federation@1.5 §3.5). Every producer
 * here goes through `@motebit/crypto`'s ONE signer — a test never builds
 * federation bytes by hand — so the suites exercise exactly the bytes a relay
 * sends.
 */
import {
  bytesToHex,
  getPublicKeyBySuite,
  signFederationMessage,
  verifyFederationMessage,
} from "@motebit/crypto";
import type { SignedFederationMessage } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";

export type { SignedFederationMessage };

export interface RevocationLike {
  type: string;
  motebit_id: string;
  timestamp: number;
  signature: string;
  new_public_key?: string;
  credential_id?: string;
}

/** A v2 heartbeat request body from `sender` to `recipient` (by id and key). */
export async function heartbeatRequest(args: {
  sender: string;
  recipient: string;
  /** The recipient's public key, as the signer verified it (hex). */
  recipientPublicKey: string;
  privateKey: Uint8Array;
  agentCount?: number;
  revocations?: RevocationLike[];
  now?: number;
  nonce?: string;
}): Promise<{
  message: SignedFederationMessage;
  agent_count: number;
  revocations?: RevocationLike[];
}> {
  const agentCount = args.agentCount ?? 0;
  const revocations = args.revocations ?? [];
  const message = await signFederationMessage({
    kind: "heartbeat",
    sender: args.sender,
    recipient: args.recipient,
    recipientPublicKey: args.recipientPublicKey,
    body: { agent_count: agentCount, revocations },
    privateKey: args.privateKey,
    now: args.now,
    nonce: args.nonce,
  });
  return {
    message,
    agent_count: agentCount,
    ...(revocations.length > 0 ? { revocations } : {}),
  };
}

/** A v2 peer-remove request body from `sender` to `recipient` (by id and key). */
export async function removeRequest(args: {
  sender: string;
  recipient: string;
  /** The recipient's public key, as the signer verified it (hex). */
  recipientPublicKey: string;
  privateKey: Uint8Array;
  now?: number;
}): Promise<{ message: SignedFederationMessage }> {
  const message = await signFederationMessage({
    kind: "peer-remove",
    sender: args.sender,
    recipient: args.recipient,
    recipientPublicKey: args.recipientPublicKey,
    body: { action: "remove" },
    privateKey: args.privateKey,
    now: args.now,
  });
  return { message };
}

/**
 * A fetch stub standing in for heartbeat peers: for a POST to
 * `/federation/v1/peer/heartbeat` it answers with a valid signed
 * `heartbeat-ack` from the addressed peer, using `keys` (peer id → private
 * key), addressed to the heartbeating relay by id and by `relayPublicKeyHex`.
 * `reply(peerId)` returning false makes that peer unreachable.
 */
export function ackingFetch(
  keys: Map<string, Uint8Array>,
  relayPublicKeyHex: string,
  reply: (peerId: string) => boolean = () => true,
): (input: unknown, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const raw = init?.body;
    const body = JSON.parse(typeof raw === "string" ? raw : "{}") as {
      message?: { envelope?: { sender: string; recipient: string; nonce: string } };
    };
    const env = body.message?.envelope;
    if (env === undefined) throw new Error("ackingFetch: not a v2 heartbeat");
    if (!reply(env.recipient)) throw new Error("Connection refused");
    const key = keys.get(env.recipient);
    if (key === undefined) throw new Error(`ackingFetch: no key for ${env.recipient}`);
    const message = await signFederationMessage({
      kind: "heartbeat-ack",
      sender: env.recipient,
      recipient: env.sender,
      recipientPublicKey: relayPublicKeyHex,
      body: { request_nonce: env.nonce, agent_count: 1 },
      privateKey: key,
    });
    return new Response(JSON.stringify({ message, agent_count: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Verify a relay's heartbeat ack the way the sending relay does. */
export async function ackVerifies(
  ack: { message?: unknown; agent_count?: number },
  args: {
    self: string;
    selfPublicKeyHex: string;
    peer: string;
    peerPublicKeyHex: string;
    requestNonce: string;
  },
): Promise<boolean> {
  const v = await verifyFederationMessage(ack.message, {
    kind: "heartbeat-ack",
    self: args.self,
    selfPublicKeyHex: args.selfPublicKeyHex,
    expectedSender: args.peer,
    senderPublicKeyHex: args.peerPublicKeyHex,
    body: { request_nonce: args.requestNonce, agent_count: ack.agent_count },
  });
  return v.ok;
}

/**
 * A `/federation/v1/peer/confirm` request body (relay-federation@1.5 §3.1):
 * the confirm, the nonce it answers, and the key and endpoint the propose
 * named (the issuer recognises its nonce only for exactly those).
 */
export interface ConfirmRequest {
  message: SignedFederationMessage;
  nonce: string;
  public_key: string;
  endpoint_url: string;
}

/**
 * The relay's own step-3 confirm, minted the only way relay-federation@1.5
 * allows: by its operator, on the master-token admin route — a v2
 * `peer-confirm` to `recipient` (the relay that issued `nonce`) confirming
 * the relay's own federation endpoint. Returns the confirm request body.
 */
export async function operatorConfirm(
  relay: SyncRelay,
  nonce: string,
  /** The relay operator's master-token header (test-helpers' `AUTH_HEADER`). */
  headers: Record<string, string>,
  /**
   * The relay that issued `nonce` — the one the confirm is for — by id AND
   * key: relay ids are not self-certifying, so the confirm commits to both.
   */
  recipient: { id: string; publicKey: string },
  /** The endpoint the propose named, when not the relay's configured one verbatim. */
  endpointUrl?: string,
): Promise<ConfirmRequest> {
  const res = await relay.app.request("/api/v1/admin/federation/peer-confirm-signature", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      nonce,
      recipient: recipient.id,
      recipient_public_key: recipient.publicKey,
      ...(endpointUrl !== undefined ? { endpoint_url: endpointUrl } : {}),
    }),
  });
  if (res.status !== 200) {
    throw new Error(`operatorConfirm: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    message: SignedFederationMessage;
    nonce: string;
    public_key: string;
    endpoint_url: string;
  };
  return {
    message: body.message,
    nonce: body.nonce,
    public_key: body.public_key,
    endpoint_url: body.endpoint_url,
  };
}

/**
 * A step-3 confirm signed directly with `privateKey` — for tests that hold a
 * relay's key (or a stranger's) without its operator route.
 */
export async function signedConfirm(args: {
  sender: string;
  recipient: string;
  /** The recipient's public key, as the signer believes it (hex). */
  recipientPublicKey: string;
  nonce: string;
  endpointUrl: string;
  privateKey: Uint8Array;
  now?: number;
  /** The key the request claims the propose named, when not the signer's own (a forgery). */
  proposedPublicKey?: string;
  /** The endpoint the request claims the propose named, when not the signed one (a forgery). */
  proposedEndpointUrl?: string;
}): Promise<ConfirmRequest> {
  const message = await signFederationMessage({
    kind: "peer-confirm",
    sender: args.sender,
    recipient: args.recipient,
    recipientPublicKey: args.recipientPublicKey,
    body: { nonce: args.nonce, endpoint_url: args.endpointUrl },
    privateKey: args.privateKey,
    now: args.now,
  });
  const publicKey = bytesToHex(
    await getPublicKeyBySuite(args.privateKey, "motebit-jcs-ed25519-hex-v1"),
  );
  return {
    message,
    nonce: args.nonce,
    public_key: args.proposedPublicKey ?? publicKey,
    endpoint_url: args.proposedEndpointUrl ?? args.endpointUrl,
  };
}
