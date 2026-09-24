---
"@motebit/crypto": patch
---

`verifyHostEnrollment` / `verifyHostRetirement`: the body verifier no longer carries an unreachable key-shape guard — the shape guards that gate every call already hold `public_key` to 64 lowercase hex. Behavior unchanged (#696).
