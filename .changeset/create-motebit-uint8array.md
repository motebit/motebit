---
"create-motebit": patch
---

Forward-compat crypto argument handling: WebCrypto calls (digest/importKey/encrypt/deriveBits) wrap their `Uint8Array` args in `new Uint8Array(...)` so they present an ArrayBuffer-backed `BufferSource`. Behavior-preserving (identical bytes); makes the scaffolding CLI compile cleanly under newer `@types/node` (the generic `Uint8Array<ArrayBufferLike>` change) while remaining valid on the current Node 22 runtime.
