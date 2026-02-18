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
  test: {
    environment: "node",
  },
});
