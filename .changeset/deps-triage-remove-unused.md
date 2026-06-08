---
"@motebit/crypto-android-keystore": patch
---

Remove the redundant direct `@peculiar/asn1-schema` dependency — it resolves transitively through `@peculiar/x509`, which the verifier actually imports. No runtime or API change (lighter manifest only).
