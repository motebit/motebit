---
"@motebit/crypto": minor
---

Add `./suite-dispatch` subpath export. Edge-neutral bundle exposing `verifyBySuite`, `signBySuite`, `ed25519Sign`, `ed25519Verify`, `generateEd25519Keypair`, and `getPublicKeyBySuite` without the YAML / did:key / credential / credential-anchor surface of the main entry — for Vercel Edge, Workers, and other runtimes where the full package exceeds the bundle budget. Closes the `services/proxy/src/validation.ts` `ed.verifyAsync` waiver; the proxy now routes through `verifyBySuite`.
