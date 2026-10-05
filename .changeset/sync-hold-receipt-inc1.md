---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Add `SyncHoldReceipt` (spec `motebit/sync-hold-receipt@1.0`, Draft): a relay-signed, receipt-family record of which synced event ids the relay stores for an identity. Each entry is `{ event_id, digest, redacted, seq? }`. The receipt echoes the client's request nonce, and on a pull page it covers the page's seq range (`page`).

- `@motebit/protocol`: `SyncHoldReceipt`, `SyncHeldEvent`, `SyncHoldPage`, `SYNC_HOLD_RECEIPT_SPEC_ID`.
- `@motebit/crypto`: `signSyncHoldReceipt`, `verifySyncHoldReceipt` (fail-closed, typed reasons; optional `expectedPublicKey` pin and `expectedNonce` echo check), `computeSyncEventDigest`, `SYNC_HOLD_RECEIPT_SUITE`, `SYNC_HOLD_RECEIPT_SPEC_MIRROR`.

Additive only. No existing type or verifier changes.
