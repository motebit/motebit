import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:4173",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // These are UI smoke tests — they exercise the settings panel, chat
        // input, keyboard shortcuts, budget, and that the canvas/HUD elements
        // exist. NONE assert that the WebGL 3D creature actually renders. So we
        // disable WebGL in the headless browser: it makes the page heavy and,
        // in CI's memory-constrained headless environment, the renderer process
        // can crash ("Target page/context has been closed") — a flaky gate that
        // can't tell a real break from a GPU hiccup. Disabling it makes the
        // suite deterministic and ~4x faster (15 tests, ~7s) with zero loss of
        // coverage (the creature render is not e2e-asserted; a dedicated
        // GPU-enabled render test would be a separate project).
        launchOptions: {
          args: ["--disable-gpu", "--disable-webgl", "--disable-software-rasterizer"],
        },
      },
    },
  ],
  webServer: {
    command: "pnpm preview",
    port: 4173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
