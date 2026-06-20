// Fixture — a Vite browser surface that does NOT reach @motebit/wallet-solana,
// so the polyfill invariant does not apply. Must never be flagged (not a trigger).
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5181 },
});
