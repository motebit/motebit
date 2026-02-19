import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        // Silero VAD model + worklet
        { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx", dest: "." },
        { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx", dest: "." },
        { src: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", dest: "." },
        // ONNX Runtime WASM
        { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", dest: "." },
        { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", dest: "." },
      ],
    }),
  ],
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
