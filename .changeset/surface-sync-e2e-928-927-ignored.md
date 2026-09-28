---
"@motebit/sync-engine": minor
"@motebit/mobile": patch
"@motebit/desktop": patch
"@motebit/web": patch
"@motebit/spatial": patch
---

No plaintext event push from a surface that holds the sync key (#928), and a socket catch-up that neither goes stale nor fails silently (#927). This is the ignored-package half; the published `motebit` half is in the sibling changeset.

- `@motebit/sync-engine`:
  - `classifyEventPayload` → `e2e | plaintext | malformed`, the one predicate every reader uses. `isEncryptedPayload` now lives beside it. The decrypting adapter used to decrypt any truthy `_encrypted`, while the seq pull applied everything except `_encrypted === true` as plaintext. A payload that carries the marker but is not the envelope is now refused by every decrypt path and never applied by a raw pull.
  - The envelope must be EXACTLY `{_encrypted: true, _data}` with no other key. `_data` must parse to exactly `{c, n, t[, v]}`: strict base64, a 12-byte nonce and a 16-byte tag (AES-256-GCM as `@motebit/encryption`'s `encrypt` emits it), a non-empty ciphertext, and `v` a positive integer. Checking only `_encrypted === true` and a string `_data` let `{_encrypted:true,_data:"{}",content:"…"}` and `{_encrypted:true,_data:"<plaintext>"}` through an e2e transport. The encrypting adapter now writes and reads `_data` through the same codec (`encodeEnvelopeData` / `parseEnvelopeData`), so the producer and the predicate cannot drift.
  - `HttpEventStoreAdapter` and `WebSocketEventStoreAdapter` take `payloads: "e2e" | "raw"`, default `raw`. In `e2e` mode a payload that is not an E2E envelope is refused (`PlaintextPushRefusedError`) before it is sent or queued.
  - `HttpEventStoreAdapter`: with a `credentialSource`, a 401 or 403 makes it ask the source once more and retry. A second refusal is thrown.
  - `WebSocketEventStoreAdapter` takes `onCatchUpError`. A failed catch-up is reported through it, or with a `console.warn` line by default, and is never swallowed.
  - A `credentialSource` that rejects at connect was an unhandled rejection that left the socket unconnected with no reconnect scheduled. It is now reported through `onCatchUpError` and a reconnect is scheduled on the usual backoff.
- `@motebit/mobile`: `syncNow` pushed events through a bare `HttpEventStoreAdapter`, so the relay stored plaintext payloads. It now uses the same E2E transport as the sync cycle, and derives the key when sync has not started. The cycle's raw fallback for a missing key is removed, so a missing key makes the cycle fail instead of pushing plaintext. The transport resolves a fresh token per request and runs in `e2e` mode. A failed catch-up sets the status to `error`.
- `@motebit/desktop`: `/sync` (`syncConversations`) never received the sync key, so it picked the raw conversation and plan adapters, and message text, titles and plan steps went on the wire in plaintext. The controller now derives the key from the device keypair itself, as the sync cycle does. Without a keypair it refuses and sends nothing, so the raw adapters are unreachable. `syncConversations` now takes `invoke` and no longer takes a key.
- `@motebit/desktop`: the catch-up adapter held the first `sync` token for the session. The socket was refreshed every 4.5 minutes but the catch-up adapter was not, so after five minutes every catch-up was refused, the refusal was swallowed, and desktop stopped pulling. It now mints the token per request, runs in `e2e` mode, and puts a failed catch-up in the sync status.
- `@motebit/spatial`: same fixed-token capture as desktop in the catch-up, plan and conversation adapters. The plan and conversation engines poll on their own timers, so every poll after five minutes was refused. All three now resolve a fresh token per request. The transports run in `e2e` mode.
- `@motebit/web`: the transports run in `e2e` mode, and a failed catch-up is surfaced. Web already resolved its token per request.
