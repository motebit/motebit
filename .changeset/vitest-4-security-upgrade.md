---
"motebit": patch
"create-motebit": patch
"@motebit/protocol": patch
"@motebit/sdk": patch
"@motebit/crypto": patch
"@motebit/crypto-android-keystore": patch
"@motebit/crypto-appattest": patch
"@motebit/crypto-tpm": patch
"@motebit/crypto-webauthn": patch
"@motebit/state-export-client": patch
"@motebit/verifier": patch
"@motebit/verify": patch
---

Upgrade the test runner from vitest 2.1.9 to 4.1.8 (with @vitest/coverage-v8), closing critical advisory GHSA-5xrq-8626-4rwp (Vitest UI server arbitrary file read/execute, fixed in 4.1.0). This is a dev-dependency change only — no runtime, API, or wire-format change to any published package; the bump is recorded as a patch because each package's published `package.json` devDependencies move to vitest ^4.1.8.

vitest 4 bundles vite (^6 || ^7 || ^8), so the existing vite-^6 surfaces, jsdom 25, and @types/node ^22 are unchanged. Test-only migration fallout was handled in the same change: `ViteUserConfig` rename in the shared config, typed-mock assignability under v4 (`vi.fn()` now `Mock<Procedure|Constructable>`), constructor mocks converted from arrows to `function` (v4 disallows `new` on arrow mock implementations), the removed `environmentMatchGlobs` replaced by the per-file `@vitest-environment` directive, and an explicit `dist/` test-exclude restored for the one config-less package (vitest 4's default `exclude` no longer covers `dist/`).
