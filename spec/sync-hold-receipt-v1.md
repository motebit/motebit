# motebit/sync-hold-receipt@1.0

## Sync Hold Receipt Specification

**Status:** Draft
**Version:** 1.0
**Date:** 2026-10-05

Transport: [`memory-delta-v1.md`](memory-delta-v1.md) §3.6. Receipt family: [`docs/doctrine/receipts-unified.md`](../docs/doctrine/receipts-unified.md). JSON Schema: [`spec/schemas/sync-hold-receipt-v1.json`](schemas/sync-hold-receipt-v1.json).

## 1. Scope

A `SyncHoldReceipt` is a relay's signed record of which synced events it stores for one identity. A device may delete (compact) local events that a relay holds. Before this receipt, a device learned that a relay held an event from the transport alone: an HTTP 2xx for a push, a socket `ack` frame, or an event served on a pull page. A server that answers the relay's URL could therefore make a device delete events that the relay never stored. This receipt replaces that inference with a signature under the relay's identity key.

### The boundary (load-bearing)

Subject **=** signer: the relay records its **own** act of holding, so the receipt is in the receipt family, not an attestation.

The receipt lists event ids, never a clock. Each device assigns its own clocks, so no single clock value can say what a relay holds.

The receipt is evidence for one decision only: whether a device may treat an event as held by that relay. It authorizes nothing else.

### Rollout

This version is Draft and additive. Rollout has three increments:

1. **Inc 1 (this document):** a conforming relay signs and attaches the receipt. Clients do not read it, and nothing they read changes.
2. **Inc 2:** a client sends a nonce on every push and pull and verifies the receipt against the relay's pinned key. It counts an event as held only on a verified receipt.
3. **Inc 3:** the relay pin is unified across surfaces, and the legacy unsigned acknowledgment is bounded.

## 2. Wire format

### 2.1 — SyncHoldReceipt

#### Wire format (foundation law)

The `SyncHoldReceipt` type is exported from `@motebit/protocol` (`sync-hold-receipt.ts`).

Required fields:

- `spec`: the literal `"motebit/sync-hold-receipt@1.0"`. It separates this artifact from every other signed artifact.
- `relay_motebit_id`: the relay's id.
- `relay_public_key`: the relay's Ed25519 public key, lowercase hex, 64 characters.
- `motebit_id`: the identity whose events are held.
- `issued_at`: signing time, epoch milliseconds.
- `events`: a list of `SyncHeldEvent`, in request order, with no repeated `event_id`.
- `suite`: the literal `"motebit-jcs-ed25519-b64-v1"`.
- `signature`: see §3.

Optional fields:

- `nonce`: the client's request nonce, echoed exactly. It is absent when the request carried none, or carried one the relay could not use (§4.1).
- `page`: a `SyncHoldPage`. It is present on a pull-page receipt and absent on a push receipt.

JCS discipline: an optional field is ABSENT, never `null`.

### 2.2 — SyncHeldEvent

#### Wire format (foundation law)

The `SyncHeldEvent` type is exported from `@motebit/protocol`.

- `event_id` (required): the id of an event that the relay stores for `motebit_id`.
- `digest` (required): lowercase hex SHA-256 of the JCS-canonical event entry, exactly as the relay would serve it on a pull, without `seq`. "As served" means the stored row, projected as the pull projects it, after the relay's egress redaction.
- `redacted` (required): `true` when the held entry is in redacted form. The relay redacted it on ingress or egress, or the stored payload carries the redaction marker. The digest of a redacted entry cannot match the client's original bytes.
- `seq` (optional): the event's relay ingest sequence. It is present on pull-page receipts only.

### 2.3 — SyncHoldPage

#### Wire format (foundation law)

The `SyncHoldPage` type is exported from `@motebit/protocol`. Its fields are the pull page's own cursor fields (memory-delta-v1 §3.6), copied verbatim: `after_seq`, `next_seq`, `has_more` and `latest_seq`. All four are required.

## 3. Signing

`signature` is Ed25519 over the UTF-8 bytes of `canonicalJson(receipt without signature)` (RFC 8785 JCS), encoded as base64url. It is computed through suite dispatch (`signSyncHoldReceipt` in `@motebit/crypto`). The relay signs with its identity key, which is the key it publishes at `/federation/v1/identity` and in `/.well-known/motebit-transparency.json`.

## 4. Production (relay)

### 4.1 Nonce

A client MAY send a nonce:

- in the `nonce` field of the `POST /sync/:motebitId/push` body;
- in the `nonce` field of a socket `push` frame;
- as the `nonce` query parameter of `GET /sync/:motebitId/pull?after_seq=…`.

A nonce MUST carry at least 128 bits of randomness, chosen fresh for each request. A process counter is not a nonce: socket `push_id` values restart at `"1"` in each client process, and an HTTP push has no id at all.

The relay accepts a nonce of 22 to 128 characters from the base64url alphabet (`A–Z a–z 0–9 _ -`), which covers hex. It echoes an accepted nonce exactly. A request with no nonce, or with one the relay does not accept, is served exactly as before, and its receipt carries no `nonce`. The relay never refuses a request because of its nonce.

### 4.2 Push receipts

A relay that answers a push (an HTTP push response, or a socket `ack` frame) attaches a receipt in the additive field `hold_receipt`. Every other field of the response is unchanged.

The receipt lists the event ids of the push that the relay **stores** for the bound identity, read back after the writes. It never copies the frame. Both push routes acknowledge entries they did not write:

- a receipt duplicate (an entry whose `payload.receipt.signature` the relay already stores under another event id);
- an entry refused by the identity binding;
- an entry the store drops (`INSERT OR IGNORE` on a malformed row, or an `event_id` already held under another identity).

None of these appears in the receipt unless the relay genuinely holds that `event_id` for `motebit_id`.

`INSERT OR IGNORE` keeps the first write of an id. If the relay already held an earlier version of an id (for example, older end-to-end ciphertext), the receipt lists the id, and its digest describes the stored bytes, not the bytes just pushed.

### 4.3 Pull-page receipts

A relay that serves `GET /sync/:motebitId/pull?after_seq=…` attaches a receipt in the additive field `hold_receipt`. The receipt:

- lists every event on the page, with its `seq`, in page order;
- carries `page`, copied from the page;
- is read from the same snapshot as the page.

Because the signature covers the seq range and the request nonce, a page cannot be replayed as the answer to a different cursor or request.

A pull without `after_seq` (the clock path) carries no receipt. A client MUST NOT count an event served on the clock path as held under this specification.

## 5. Verification law

`verifySyncHoldReceipt(receipt, { expectedPublicKey?, expectedNonce? })` in `@motebit/crypto` is fail-closed. It rejects a receipt, with a typed reason, when:

- `suite` or `spec` is unknown (`unsupported_suite`, `unsupported_spec`);
- the shape is malformed (`malformed_receipt`);
- the events are inconsistent with `page` (`page_mismatch`):
  - with `page`, every event carries a `seq`, strictly increasing, in `(after_seq, next_seq]`, and the last `seq` equals `next_seq`; an empty page has `next_seq = after_seq`;
  - without `page`, no event carries a `seq`;
- the key does not equal the pinned key (`public_key_mismatch`);
- the nonce does not equal the expected nonce (`nonce_mismatch`);
- the key or signature is malformed (`malformed_public_key`, `malformed_signature`);
- the signature does not verify (`signature_invalid`).

What verification does NOT establish:

- **That the key is the relay's.** A receipt carries its own key, so verification without `expectedPublicKey` proves only self-consistency. A client MUST pin the relay key.
- **Freshness.** A receipt without a nonce answers no particular request, and a client MUST NOT credit it.
- **Durability.** A relay may later delete events under its retention policy. The receipt records what the relay held when it signed.

## 6. Consumer obligations (Inc 2, normative when this document is Stable)

A conforming client:

1. sends a fresh nonce on every push and seq pull;
2. verifies each receipt with `expectedPublicKey` set to the relay key it pins and `expectedNonce` set to the nonce it sent;
3. treats an event as held by that relay only when a verified receipt lists its `event_id` with:
   - a `digest` equal to the digest of the entry it holds; or
   - `redacted: true`, where the redacted form is the expected outcome for that entry;
4. never treats as held an event that is merely acknowledged by the transport (a 2xx, an `ack` frame) or served on a clock-path pull.

## 7. Change log

| Version | Date       | Change                                                                                                                                                |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-10-05 | Initial Draft. The relay signs a per-id hold receipt on HTTP push, socket `ack` and seq pull pages, as an additive field; clients do not read it yet. |
