---
---

No release. The 11 published packages now type-check their tests: each gains a `tsconfig.test.json` (extends the build tsconfig, `rootDir: "."`, `noEmit`, same strictness) that its `typecheck` script also compiles, while the build tsconfig keeps excluding `src/__tests__` so nothing new ships in `dist/`. Only test files and tsconfig/typecheck wiring change; no published source or declaration output changes (#1000).
