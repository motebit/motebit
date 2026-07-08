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
      testIgnore: /golden/,
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
        // coverage (the creature render is asserted by the dedicated `golden`
        // project below, which enables WebGL via SwiftShader).
        launchOptions: {
          args: ["--disable-gpu", "--disable-webgl", "--disable-software-rasterizer"],
        },
      },
    },
    {
      // Golden-frame visual regression (docs/doctrine/creature-canon.md
      // §proof contract). Renders the creature deterministically at the
      // canonical pose × performance matrix and diffs the canvas against
      // committed reference frames.
      //
      // SwiftShader (CPU rasterizer) makes the output a pure function of
      // the Chromium build — no GPU variance. Reference frames are
      // linux-only and CI-authoritative: darwin snapshots from local runs
      // are gitignored personal baselines. Two sanctioned update paths —
      // see the `golden:update` script (Playwright container) or copy the
      // CI failure artifact's -actual.png files. A @playwright/test
      // version bump can legitimately shift SwiftShader output — refresh
      // goldens in the same PR.
      name: "golden",
      testMatch: /golden\/.*\.spec\.ts/,
      retries: 0, // a flaky golden frame is signal, not noise
      snapshotPathTemplate: "{testDir}/golden/__screenshots__/{arg}-{platform}{ext}",
      expect: {
        toHaveScreenshot: {
          maxDiffPixelRatio: 0.01,
          threshold: 0.2,
          animations: "disabled",
        },
      },
      use: {
        viewport: { width: 640, height: 640 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--force-color-profile=srgb",
            "--hide-scrollbars",
          ],
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
