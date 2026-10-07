---
"@motebit/mcp-server": patch
---

A caller's rotated-away key no longer authenticates. `wireServerDeps`'s `resolveCallerKey` now checks the relay's identity bundle even when the local trust store holds a key for the caller: if the relay serves a different current key, the stored (retired) key is refused and the successor accepted. Earned trust carries over only across a succession signed by the retired key (or guardian); an unproven key change authenticates at most as `Verified`; `Blocked` stays blocked. Served identities are cached for 30s.
