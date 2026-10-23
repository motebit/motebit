import type { KeyObject } from "node:crypto";

export function canonicalJson(obj: unknown): string;

export interface LiveSignedMessage {
  envelope: {
    kind: string;
    sender: string;
    recipient: string;
    recipient_public_key: string;
    ts: number;
    nonce: string;
    body_sha256: string;
    suite: string;
  };
  signature: string;
}

export function signFederationV2(args: {
  kind: string;
  sender: string;
  recipient: string;
  recipientPublicKey: string;
  body: unknown;
  privKeyObj: KeyObject;
  ts?: number;
}): LiveSignedMessage;

export function directDiscoverRequest(args: {
  sender: string;
  recipient: { relayMotebitId: string; publicKey: string };
  capability: string;
  queryId: string;
  privKeyObj: KeyObject;
}): Record<string, unknown> & { message: LiveSignedMessage };
