---
"@motebit/protocol": minor
---

Declare `redacted_reason?: "deleted"` on `MemoryFormedPayload` — close the wire-contract gap on the deletion tombstone.

The deletion-propagation arc (`a0fb79ce`) made user-initiated forget reach the relay: when a `memory_deleted` syncs, a conforming store rewrites the matching `memory_formed` payload in place, blanking `content` to the `"[REDACTED]"` sentinel and stamping `redacted_reason: "deleted"`. That field is already written by every producer (`EventStoreAdapter.redactMemoryContent` in event-log + persistence, the relay `deletion-propagation.ts`, and the relay backfill migration) and is _load-bearing_ — `event-log/index.ts` and `persistence/index.ts` both read `payload.redacted_reason === "deleted"` to keep the rewrite idempotent. But it was declared nowhere in the wire contract: not on `MemoryFormedPayload`, not in `MemoryFormedPayloadSchema`, not in `spec/memory-delta-v1.md`. The `.passthrough()` envelope kept it from failing validation, so the drift was silent — exactly the spec-vs-code divergence the synchronization-invariants principle forbids.

`redacted_reason` is the sole discriminator between the two mechanisms that both blank `content`: sync-forwarder **sensitivity** redaction (`redacted: true` + `redacted_sensitivity`, original re-requestable from the emitter) versus a **deletion tombstone** (content terminally erased; a conforming consumer MUST NOT re-form a node from it). A third party implementing `memory-delta` from the schema could not previously tell "stripped, recoverable" from "erased, terminal".

Additive and replay-compatible: optional literal, absent ⇒ sensitivity redaction or no redaction; 1.0–1.3 logs replay identically. Lands the protocol type, the zod schema (`@motebit/wire-schemas`, regenerated `spec/schemas/memory-formed-payload-v1.json`), and `spec/memory-delta-v1.md` (§5.1 field + new §6.1 deletion-tombstone section + version-history 1.4; the stale `**Version:** 1.2` header is corrected to 1.4 in the same pass).
