---
---

Key rotation reaches the relay. The route now answers to the `rotate-key` audience the spec names (it fell through to `admin:query`, so every signed client 401'd and no rotation was ever recorded); a recorded rotation moves the device rows that held the retired key, clears any pairing approval carrying it, and writes the registry key and the succession row in one transaction; and the CLI submits before committing local state, through a new shared `submitSuccessionToRelay` primitive in `@motebit/sync-engine`, so a failed submission leaves the old key working instead of stranding the identity between two keys.
