---
"@motebit/verifier": patch
---

Make the default export browser-pure — `verifyArtifact` no longer transitively pulls in Node builtins.

`packages/verifier/src/lib.ts` imported `node:fs/promises` and `node:path` at module top, even though only the two disk-reading functions (`verifyFile`, `verifySkillDirectory`) use them. Because the imports were static, a browser bundler (Vite/esbuild) importing the package solely to call the browser-safe `verifyArtifact` dragged `node:fs/promises` into the module graph at eval time — contradicting the package's "browser-safe" promise and breaking first-contact for web consumers (e.g. a receipt-verifier ProofPanel). Surfaced by the third-party integrator DX audit: the documented `npm i @motebit/verifier` → `verifyArtifact` path would fail to bundle.

Both builtins are now dynamically imported inside `verifyFile` / `verifySkillDirectory`, evaluated only when the disk path runs (Node). Public API, types, and Node behavior are unchanged; `verifyArtifact` is now free of any static Node-builtin dependency. `@motebit/crypto` (zero deps) remains the cleanest browser base; this makes the wrapper match it.

Verified empirically: a Vite client build that imports the package and calls only `verifyArtifact` **fails** with the old static import (Rollup errors — the externalized `node:` stub exports no `readFile`) and **succeeds** with the dynamic import. A residual cosmetic "externalized for browser compatibility" warning remains because Vite still sees the literal `import("node:…")` specifier; the build succeeds and the branch never executes in the browser. The zero-warning form (a `node` export-condition / `@motebit/verifier/node` subpath that keeps `node:` out of the browser graph entirely) is deferred to a v2 packaging change.
