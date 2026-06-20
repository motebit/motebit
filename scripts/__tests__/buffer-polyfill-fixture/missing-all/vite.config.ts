// Fixture — broken: reaches wallet-solana but ships no Buffer polyfill at all
// (no buffer dep, no define/alias block here, no runtime assignment anywhere).
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5180 },
});
