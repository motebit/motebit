import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5175,
    // WebXR requires HTTPS (except localhost)
    https: false,
  },
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    // ONNX Runtime WASM used by @ricky0123/vad-web — let Vite pre-bundle it
    exclude: ["onnxruntime-web"],
  },
  test: {
    environment: "node",
  },
});
