import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      external: ["@motebit/mcp-client"],
    },
  },
  optimizeDeps: {
    exclude: ["@motebit/mcp-client"],
  },
  server: {
    port: 3000,
  },
});
