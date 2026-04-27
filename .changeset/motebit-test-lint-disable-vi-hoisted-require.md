---
"motebit": patch
---

Internal-only: silence `@typescript-eslint/no-require-imports` on three
`require()` calls inside `vi.hoisted()` in
`src/__tests__/migrate-keyring.test.ts`. The pattern is idiomatic vitest
(vi.hoisted runs before ES module imports resolve, so `require()` is the
only way to reach Node built-ins from inside the hoisted block). Targeted
`eslint-disable-next-line` comments with an explanation; rule remains in
force on the rest of the file. No runtime behavior change; tests
unaffected.
