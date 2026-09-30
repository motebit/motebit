---
---

No release. The 11 published packages now type-check their tests: each gains a `tsconfig.test.json` (extends the build tsconfig, `rootDir: "."`, `noEmit`, same strictness) that its `typecheck` script also compiles, while the build tsconfig keeps excluding `src/__tests__` so nothing new ships in `dist/`. Only test files and tsconfig/typecheck wiring change; no published source or declaration output changes (#1000).

`@motebit/crypto` tests additionally cover both succession verification catch blocks (`verifyKeySuccession` and the identity-file succession chain), each reached by a record that omits `new_key_signature` and asserted to fail closed. Test-only; no source change.

The `@ts-expect-error` pins on the three `@motebit/crypto` type defects now cite their tracking issue, #1001. Test-only.
