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

- `nonce` (required): the client's request nonce, echoed exactly. A relay issues a receipt only to a request carrying a nonce it accepts (§4.1), so every receipt carries one.
- `page`: a `SyncHoldPage`. It is present on a pull-page receipt and absent on a push receipt.

JCS discipline: an optional field is ABSENT, never `null`.

### 2.2 — SyncHeldEvent

#### Wire format (foundation law)

The `SyncHeldEvent` type is exported from `@motebit/protocol`.

- `event_id` (required): the id of an event that the relay stores for `motebit_id`.
- `digest` (required): lowercase hex SHA-256 of the JCS-canonical event entry, exactly as the relay would serve it on a pull, without `seq`. "As served" means the stored row, projected as the pull projects it, after the relay's egress redaction.
- `redacted` (required): `true` when the held entry is in redacted form. The relay redacted it on ingress or egress, or the stored payload carries the redaction marker. The digest of a redacted entry cannot match the client's original bytes. The flag is a property of the stored row, never of the request being answered (§4.4).
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

The relay accepts a nonce of 22 to 128 characters from the base64url alphabet (`A–Z a–z 0–9 _ -`), which covers hex. It echoes an accepted nonce exactly.

A receipt is issued **only** to a request carrying an accepted nonce. A request with no nonce, or with one the relay does not accept, gets no `hold_receipt` and is served exactly as before. The relay MUST NOT do any receipt work for it: no readback, no digest, no signature. A receipt without the client's nonce would answer no request, and a client could not credit it (§5), so producing one would only cost every client that does not yet read receipts. The relay never refuses a request because of its nonce.

### 4.2 Push receipts

A relay that answers a push carrying an accepted nonce (an HTTP push response, or a socket `ack` frame) attaches a receipt in the additive field `hold_receipt`. Every other field of the response is unchanged.

The receipt lists the event ids of the push that the relay **stores** for the bound identity, read back after the writes. It never copies the frame. Both push routes acknowledge entries they did not write:

- a receipt duplicate (an entry whose `payload.receipt.signature` the relay already stores under another event id);
- an entry refused by the identity binding;
- an entry the store drops (`INSERT OR IGNORE` on a malformed row, or an `event_id` already held under another identity).

None of these appears in the receipt unless the relay genuinely holds that `event_id` for `motebit_id`.

`INSERT OR IGNORE` keeps the first write of an id. If the relay already held an earlier version of an id (for example, older end-to-end ciphertext, or the same memory at an earlier sensitivity), the receipt lists the id, and its digest and `redacted` flag describe the stored row, not the bytes just pushed.

### 4.3 Pull-page receipts

A relay that serves `GET /sync/:motebitId/pull?after_seq=…&nonce=…` with an accepted nonce attaches a receipt in the additive field `hold_receipt`. The receipt:

- lists every event on the page, with its `seq`, in page order;
- carries `page`, copied from the page;
- is read from the same snapshot as the page.

Because the signature covers the seq range and the request nonce, a page cannot be replayed as the answer to a different cursor or request.

A pull without `after_seq` (the clock path) carries no receipt. A client MUST NOT count an event served on the clock path as held under this specification.

A page receipt MAY list a subset of the page: an event of unknown redaction status (§4.5) is served on the page and left out of its receipt. The last listed `seq` may then be below `next_seq`.

### 4.4 The `redacted` flag is decided at write time

Every door computes `digest` and `redacted` with one rule, from the stored row alone, so a push receipt and a pull receipt for the same row always agree.

Most ingress redactions leave the marker `redacted: true` in the stored payload. One does not: stripping the owner-local `mutation_manifest` from a `consolidation_receipt_signed` payload leaves no trace in the bytes. A conforming relay therefore records, in the same write that stores an entry, whether its ingress redaction changed that entry. A later write of the same id that the store ignores does not change the record.

A held entry is `redacted: true` when any of these holds:

- egress redaction changes the stored entry;
- the stored payload carries `redacted: true`;
- the relay recorded at write time that ingress redaction changed it.

Otherwise it is `redacted: false`, subject to §4.5.

### 4.5 Unknown status

A row stored before the relay recorded the write-time fact has an unknown status when its bytes cannot decide it: its type is one whose ingress redaction leaves no marker, and the stored payload carries no marker. The relay MUST NOT list such an event in any receipt. It never signs `redacted: false` for an entry it may have redacted. A client cannot credit an omitted event, so it never compacts one on a false "unredacted".

Rows of every other type are decided by their bytes, whenever they were stored.

### 4.6 Best effort

The receipt is decoration on a response that existing clients already read. A failure in producing it (reading back the held rows, digesting, or signing) MUST NOT change that response. The relay serves the response exactly as it would without this specification, omits `hold_receipt`, and records the failure in its logs without payload content.

## 5. Verification law

`verifySyncHoldReceipt(receipt, { expectedPublicKey, expectedNonce, expectedMotebitId })` in `@motebit/crypto` is fail-closed. All three expectations are REQUIRED: there is no unpinned mode. It rejects a receipt, with a typed reason, when:

- an expectation is missing, empty or not a string (`missing_expectation`);
- `suite` or `spec` is unknown (`unsupported_suite`, `unsupported_spec`);
- the shape is malformed, including a receipt with no `nonce` (`malformed_receipt`);
- the events are inconsistent with `page` (`page_mismatch`):
  - with `page`, every event carries a `seq`, strictly increasing, in `(after_seq, next_seq]`, and `next_seq ≥ after_seq`; the events may be a subset of the page (§4.3);
  - without `page`, no event carries a `seq`;
- `motebit_id` does not equal the expected motebit (`motebit_id_mismatch`);
- the key does not equal the pinned key (`public_key_mismatch`);
- the nonce does not equal the expected nonce (`nonce_mismatch`);
- the key or signature is malformed (`malformed_public_key`, `malformed_signature`);
- the signature does not verify (`signature_invalid`).

Why each expectation is required:

- **The key.** A receipt carries its own key, so a check against the embedded key would accept any attacker's self-consistent receipt. The caller pins the relay key.
- **The nonce.** A receipt answers the request whose nonce it echoes, and no other. A receipt without one is malformed.
- **The motebit.** A receipt for another identity describes another identity's events.

What verification does NOT establish:

- **Durability.** A relay may later delete events under its retention policy. The receipt records what the relay held when it signed.

## 6. Consumer obligations (Inc 2, normative when this document is Stable)

A conforming client:

1. sends a fresh nonce on every push and seq pull;
2. verifies each receipt with `expectedPublicKey` set to the relay key it pins, `expectedNonce` set to the nonce it sent and `expectedMotebitId` set to the identity it pushed or pulled for;
3. treats an event as held by that relay only when a verified receipt lists its `event_id` with:
   - a `digest` equal to the digest of the entry it holds; or
   - `redacted: true`, where the redacted form is the expected outcome for that entry;
4. never treats as held an event that is merely acknowledged by the transport (a 2xx, an `ack` frame) or served on a clock-path pull.

## 7. Change log

| Version | Date       | Change                                                                                                                                                                                                                                                                  |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-10-05 | Initial Draft. The relay signs a per-id hold receipt on HTTP push, socket `ack` and seq pull pages, as an additive field; clients do not read it yet.                                                                                                                   |
| 1.0     | 2026-10-05 | Draft revision: `redacted` is decided at write time and read from the stored row by every door (§4.4); events of unknown status are omitted, so a page receipt may list a subset of its page (§4.5, §5); receipt production is best effort (§4.6).                      |
| 1.0     | 2026-10-05 | Draft revision: a receipt is issued only to a request carrying an accepted nonce, and a nonce-less request costs the relay no receipt work (§4.1); `nonce` is required (§2.1); verification requires the pinned key, the sent nonce and the expected `motebit_id` (§5). |
