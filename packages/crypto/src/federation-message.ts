/**
 * Federation signed messages, v2 (`spec/relay-federation-v1.md` §3.5;
 * docs/design/identity-authority-writers.md §5.3).
 *
 * Every v1 federation signature named only its signer: a heartbeat signed
 * `{relay_id}|{ts}|{suite}` (no recipient, no nonce — the response used the
 * same bytes, so any peer could harvest a heartbeat "from" R good at every
 * peer of R for five minutes), and a removal signed the bare `relay_id` (one
 * signature removed R at every relay, forever). A v2 message is
 * domain-separated by four things at once:
 *
 *   - its ROLE      — `kind`, a closed set; the kind is both inside the
 *                     canonical envelope and in the byte prefix, so a
 *                     signature for one kind never verifies as another;
 *   - its SIGNER    — `sender`, the relay id whose key must verify it;
 *   - its VERIFIER  — `recipient` AND `recipient_public_key`: the one relay
 *                     that may accept it, by id and by KEY. Relay ids are
 *                     random, not derived from keys, so a relay's
 *                     `/identity` can claim any id; an id alone names no
 *                     relay. The signer commits to the key it verified the
 *                     recipient under, and the verifier compares it to its
 *                     OWN key before anything else — so a message minted
 *                     against an identity that claimed another relay's id
 *                     never verifies at that relay, whatever its kind;
 *   - its FRESHNESS — `ts` within the kind's window, plus a single-use
 *                     `nonce` the verifier records (the replay store is the
 *                     verifier's, not this module's).
 *
 * The body the message authorizes is bound by `body_sha256` =
 * lowercase-hex SHA-256 of its JCS canonical form, so the envelope commits to
 * the payload without carrying it twice.
 *
 * Signed bytes:
 *
 *   "motebit-fed/v2\0" ‖ kind ‖ "\0" ‖ JCS(envelope)
 *
 * ONE producer (`signFederationMessage`) and ONE verifier
 * (`verifyFederationMessage`) for every kind: a relay never builds these bytes
 * by hand. The verifier is pure — the caller supplies the sender's key (from
 * its own peer table) and its own id, and consumes the nonce in the same
 * transaction as the write the message authorizes.
 */
import {
  bytesToHex,
  canonicalJson,
  canonicalJsonForSigning,
  canonicalSha256,
  hexToBytes,
  sha256,
} from "./signing.js";
import { getPublicKeyBySuite, signBySuite, verifyBySuite } from "./suite-dispatch.js";

/** The byte-prefix domain tag of every v2 federation message. */
export const FEDERATION_MESSAGE_DOMAIN = "motebit-fed/v2" as const;

/** The suite of every v2 federation message: JCS envelope, Ed25519, hex signature. */
export const FEDERATION_MESSAGE_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/**
 * The closed set of v2 message kinds, each with its freshness window. Adding a
 * kind is a registry append here plus its verifier site (docs/design/
 * identity-authority-writers.md §5.3 lists the kinds still to move).
 *
 *   - `heartbeat`      — sender: a peer relay; verifier: the recipient peer.
 *                        Body `{ agent_count, revocations }`.
 *   - `heartbeat-ack`  — sender: the heartbeat's recipient; verifier: the
 *                        heartbeat's sender. Body `{ request_nonce,
 *                        agent_count }` — the ack answers exactly one request.
 *   - `peer-remove`    — sender: the relay leaving; verifier: the one named
 *                        recipient. Body `{ action: "remove" }`.
 *   - `peer-challenge` — handshake step 2. sender: the relay a propose was
 *                        sent to; verifier: the proposer (the envelope's
 *                        `recipient_public_key` is the key the propose named).
 *                        Body `{ request_nonce, nonce, proposer_endpoint_url }`
 *                        — the proposer's nonce it answers, the nonce it
 *                        issued for the confirm, and the endpoint it recorded
 *                        for the proposer.
 *   - `peer-confirm`   — handshake step 3. sender: the proposer; verifier: the
 *                        ONE relay that issued the nonce. Body
 *                        `{ nonce, endpoint_url }` — that nonce and the
 *                        sender's endpoint being confirmed.
 *
 * The four WORK kinds (relay-federation@1.5 §3.5, Inc 6). Each body is the
 * request's own fields (everything but `message`), committed by digest; the
 * sender is the relay that sends this hop, the recipient the one peer it is
 * sent to:
 *
 *   - `discover`           — one hop of a federated discovery query (§4.1).
 *                            Sender: the immediate forwarder (`sender_relay`).
 *   - `task-forward`       — a task forwarded to the relay hosting its agent
 *                            (§5.3). Sender: the origin (`origin_relay`).
 *   - `task-result`        — the executor relay's answer to a forwarded task
 *                            (§5.4). Sender: the executor (`origin_relay`).
 *   - `settlement-forward` — a settlement leg forwarded down the chain (§7.3).
 *                            Sender: the upstream relay (`origin_relay`).
 */
export const FEDERATION_MESSAGE_KINDS = {
  heartbeat: { maxSkewMs: 300_000 },
  "heartbeat-ack": { maxSkewMs: 300_000 },
  "peer-remove": { maxSkewMs: 300_000 },
  "peer-challenge": { maxSkewMs: 300_000 },
  "peer-confirm": { maxSkewMs: 300_000 },
  discover: { maxSkewMs: 300_000 },
  "task-forward": { maxSkewMs: 300_000 },
  "task-result": { maxSkewMs: 300_000 },
  "settlement-forward": { maxSkewMs: 300_000 },
} as const;

export type FederationMessageKind = keyof typeof FEDERATION_MESSAGE_KINDS;

/** The signed envelope. Every field is inside the signature. */
export interface FederationMessageEnvelope {
  kind: FederationMessageKind;
  /** Relay id of the signer. */
  sender: string;
  /** Relay id of the one relay that may accept the message. */
  recipient: string;
  /**
   * Lowercase hex Ed25519 public key of that relay — the key the signer
   * verified it under. The verifier refuses a message whose
   * `recipient_public_key` is not its own key, before anything else.
   */
  recipient_public_key: string;
  /** Epoch ms at signing. */
  ts: number;
  /** 32 random bytes, hex; single-use at the recipient. */
  nonce: string;
  /** Lowercase hex SHA-256 of JCS(body). */
  body_sha256: string;
  suite: typeof FEDERATION_MESSAGE_SUITE;
}

/** A v2 federation message on the wire: the envelope and its hex signature. */
export interface SignedFederationMessage {
  envelope: FederationMessageEnvelope;
  signature: string;
}

export type FederationMessageRefusal =
  | "malformed"
  | "unknown_kind"
  | "kind_mismatch"
  | "unsupported_suite"
  | "wrong_recipient"
  | "wrong_recipient_key"
  | "wrong_sender"
  | "stale"
  | "body_mismatch"
  | "bad_signature";

export type FederationMessageVerdict =
  | { ok: true; envelope: FederationMessageEnvelope }
  | { ok: false; reason: FederationMessageRefusal };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/i;

function isKind(k: unknown): k is FederationMessageKind {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(FEDERATION_MESSAGE_KINDS, k);
}

/**
 * The exact bytes a v2 message signs. `canonicalize` is `canonicalJson` for a
 * verifier; the signer passes `canonicalJsonForSigning`, which refuses an
 * unpaired surrogate and is otherwise byte-identical.
 */
export function federationMessageBytes(
  envelope: FederationMessageEnvelope,
  canonicalize: (obj: unknown) => string = canonicalJson,
): Uint8Array {
  return new TextEncoder().encode(
    `${FEDERATION_MESSAGE_DOMAIN}\0${envelope.kind}\0${canonicalize(envelope)}`,
  );
}

/** Lowercase hex SHA-256 of JCS(body) — the `body_sha256` a message commits to. */
export function federationBodyDigest(body: unknown): Promise<string> {
  return canonicalSha256(body);
}

function randomNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

/**
 * Sign a v2 federation message of `kind` from `sender` to `recipient` — by id
 * AND by `recipientPublicKey`, the key the caller verified the recipient
 * under — over `body`. The only producer of v2 federation signatures. A
 * caller that holds no verified key for the recipient has nothing to sign.
 */
export async function signFederationMessage(args: {
  kind: FederationMessageKind;
  sender: string;
  recipient: string;
  /** Hex Ed25519 public key of the recipient, as the caller verified it. */
  recipientPublicKey: string;
  body: unknown;
  privateKey: Uint8Array;
  /** Injected for tests; defaults to `Date.now()`. */
  now?: number;
  /** Injected for tests; defaults to 32 fresh random bytes. */
  nonce?: string;
}): Promise<SignedFederationMessage> {
  if (!isKind(args.kind)) throw new Error(`unknown federation message kind: ${String(args.kind)}`);
  if (args.sender === "" || args.recipient === "")
    throw new Error("federation message needs a sender and a recipient");
  if (args.sender === args.recipient)
    throw new Error("federation message sender and recipient must differ");
  if (
    typeof args.recipientPublicKey !== "string" ||
    !HEX64.test(args.recipientPublicKey.toLowerCase())
  )
    throw new Error("federation message needs the recipient's public key (64 hex characters)");
  const recipientPublicKey = args.recipientPublicKey.toLowerCase();
  const ownPublicKey = bytesToHex(
    await getPublicKeyBySuite(args.privateKey, FEDERATION_MESSAGE_SUITE),
  ).toLowerCase();
  if (recipientPublicKey === ownPublicKey)
    throw new Error("federation message recipient key is the signer's own key");
  const envelope: FederationMessageEnvelope = {
    kind: args.kind,
    sender: args.sender,
    recipient: args.recipient,
    recipient_public_key: recipientPublicKey,
    ts: args.now ?? Date.now(),
    nonce: args.nonce ?? randomNonce(),
    // Signer side through the guarded canonicalizer (refuses an unpaired
    // surrogate; identical bytes otherwise), so what is signed has one UTF-8
    // form. The verifier keeps canonicalJson.
    body_sha256: bytesToHex(
      await sha256(new TextEncoder().encode(canonicalJsonForSigning(args.body))),
    ),
    suite: FEDERATION_MESSAGE_SUITE,
  };
  const sig = await signBySuite(
    FEDERATION_MESSAGE_SUITE,
    federationMessageBytes(envelope, canonicalJsonForSigning),
    args.privateKey,
  );
  return { envelope, signature: bytesToHex(sig) };
}

/**
 * Verify a v2 federation message. The only verifier of v2 federation
 * signatures. Fail-closed and never throws; checks, in order: shape, the
 * recipient KEY = `selfPublicKeyHex` (the verifier's own key — first, because
 * relay ids are not self-certifying), kind (known AND the one the caller
 * expects), suite, recipient id = `self`, sender = `expectedSender` (when the
 * caller already knows who must have sent it), freshness, body digest,
 * signature under `senderPublicKeyHex`.
 *
 * It does NOT consume the nonce: the caller records `envelope.nonce` for
 * `envelope.sender` in the same transaction as the write the message
 * authorizes, and refuses a nonce it has seen.
 */
export async function verifyFederationMessage(
  message: unknown,
  expect: {
    kind: FederationMessageKind;
    /** The verifying relay's own id. */
    self: string;
    /** The verifying relay's own public key (hex). */
    selfPublicKeyHex: string;
    /** The sender the caller requires, when known before lookup. */
    expectedSender?: string;
    /** The sender's key, as the verifier holds it (hex). */
    senderPublicKeyHex: string;
    /** The body the message must commit to. */
    body: unknown;
    /** Injected for tests; defaults to `Date.now()`. */
    now?: number;
  },
): Promise<FederationMessageVerdict> {
  const parsed = parseFederationMessage(message);
  if (parsed === null) return { ok: false, reason: "malformed" };
  const { envelope, signature } = parsed;
  if (envelope.recipient_public_key !== expect.selfPublicKeyHex.toLowerCase())
    return { ok: false, reason: "wrong_recipient_key" };
  if (!isKind(envelope.kind)) return { ok: false, reason: "unknown_kind" };
  if (envelope.kind !== expect.kind) return { ok: false, reason: "kind_mismatch" };
  if (envelope.suite !== FEDERATION_MESSAGE_SUITE)
    return { ok: false, reason: "unsupported_suite" };
  if (envelope.recipient !== expect.self) return { ok: false, reason: "wrong_recipient" };
  if (expect.expectedSender !== undefined && envelope.sender !== expect.expectedSender)
    return { ok: false, reason: "wrong_sender" };
  const now = expect.now ?? Date.now();
  if (Math.abs(now - envelope.ts) > FEDERATION_MESSAGE_KINDS[envelope.kind].maxSkewMs)
    return { ok: false, reason: "stale" };
  if ((await federationBodyDigest(expect.body)) !== envelope.body_sha256)
    return { ok: false, reason: "body_mismatch" };
  let ok = false;
  try {
    ok = await verifyBySuite(
      FEDERATION_MESSAGE_SUITE,
      federationMessageBytes(envelope),
      hexToBytes(signature),
      hexToBytes(expect.senderPublicKeyHex),
    );
  } catch {
    ok = false;
  }
  return ok ? { ok: true, envelope } : { ok: false, reason: "bad_signature" };
}

/**
 * Read a wire value as a v2 message, keeping exactly the eight envelope fields (so
 * an extra field can never ride along unsigned), or null when it is not one.
 * Exposed so a verifier can read `envelope.sender` to look up the sender's key
 * BEFORE calling `verifyFederationMessage`.
 */
export function parseFederationMessage(message: unknown): SignedFederationMessage | null {
  if (message === null || typeof message !== "object") return null;
  const m = message as { envelope?: unknown; signature?: unknown };
  if (typeof m.signature !== "string" || !HEX_SIG.test(m.signature)) return null;
  const e = m.envelope as Record<string, unknown> | null | undefined;
  if (e === null || typeof e !== "object") return null;
  const { kind, sender, recipient, recipient_public_key, ts, nonce, body_sha256, suite } = e;
  if (
    typeof kind !== "string" ||
    typeof sender !== "string" ||
    sender === "" ||
    typeof recipient !== "string" ||
    recipient === "" ||
    typeof recipient_public_key !== "string" ||
    !HEX64.test(recipient_public_key) ||
    typeof ts !== "number" ||
    !Number.isSafeInteger(ts) ||
    typeof nonce !== "string" ||
    !HEX64.test(nonce) ||
    typeof body_sha256 !== "string" ||
    !HEX64.test(body_sha256) ||
    typeof suite !== "string" ||
    Object.keys(e).length !== 8
  )
    return null;
  return {
    envelope: {
      kind: kind as FederationMessageKind,
      sender,
      recipient,
      recipient_public_key,
      ts,
      nonce,
      body_sha256,
      suite: suite as typeof FEDERATION_MESSAGE_SUITE,
    },
    signature: m.signature.toLowerCase(),
  };
}
