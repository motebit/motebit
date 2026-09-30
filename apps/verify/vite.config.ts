import { defineConfig, loadEnv } from "vite";
import { assertPublicBuildEnv } from "../../scripts/lib/client-bundle-secrets";

// A provider credential never reaches a browser: refuse to build (or serve)
// when a resolved VITE_* value is credential-shaped, and the Solana RPC override
// may carry no query string or userinfo at all. Law + rationale:
// scripts/lib/client-bundle-secrets.ts (incident 2026-09-30).
export default defineConfig(({ mode }) => {
  assertPublicBuildEnv(loadEnv(mode, process.cwd(), "VITE_"), "apps/verify");
  return {
    server: {
      port: 5176,
    },
  };
});
