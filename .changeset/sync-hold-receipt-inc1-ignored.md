---
"@motebit/relay": patch
"@motebit/wire-schemas": patch
---

The relay signs what it holds (sync hold receipt, Inc 1 of 3). `POST /sync/:id/push`, the socket `ack`, and `GET /sync/:id/pull?after_seq=` now carry an additive `hold_receipt` (`SyncHoldReceipt`, signed with the relay identity key). It lists the event ids the relay actually stores for the bound identity, read back after the write and never copied from the frame. Each id has a digest of the entry as served and a `redacted` flag. Pull pages also sign their seq range. An optional client `nonce` (body field, frame field, or query parameter; 22–128 base64url characters) is echoed exactly. Without one, the receipt carries no nonce. Every field an existing client reads is unchanged, and the clock-path pull is untouched. `@motebit/wire-schemas`: `SyncHoldReceiptSchema` and the committed `spec/schemas/sync-hold-receipt-v1.json`.
