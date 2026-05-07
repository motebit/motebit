---
"@motebit/protocol": patch
---

Break init-order cycle in `sensitivity.ts` so the bundled dist boots.

Switched the `SensitivityLevel` import to `import type` and replaced
enum-member computed keys (`[SensitivityLevel.None]`) with the
string-literal keys the enum's runtime values evaluate to (`none`).

The bundled tsup output evaluates modules in linear order — `sensitivity.ts`
initializes its `SENSITIVITY_RANK` record before `index.ts` assigns the
enum's runtime values, so `[SensitivityLevel.None]: 0` crashed on first
access ("Cannot read properties of undefined (reading 'None')"). vitest
masked this with live TS bindings; the dist-smoke gate caught it on the
companion minor's push attempt.

No public-API change: the `Record<SensitivityLevel, number>` type still
binds keys to the enum at the type layer, so a future tier rename
remains a single-file edit at the enum site. Pairs with the same-PR
`feat(protocol): sensitivity ladder algebra` minor.
