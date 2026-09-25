---
"@motebit/relay": patch
---

A retired key stops holding the sync sockets it admitted (#767). Rotation already rewrote the device rows holding the old key, so the old key could open no new socket, but a socket it had opened before the rotation stayed open: it kept receiving sync traffic and kept a machine-roster liveness row under a superseded key.

`applySuccession` now takes a required port that closes, after the rotation commits, every socket of the identity whose token verified under the retired key. The close uses the new close code `4010` ("Key rotated; re-authenticate"). The port is required, so every door that applies a succession must supply it: `/rotate-key` and the succession path of `/agents/register`. Pairing's `update-key`, which replaces a paired device's claiming key, uses the same port. Sockets admitted under a different key, such as a device linked without key transfer or a master-token socket, stay open. A rotation that lands while a socket's token is still being verified is caught at registration. The closed socket leaves through the normal close path, so the roster's `last_seen_at` is written.
