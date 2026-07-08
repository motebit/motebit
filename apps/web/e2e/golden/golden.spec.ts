/**
 * Golden-frame visual regression (docs/doctrine/creature-canon.md
 * §proof contract). One test per matrix entry: load the harness page,
 * render the pinned frame, screenshot the canvas against the committed
 * reference. Runs only in the `golden` Playwright project (WebGL via
 * SwiftShader); the smoke `chromium` project ignores this directory.
 */

import { test, expect } from "@playwright/test";
import { GOLDEN_MATRIX, goldenFrameName } from "./golden-matrix";

test.describe("creature golden frames", () => {
  for (const spec of GOLDEN_MATRIX) {
    const name = goldenFrameName(spec);
    test(name, async ({ page }) => {
      await page.goto("/golden.html");
      await page.waitForFunction(() => window.goldenReady === true, undefined, {
        timeout: 20_000,
      });
      await page.evaluate(
        async (s) => window.renderGoldenFrame(s),
        // GoldenFrameSpec is plain JSON (TrustMode is a string enum) —
        // serializes across the page boundary losslessly.
        spec,
      );
      await expect(page.locator("#golden-canvas")).toHaveScreenshot(`${name}.png`);
    });
  }
});
