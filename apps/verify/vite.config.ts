import { defineConfig } from "vite";
import { publicBuildEnvGuard } from "../../scripts/lib/client-bundle-secrets";

// A provider credential never reaches a browser: the guard plugin judges the
// env Vite itself resolved (whatever root/envDir/mode the build was invoked
// with) and refuses to build (or serve) on any var not named in
// PUBLIC_BUILD_ENV.verify, or a named one whose value fails its validator
// (deny by default); it re-checks the emitted chunks too. Pinned by execution:
// scripts/__tests__/check-no-secrets-in-client-bundles.test.ts runs the real
// `vite build` with planted vars. Law + rationale:
// scripts/lib/client-bundle-secrets.ts (incident 2026-09-30).
export default defineConfig({
  plugins: [publicBuildEnvGuard("verify")],
  server: {
    port: 5176,
  },
});
