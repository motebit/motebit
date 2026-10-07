---
"@motebit/relay": patch
---

Two identity enforcement gaps closed at the relay. A federation peer id stays bound to the key it peered under: `/federation/v1/peer/propose` refuses (409) a re-proposal under a different key for a known id in any state, and a re-proposal for a known id (a peer that once peered: `suspended`, `removed`) is held in `relay_peer_proposals` (10-minute TTL, at most 8 per id) instead of being written over the row — an unconfirmed proposal never changes the row's state, key, endpoint or trust (a stranger can no longer park a peer in `pending` by re-proposing it under its own public key), and only a confirm signed by the stored key applies one; a failed or expired confirm leaves the row exactly as it was. `/credentials/submit` admits a `hardware_attestation` claim only when it equals a claim the subject attached to its own device record (a request signed under that device's key), and a `secure_enclave` receipt must verify against that device's key.
