import { defineConfig, loadEnv } from "vite";
import { enforcePublicBuildEnv } from "../../scripts/lib/client-bundle-secrets";

// A provider credential never reaches a browser: refuse to build (or serve)
// when the build env carries any public var not named in PUBLIC_BUILD_ENV.verify,
// or a named one whose value fails its validator (deny by default). Pinned by
// execution: scripts/__tests__/check-no-secrets-in-client-bundles.test.ts runs
// the real `vite build` with a planted var. Law + rationale:
// scripts/lib/client-bundle-secrets.ts (incident 2026-09-30).
export default defineConfig(({ mode }) => {
  enforcePublicBuildEnv("verify", process.env, () => loadEnv(mode, process.cwd(), ""));
  return {
    server: {
      port: 5176,
    },
  };
});
