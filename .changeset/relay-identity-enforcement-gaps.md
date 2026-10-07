---
"@motebit/relay": patch
---

Two identity enforcement gaps closed at the relay. A federation peer id stays bound to the key it peered under: `/federation/v1/peer/propose` refuses (409) a re-proposal under a different key for a known id in any state, and a failed confirm of an established peer's re-proposal parks the row `removed` instead of deleting it (which freed the id for a fresh takeover). `/credentials/submit` admits a `hardware_attestation` claim only when it equals a claim the subject attached to its own device record (a request signed under that device's key), and a `secure_enclave` receipt must verify against that device's key.
