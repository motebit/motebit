/**
 * @vitest-environment jsdom
 *
 * Unit coverage for the `extractStructuredPageContent` in-page
 * evaluator. Slice 2h's `executeReadPage` serializes this function
 * into the Chromium context via `page.evaluate(...)`, but Playwright
 * runs it AS-IS — there's no node-side branch — so exercising it
 * under jsdom (which provides the same browser globals: `document`,
 * `location`, `Blob`) gives honest coverage of the DOM walker
 * without standing up a real Chromium.
 *
 * One implementation, two runtimes. The jsdom test proves the
 * serializable function is correct; the Playwright integration
 * surface proves the bridge works.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { extractStructuredPageContent } from "../action-executor.js";

const OPTS = { textMaxBytes: 1024, headingsMax: 50, linksMax: 50 } as const;

function setBody(html: string): void {
  document.body.innerHTML = html;
}

// jsdom does not implement HTMLElement.innerText (Chromium does). The
// extractor reads innerText because that's the user-visible text in a
// real browser; under jsdom we shim it to textContent so the same code
// path runs without a real DOM rendering pipeline. Production code stays
// unchanged — only the test environment gets the polyfill.
function installInnerTextPolyfill(): void {
  if (Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText")) return;
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
  });
}

describe("extractStructuredPageContent", () => {
  beforeEach(() => {
    installInnerTextPolyfill();
    document.title = "";
    document.body.innerHTML = "";
  });

  it("returns title, body text, headings, and links from a typical page", () => {
    document.title = "Example Page";
    setBody(`
      <h1>Heading One</h1>
      <p>Some body text.</p>
      <h2>Heading Two</h2>
      <a href="https://example.com/a">Link A</a>
      <a href="https://example.com/b">Link B</a>
    `);

    const result = extractStructuredPageContent(OPTS);

    expect(result.title).toBe("Example Page");
    expect(result.url).toBe(location.href);
    expect(result.text).toContain("Some body text.");
    expect(result.text_truncated).toBe(false);
    expect(result.headings).toEqual([
      { level: 1, text: "Heading One" },
      { level: 2, text: "Heading Two" },
    ]);
    expect(result.links).toEqual([
      { text: "Link A", href: "https://example.com/a" },
      { text: "Link B", href: "https://example.com/b" },
    ]);
  });

  it("returns empty title when document.title is unset", () => {
    setBody("<p>hello</p>");
    const result = extractStructuredPageContent(OPTS);
    expect(result.title).toBe("");
  });

  it("trims leading/trailing whitespace from body text", () => {
    setBody("   <p>  spaced  </p>   ");
    const result = extractStructuredPageContent(OPTS);
    expect(result.text.startsWith(" ")).toBe(false);
    expect(result.text.endsWith(" ")).toBe(false);
  });

  it("truncates body text by byte cap and flags text_truncated", () => {
    const long = "a".repeat(2000);
    setBody(`<p>${long}</p>`);
    const result = extractStructuredPageContent({ ...OPTS, textMaxBytes: 100 });
    expect(result.text_truncated).toBe(true);
    expect(new Blob([result.text]).size).toBeLessThanOrEqual(100);
  });

  it("truncates correctly when body fits within the byte cap", () => {
    setBody("<p>short body</p>");
    const result = extractStructuredPageContent(OPTS);
    expect(result.text_truncated).toBe(false);
    expect(result.text).toBe("short body");
  });

  it("respects headingsMax cap", () => {
    setBody(`
      <h1>One</h1>
      <h2>Two</h2>
      <h3>Three</h3>
      <h4>Four</h4>
    `);
    const result = extractStructuredPageContent({ ...OPTS, headingsMax: 2 });
    expect(result.headings).toEqual([
      { level: 1, text: "One" },
      { level: 2, text: "Two" },
    ]);
  });

  it("skips headings whose text is empty after trimming", () => {
    setBody(`
      <h1>Real</h1>
      <h2>   </h2>
      <h3></h3>
      <h4>Also real</h4>
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.headings).toEqual([
      { level: 1, text: "Real" },
      { level: 4, text: "Also real" },
    ]);
  });

  it("captures every heading level h1-h6", () => {
    setBody(`
      <h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6>
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.headings.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("respects linksMax cap", () => {
    setBody(`
      <a href="https://example.com/1">One</a>
      <a href="https://example.com/2">Two</a>
      <a href="https://example.com/3">Three</a>
    `);
    const result = extractStructuredPageContent({ ...OPTS, linksMax: 2 });
    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toEqual({ text: "One", href: "https://example.com/1" });
  });

  it("skips links with empty text", () => {
    setBody(`
      <a href="https://example.com/visible">Visible</a>
      <a href="https://example.com/blank"></a>
      <a href="https://example.com/whitespace">   </a>
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.links).toEqual([{ text: "Visible", href: "https://example.com/visible" }]);
  });

  it("skips javascript: hrefs", () => {
    setBody(`
      <a href="https://example.com/safe">Safe</a>
      <a href="javascript:void(0)">Dangerous</a>
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.links).toEqual([{ text: "Safe", href: "https://example.com/safe" }]);
  });

  it("skips fragment-only hrefs", () => {
    setBody(`
      <a href="https://example.com/page">External</a>
      <a href="#section">Fragment</a>
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.links).toEqual([{ text: "External", href: "https://example.com/page" }]);
  });

  it("returns empty arrays when the page has no headings or links", () => {
    setBody("<p>plain paragraph</p>");
    const result = extractStructuredPageContent(OPTS);
    expect(result.headings).toEqual([]);
    expect(result.links).toEqual([]);
  });

  it("falls back to char-count truncation when Blob throws", () => {
    const originalBlob = globalThis.Blob;
    // @ts-expect-error — deliberately replace Blob with a thrower to
    // exercise the bytesOf catch branch. Restored in finally.
    globalThis.Blob = function ThrowingBlob() {
      throw new Error("Blob unavailable");
    };
    try {
      const long = "a".repeat(500);
      setBody(`<p>${long}</p>`);
      const result = extractStructuredPageContent({ ...OPTS, textMaxBytes: 100 });
      expect(result.text_truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(100);
    } finally {
      globalThis.Blob = originalBlob;
    }
  });
});
