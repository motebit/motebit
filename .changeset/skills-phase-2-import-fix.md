---
"motebit": patch
---

Replace inline `require("node:os")` with a top-of-file `import * as os from "node:os"` in `runtime-factory.ts`. Pre-push lint surfaced four errors (`no-require-imports` + `no-unsafe-*`) on the CommonJS-style require — ESM imports keep the type info and pass the published-package-source eslint preset.
