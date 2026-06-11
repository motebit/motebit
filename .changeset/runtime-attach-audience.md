---
"@motebit/protocol": minor
---

New `TokenAudience` registry entry: `runtime:attach` (+ `RUNTIME_ATTACH_AUDIENCE` constant). The device-key-signed attach handshake on the machine-local runtime-host socket — a frontend process authenticating to the machine's coordinator runtime, per the daemon–desktop unification doctrine (one sovereign runtime per machine, frontends attach). Verified exclusively by the local coordinator; the relay and every network verifier reject it by audience binding, so the token never authorizes anything beyond the machine boundary. Additive: existing audiences, verifiers, and wire formats are unchanged.
