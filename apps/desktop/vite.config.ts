import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["@motebit/mcp-client"], // Node-only (stdio/child_process), cannot run in webview
  },
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      external: ["@motebit/mcp-client"],
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
      },
      '/api/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/ollama/, ''),
      },
    },
  },
});
