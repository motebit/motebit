---
"@motebit/crypto": patch
---

Make `@motebit/protocol` a required (non-optional) peer dependency. The published type declarations import `@motebit/protocol`, but npm never installs an optional peer, so a plain `npm i @motebit/crypto` failed to type-check under `skipLibCheck: false` (TS2307). npm ≥ 7 and pnpm now install `@motebit/protocol` automatically, so a standalone TypeScript install type-checks. The runtime stays zero-dependency — the protocol import is type-only.
