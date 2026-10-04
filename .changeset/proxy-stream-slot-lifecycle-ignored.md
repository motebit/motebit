---
"@motebit/proxy": patch
---

Settle the motebit-cloud stream's spend accounting on every exit, and before the relay debit.

A client that aborted mid-stream errored the response's writable side, so the pump's `finally` threw at `writer.close()` and skipped `record`, `release` and the relay debit: the concurrency slot leaked until its 5-minute TTL (three aborted streams locked a paying identity out) and the spend was never counted. The abort now ends the pump cleanly and the accounting always runs. The local spend record and the slot release also run before the relay debit, so a slow relay or debit retry backoff no longer holds a slot or hides the spend from the identity's next request.
