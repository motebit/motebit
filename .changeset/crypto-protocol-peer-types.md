---
"@motebit/crypto": patch
---

Declare `@motebit/protocol` as an optional peer dependency. The published type declarations import `@motebit/protocol` (19 `.d.ts` files), but the manifest declared nothing, so a standalone TypeScript consumer with `skipLibCheck: false` failed with `TS2307: Cannot find module '@motebit/protocol'`. The peer is optional and type-only: `dependencies` stays empty, nothing is auto-installed, and runtime behaviour is unchanged. TypeScript consumers that type-check libraries install `@motebit/protocol` alongside. `lint:pack` now packs the package, installs it into a scratch consumer with only its declared dependencies, and type-checks it with `skipLibCheck: false`.
