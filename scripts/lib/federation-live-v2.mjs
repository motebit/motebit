/**
 * The relay-federation@1.5 §3.5 v2 signer the live federation test
 * (`scripts/test-federation-live.mjs`) sends with, kept dependency-free (the
 * live test runs against deployed relays and must self-bootstrap with Node
 * alone). Split out of the script so the relay suite can drive it against a
 * real relay (`services/relay/src/__tests__/federation-live-signer.test.ts`):
 * a drift between this mirror and the relay's verifier goes red in CI, not
 * on the next staging run.
 */
import * as crypto from "node:crypto";

// MIRROR: keep in sync with `packages/encryption/src/canonical.ts::canonicalJson`.
// Inline duplicate because the live test is pure-Node (no workspace deps).
// Drift between this and the production version manifests as wire-format
// incompatibility (the relay rebuilds canonical bytes and the signature or
// body digest does not match); `federation-live-signer.test.ts` and the live
// test's Phase 6.1 both surface it. On any change to canonical.ts, audit this
// function as a sibling-boundary touchpoint.
//
// JCS-style canonical JSON (sorted keys, no whitespace, undefined-omission).
export function canonicalJson(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map((i) => canonicalJson(i)).join(",") + "]";
  const sorted = Object.keys(obj).sort();
  const entries = [];
  for (const key of sorted) {
    const val = obj[key];
    if (val === undefined) continue;
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}

// MIRROR: keep in sync with `packages/crypto/src/federation-message.ts`
// (`signFederationMessage`) — relay-federation@1.5 §3.5. Signed bytes are
// "motebit-fed/v2\0" ‖ kind ‖ "\0" ‖ JCS(envelope); body_sha256 is the hex
// SHA-256 of JCS(body).
export function signFederationV2({
  kind,
  sender,
  recipient,
  recipientPublicKey,
  body,
  privKeyObj,
  ts,
}) {
  const envelope = {
    kind,
    sender,
    recipient,
    // The recipient by KEY as well as id (§3.5): relay ids are not
    // self-certifying, and the recipient checks this against its own key.
    recipient_public_key: recipientPublicKey.toLowerCase(),
    ts: ts ?? Date.now(),
    nonce: crypto.randomBytes(32).toString("hex"),
    body_sha256: crypto.createHash("sha256").update(canonicalJson(body)).digest("hex"),
    suite: "motebit-jcs-ed25519-hex-v1",
  };
  const bytes = Buffer.from(`motebit-fed/v2\0${kind}\0${canonicalJson(envelope)}`);
  return {
    envelope,
    signature: Buffer.from(crypto.sign(null, bytes, privKeyObj)).toString("hex"),
  };
}

/**
 * A direct `/federation/v1/discover` request from `sender` (a peer of the
 * recipient) for `capability`: the discover fields plus `message`, a v2
 * `discover` message for ONE recipient by id and by key (§3.5, §4.1.1). The
 * body digest covers every field sent beside `message`; the relay refuses a
 * request without `message` (v1) by name.
 */
export function directDiscoverRequest({ sender, recipient, capability, queryId, privKeyObj }) {
  const body = {
    query: { capability, limit: 10 },
    hop_count: 0,
    max_hops: 1,
    visited: [sender],
    query_id: queryId,
    origin_relay: sender,
    sender_relay: sender,
  };
  const message = signFederationV2({
    kind: "discover",
    sender,
    recipient: recipient.relayMotebitId,
    recipientPublicKey: recipient.publicKey,
    body,
    privKeyObj,
  });
  return { ...body, message };
}
