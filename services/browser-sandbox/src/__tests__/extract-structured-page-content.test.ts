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

import {
  extractStructuredPageContent,
  clickElementTruth,
  focusElementTruth,
  typeIntoTruth,
} from "../action-executor.js";

const OPTS = {
  textMaxBytes: 1024,
  headingsMax: 50,
  linksMax: 50,
  inputsMax: 50,
  buttonsMax: 50,
  inputValueMaxChars: 256,
  elementIdAttr: "data-motebit-id",
} as const;

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

  // ── element-1: structurally-addressed element extraction ─────────────

  it("element-1: extracts typeable inputs with stamped element_ids", () => {
    setBody(`
      <input type="text" name="q" placeholder="Search" value="hello" />
      <input type="email" name="email" />
      <textarea name="bio" aria-label="Your bio">existing text</textarea>
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.inputs).toHaveLength(3);
    expect(result.inputs[0]).toMatchObject({
      element_id: "motebit-0",
      tag: "input",
      input_type: "text",
      name: "q",
      placeholder: "Search",
      value: "hello",
    });
    expect(result.inputs[1]).toMatchObject({
      element_id: "motebit-1",
      tag: "input",
      input_type: "email",
      name: "email",
    });
    expect(result.inputs[2]).toMatchObject({
      element_id: "motebit-2",
      tag: "textarea",
      input_type: "textarea",
      name: "bio",
      aria_label: "Your bio",
      value: "existing text",
    });
  });

  it("element-1: stamps DOM with data-motebit-id attributes for subsequent action resolution", () => {
    setBody(`<input type="text" name="q" />`);
    extractStructuredPageContent(OPTS);
    const input = document.querySelector("input");
    expect(input?.getAttribute("data-motebit-id")).toBe("motebit-0");
  });

  it("element-1: clears prior stamps and re-stamps fresh on each call", () => {
    setBody(`<input type="text" name="q" />`);
    extractStructuredPageContent(OPTS);
    const input = document.querySelector("input")!;
    expect(input.getAttribute("data-motebit-id")).toBe("motebit-0");
    // Re-extracting should clear the stamp and re-issue (counter resets).
    extractStructuredPageContent(OPTS);
    expect(input.getAttribute("data-motebit-id")).toBe("motebit-0");
    // No accumulation of stale stamps.
    const allStamped = document.querySelectorAll("[data-motebit-id]");
    expect(allStamped.length).toBe(1);
  });

  it("element-1: skips disabled and readonly inputs", () => {
    setBody(`
      <input type="text" name="active" />
      <input type="text" name="dis" disabled />
      <input type="text" name="ro" readonly />
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]?.name).toBe("active");
  });

  it("element-1: skips hidden inputs", () => {
    setBody(`
      <input type="text" name="visible" />
      <input type="hidden" name="hidden_input" />
    `);
    const result = extractStructuredPageContent(OPTS);
    // type="hidden" is not in the typeable types set, so excluded.
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]?.name).toBe("visible");
  });

  it("element-1: extracts buttons with stamped element_ids and visible text", () => {
    setBody(`
      <button>Search</button>
      <input type="submit" value="Submit Form" />
      <button aria-label="Close dialog">×</button>
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.buttons).toHaveLength(3);
    expect(result.buttons[0]).toMatchObject({
      element_id: "motebit-0",
      tag: "button",
      text: "Search",
    });
    expect(result.buttons[1]).toMatchObject({
      element_id: "motebit-1",
      tag: "input",
      text: "Submit Form",
      input_type: "submit",
    });
    // Icon-only button falls back to aria-label.
    expect(result.buttons[2]).toMatchObject({
      element_id: "motebit-2",
      tag: "button",
      text: "×",
    });
  });

  it("element-1: skips buttons with no visible label and no aria-label", () => {
    setBody(`
      <button>Visible</button>
      <button></button>
    `);
    const result = extractStructuredPageContent(OPTS);
    expect(result.buttons).toHaveLength(1);
    expect(result.buttons[0]?.text).toBe("Visible");
  });

  it("element-1: empty arrays when page has no inputs or buttons", () => {
    setBody("<p>just text</p>");
    const result = extractStructuredPageContent(OPTS);
    expect(result.inputs).toEqual([]);
    expect(result.buttons).toEqual([]);
  });

  it("element-1: caps inputs and buttons at the configured max", () => {
    let html = "";
    for (let i = 0; i < 60; i++) html += `<input type="text" name="i${i}" />`;
    for (let i = 0; i < 60; i++) html += `<button>btn${i}</button>`;
    setBody(html);
    const result = extractStructuredPageContent({ ...OPTS, inputsMax: 10, buttonsMax: 5 });
    expect(result.inputs.length).toBe(10);
    expect(result.buttons.length).toBe(5);
  });

  it("element-1: caps long input values at inputValueMaxChars", () => {
    setBody(`<input type="text" name="q" />`);
    const long = "x".repeat(500);
    (document.querySelector("input") as HTMLInputElement).value = long;
    const result = extractStructuredPageContent({ ...OPTS, inputValueMaxChars: 100 });
    expect(result.inputs[0]?.value?.length).toBe(100);
  });

  it("element-1: shared element_id namespace across inputs + buttons (counter is monotonic)", () => {
    setBody(`
      <input type="text" name="q" />
      <button>Go</button>
      <textarea name="t"></textarea>
    `);
    const result = extractStructuredPageContent(OPTS);
    const ids = [
      ...result.inputs.map((i) => i.element_id),
      ...result.buttons.map((b) => b.element_id),
    ].sort();
    // Three elements stamped; ids form a monotonic sequence.
    expect(ids).toEqual(["motebit-0", "motebit-1", "motebit-2"]);
  });
});

// ── element-1: in-page truth snapshots ────────────────────────────

describe("clickElementTruth (jsdom)", () => {
  it("reports the clicked element's tag", () => {
    setBody(`<button data-motebit-id="motebit-0">Go</button>`);
    const result = clickElementTruth({ selector: '[data-motebit-id="motebit-0"]' });
    expect(result.clicked_tag).toBe("button");
  });

  it("reports null when selector matches no element", () => {
    setBody(`<p>nothing</p>`);
    const result = clickElementTruth({ selector: '[data-motebit-id="motebit-99"]' });
    expect(result.clicked_tag).toBeNull();
  });

  it("focused_typeable: true when active element is an input", () => {
    setBody(`<input data-motebit-id="motebit-0" />`);
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    const result = clickElementTruth({ selector: '[data-motebit-id="motebit-0"]' });
    expect(result.focused_typeable).toBe(true);
  });

  it("focused_typeable: true when active element is a textarea", () => {
    setBody(`<textarea data-motebit-id="motebit-0"></textarea>`);
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    ta.focus();
    const result = clickElementTruth({ selector: '[data-motebit-id="motebit-0"]' });
    expect(result.focused_typeable).toBe(true);
  });

  it("focused_typeable: false when active element is a button (non-typeable)", () => {
    setBody(`<button data-motebit-id="motebit-0">Go</button>`);
    const btn = document.querySelector("button") as HTMLButtonElement;
    btn.focus();
    const result = clickElementTruth({ selector: '[data-motebit-id="motebit-0"]' });
    expect(result.focused_typeable).toBe(false);
  });
});

describe("focusElementTruth (jsdom)", () => {
  it("reports tag and focused: true when the queried element is active", () => {
    setBody(`<input data-motebit-id="motebit-0" />`);
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    const result = focusElementTruth({ selector: '[data-motebit-id="motebit-0"]' });
    expect(result.tag).toBe("input");
    expect(result.focused).toBe(true);
  });

  it("focused: false when the queried element exists but is not active", () => {
    setBody(`
      <input data-motebit-id="motebit-0" />
      <input data-motebit-id="motebit-1" />
    `);
    const second = document.querySelectorAll("input")[1] as HTMLInputElement;
    second.focus();
    const result = focusElementTruth({ selector: '[data-motebit-id="motebit-0"]' });
    expect(result.focused).toBe(false);
  });

  it("tag: null when the selector matches no element", () => {
    setBody(`<p>nothing</p>`);
    const result = focusElementTruth({ selector: '[data-motebit-id="motebit-99"]' });
    expect(result.tag).toBeNull();
    expect(result.focused).toBe(false);
  });
});

describe("typeIntoTruth (jsdom)", () => {
  it("reports text_appeared: true when typed text lands in a focused input", () => {
    setBody(`<input data-motebit-id="motebit-0" />`);
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    input.value = "motebit";
    const result = typeIntoTruth({
      selector: '[data-motebit-id="motebit-0"]',
      typedText: "motebit",
    });
    expect(result.focused).toBe(true);
    expect(result.active_element).toBe("input");
    expect(result.value).toBe("motebit");
    expect(result.text_appeared).toBe(true);
  });

  it("reports active_element: 'none' when selector matches no element", () => {
    setBody(`<p>nothing</p>`);
    const result = typeIntoTruth({
      selector: '[data-motebit-id="motebit-99"]',
      typedText: "motebit",
    });
    expect(result.active_element).toBe("none");
    expect(result.focused).toBe(false);
    expect(result.text_appeared).toBe(false);
  });

  it("focused: false when the queried element is not the active element", () => {
    setBody(`
      <input data-motebit-id="motebit-0" />
      <input data-motebit-id="motebit-1" />
    `);
    const second = document.querySelectorAll("input")[1] as HTMLInputElement;
    second.focus();
    const result = typeIntoTruth({
      selector: '[data-motebit-id="motebit-0"]',
      typedText: "anything",
    });
    expect(result.focused).toBe(false);
  });

  it("text_appeared: false when typed text is absent from the value", () => {
    setBody(`<input data-motebit-id="motebit-0" />`);
    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    input.value = "something else";
    const result = typeIntoTruth({
      selector: '[data-motebit-id="motebit-0"]',
      typedText: "motebit",
    });
    expect(result.text_appeared).toBe(false);
  });

  it("non-typeable element returns active_element: tag, focused: false", () => {
    setBody(`<button data-motebit-id="motebit-0">Go</button>`);
    const result = typeIntoTruth({
      selector: '[data-motebit-id="motebit-0"]',
      typedText: "anything",
    });
    expect(result.active_element).toBe("button");
    expect(result.focused).toBe(false);
    expect(result.text_appeared).toBe(false);
  });

  it("caps long values at 512 characters", () => {
    setBody(`<textarea data-motebit-id="motebit-0"></textarea>`);
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    ta.focus();
    ta.value = "x".repeat(800) + "motebit";
    const result = typeIntoTruth({
      selector: '[data-motebit-id="motebit-0"]',
      typedText: "motebit",
    });
    expect(result.value.length).toBe(512);
  });
});
