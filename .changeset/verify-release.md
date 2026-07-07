---
"motebit": minor
---

`motebit verify-release` — the self-signing body, self-verifying. Hashes the RUNNING bundle's own bytes and checks them against the relay's signed release witness (`/.well-known/motebit-releases.json` — the operator's signed observation of the npm registry: tarball integrity + per-file bundle hashes, in the same envelope and via the same canonical verifier as the transparency declaration, under the same key pinned at `motebit register`). Closes the one unverifiable claim the bundled-CLI distribution model leaves open: that the artifact npm delivered is the artifact the operator published. Read-only, passphrase-free by design (a binary asking you to unlock your identity to "verify itself" would be the attack). Stated honestly: this proves the operator's word about the artifact, not a reproducible build — that rung is a later arc.
