/**
 * Desktop slab screenshot extraction — sibling of
 * `apps/web/src/__tests__/slab-items-screenshot.test.ts`.
 *
 * Regression guard for the desktop-only drop: the web `extractScreenshot`
 * accepted both `screenshot` and `navigate` kinds (v1.3 navigate returns inline
 * bytes), but desktop accepted only `screenshot`, so a post-navigate observation
 * fell through to the text reader instead of rendering the page. Pure-function
 * tests, no DOM.
 */
import { describe, it, expect } from "vitest";
import { extractScreenshot } from "../ui/slab-items.js";

const BYTES = "iVBORw0KGgo="; // truncated PNG magic header

describe("extractScreenshot (desktop)", () => {
  it("extracts a screenshot-kind result with bytes", () => {
    const out = extractScreenshot({ kind: "screenshot", bytes_base64: BYTES, image_format: "png" });
    expect(out).not.toBeNull();
    expect(out!.bytes_base64).toBe(BYTES);
    expect(out!.image_format).toBe("png");
  });

  it("extracts a navigate-kind result that carries inline bytes (the fix)", () => {
    const out = extractScreenshot({
      kind: "navigate",
      bytes_base64: BYTES,
      image_format: "png",
      width: 1280,
      height: 720,
    });
    expect(out).not.toBeNull();
    expect(out!.bytes_base64).toBe(BYTES);
    expect(out!.width).toBe(1280);
    expect(out!.height).toBe(720);
  });

  it("returns null for a navigate result with no inline bytes (falls through to reader)", () => {
    expect(extractScreenshot({ kind: "navigate", ok: true })).toBeNull();
    expect(extractScreenshot({ kind: "navigate", bytes_base64: "" })).toBeNull();
  });

  it("returns null for non-screenshot/non-navigate kinds and malformed input", () => {
    expect(extractScreenshot({ kind: "click", ok: true })).toBeNull();
    expect(extractScreenshot({ context: "https://example.com", result: "page text" })).toBeNull();
    expect(extractScreenshot({ kind: "screenshot" })).toBeNull(); // no bytes
    expect(extractScreenshot({ kind: "screenshot", bytes_base64: 42 })).toBeNull();
    expect(extractScreenshot(null)).toBeNull();
    expect(extractScreenshot(undefined)).toBeNull();
    expect(extractScreenshot("a string")).toBeNull();
  });
});
