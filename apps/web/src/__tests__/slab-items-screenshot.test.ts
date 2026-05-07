/**
 * Tests for the slab's screenshot-observation rendering path.
 *
 * `extractScreenshot` + `buildScreenshotSrcdoc` are the two
 * surface-shared primitives that route a `computer` tool's screenshot
 * result through the same fetch slab card the reader-mode renderer
 * uses. The reviewer's required invariants for slice 3b:
 *
 *   1. Screenshot result with `bytes_base64` renders as `<img>`.
 *   2. Malformed / empty bytes do not crash the slab (return `null`,
 *      caller falls through to reader-mode path).
 *   3. Non-screenshot tool results keep existing rendering (return
 *      `null`).
 *
 * Pure-function tests, no DOM. The DOM-side wiring
 * (`applyFetchPayload`) is exercised by the existing Playwright E2E
 * cadence per `apps/web/vitest.config.ts`'s `coverageExclude:
 * src/ui/**` rule.
 */

import { describe, it, expect } from "vitest";
import {
  extractScreenshot,
  buildScreenshotSrcdoc,
  type ScreenshotPayload,
} from "../ui/slab-items.js";

const VALID_SCREENSHOT_RESULT = {
  kind: "screenshot",
  bytes_base64: "iVBORw0KGgo=", // PNG magic header (truncated)
  image_format: "png",
  width: 1280,
  height: 800,
  captured_at: 1_700_000_000_000,
};

describe("extractScreenshot", () => {
  it("returns the typed payload for a well-shaped screenshot result", () => {
    const out = extractScreenshot(VALID_SCREENSHOT_RESULT);
    expect(out).not.toBeNull();
    expect(out!.bytes_base64).toBe("iVBORw0KGgo=");
    expect(out!.image_format).toBe("png");
    expect(out!.width).toBe(1280);
    expect(out!.height).toBe(800);
    expect(out!.captured_at).toBe(1_700_000_000_000);
  });

  it("returns null for a non-screenshot tool result (reader-mode path stays)", () => {
    expect(extractScreenshot({ context: "https://example.com", result: "page text" })).toBeNull();
    expect(extractScreenshot({ kind: "click", ok: true })).toBeNull();
    expect(extractScreenshot({ kind: "cursor_position", x: 1, y: 2 })).toBeNull();
  });

  it("returns null for malformed inputs (no crash)", () => {
    expect(extractScreenshot(null)).toBeNull();
    expect(extractScreenshot(undefined)).toBeNull();
    expect(extractScreenshot("a string")).toBeNull();
    expect(extractScreenshot(42)).toBeNull();
    expect(extractScreenshot([])).toBeNull();
  });

  it("returns null when bytes_base64 is missing or empty", () => {
    expect(extractScreenshot({ kind: "screenshot" })).toBeNull();
    expect(extractScreenshot({ kind: "screenshot", bytes_base64: "" })).toBeNull();
    expect(extractScreenshot({ kind: "screenshot", bytes_base64: 42 })).toBeNull();
  });

  it("defaults image_format to png when absent", () => {
    const out = extractScreenshot({
      kind: "screenshot",
      bytes_base64: "AAAA",
    });
    expect(out!.image_format).toBe("png");
  });

  it("defaults width / height / captured_at to safe values when absent", () => {
    const out = extractScreenshot({ kind: "screenshot", bytes_base64: "AAAA" });
    expect(out!.width).toBe(0);
    expect(out!.height).toBe(0);
    expect(out!.captured_at).toBeUndefined();
  });
});

describe("buildScreenshotSrcdoc", () => {
  const payload: ScreenshotPayload = {
    bytes_base64: "iVBORw0KGgo=",
    image_format: "png",
    width: 1280,
    height: 800,
    captured_at: 0,
  };

  it("emits an <img> with the base64 bytes as a data URI", () => {
    const html = buildScreenshotSrcdoc(payload);
    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('alt="Browser viewport"');
  });

  it("uses image/jpeg for jpeg payloads", () => {
    const html = buildScreenshotSrcdoc({ ...payload, image_format: "jpeg" });
    expect(html).toContain("data:image/jpeg;base64");
    expect(html).not.toContain("data:image/png");
  });

  it("falls through to image/png for unknown formats (defense in depth)", () => {
    const html = buildScreenshotSrcdoc({ ...payload, image_format: "webp" });
    expect(html).toContain("data:image/png;base64");
  });

  it("contains no <script> tags (sandboxed iframe still blocks, but defense in depth)", () => {
    const html = buildScreenshotSrcdoc(payload);
    expect(html).not.toMatch(/<script/i);
  });

  it("does not duplicate the screenshot bytes outside the <img src> attribute", () => {
    // The slab is the canonical surface for the screenshot. The bytes
    // MUST NOT bleed into chat text (per slice 3b reviewer invariant
    // 5: "screenshot bytes are not duplicated into chat text"). The
    // srcdoc is a self-contained iframe document — its only consumer
    // is the iframe; chat rendering reads `payload.context` and
    // markdown-formatted result text, not the raw result object's
    // `bytes_base64` field.
    const html = buildScreenshotSrcdoc(payload);
    const occurrences = html.split(payload.bytes_base64).length - 1;
    expect(occurrences).toBe(1);
  });
});
