/**
 * Test-side federation v2 helpers (relay-federation@1.5 §3.5). Every producer
 * here goes through `@motebit/crypto`'s ONE signer — a test never builds
 * federation bytes by hand — so the suites exercise exactly the bytes a relay
 * sends.
 */
import { signFederationMessage, verifyFederationMessage } from "@motebit/crypto";
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

/** A v2 heartbeat request body from `sender` to `recipient`. */
export async function heartbeatRequest(args: {
  sender: string;
  recipient: string;
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

/** A v2 peer-remove request body from `sender` to `recipient`. */
export async function removeRequest(args: {
  sender: string;
  recipient: string;
  privateKey: Uint8Array;
  now?: number;
}): Promise<{ message: SignedFederationMessage }> {
  const message = await signFederationMessage({
    kind: "peer-remove",
    sender: args.sender,
    recipient: args.recipient,
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
 * key). `reply(peerId)` returning false makes that peer unreachable.
 */
export function ackingFetch(
  keys: Map<string, Uint8Array>,
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
  args: { self: string; peer: string; peerPublicKeyHex: string; requestNonce: string },
): Promise<boolean> {
  const v = await verifyFederationMessage(ack.message, {
    kind: "heartbeat-ack",
    self: args.self,
    expectedSender: args.peer,
    senderPublicKeyHex: args.peerPublicKeyHex,
    body: { request_nonce: args.requestNonce, agent_count: ack.agent_count },
  });
  return v.ok;
}

/**
 * The relay's own step-3 confirm signature over `nonce`, minted the only way
 * relay-federation@1.5 allows: by its operator, on the master-token admin
 * route (self-propose is refused).
 */
export async function operatorConfirm(
  relay: SyncRelay,
  nonce: string,
  /** The relay operator's master-token header (test-helpers' `AUTH_HEADER`). */
  headers: Record<string, string>,
): Promise<string> {
  const res = await relay.app.request("/api/v1/admin/federation/peer-confirm-signature", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  if (res.status !== 200) {
    throw new Error(`operatorConfirm: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { challenge_response: string }).challenge_response;
}
