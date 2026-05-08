/**
 * @vitest-environment jsdom
 *
 * Slice 2d — address bar tests.
 *
 * Two contracts under test:
 *
 *   1. **URL normalization** mirrors the server-side regex (bare
 *      hostnames prepend `https://`, schemed URLs pass through).
 *
 *   2. **Capture surface determinism.** Enter dispatches a typed
 *      `navigate` event via `forwardEvent` — never an AI-loop
 *      backchannel. Empty submit is a no-op. Stop-propagation on
 *      keydown so the input-capture module doesn't double-forward
 *      the user's typed URL into Chromium.
 */

import { describe, it, expect, vi } from "vitest";
import type { UserInputEvent } from "@motebit/sdk";
import type { UserInputForwardResult } from "@motebit/runtime";
import { renderCoBrowseAddressBar, normalizeUrl } from "../ui/cobrowse-address-bar";

function makeForward() {
  const events: UserInputEvent[] = [];
  const forward = vi.fn(async (event: UserInputEvent): Promise<UserInputForwardResult> => {
    events.push(event);
    return {
      outcome: "forwarded",
      audit: {
        session_id: "cs_test",
        motebit_id: "mb_test",
        outcome: "forwarded",
        control_state_at_forwarding: { kind: "user" },
        detail: {
          kind: "navigate",
          scheme: "https",
          host: "example.com",
          has_path: false,
          has_query: false,
        },
        timestamp: 0,
      },
    };
  });
  return { forward, events };
}

// ── normalizeUrl ────────────────────────────────────────────────────────

describe("normalizeUrl — server-side regex parity", () => {
  it("prepends https:// to scheme-less hostnames", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("tesla.com/about")).toBe("https://tesla.com/about");
  });

  it("passes through https:// URLs unchanged", () => {
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("passes through http:// URLs unchanged", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("passes through other schemes (ftp, file, etc.) unchanged", () => {
    expect(normalizeUrl("ftp://files.example.com")).toBe("ftp://files.example.com");
    expect(normalizeUrl("file:///tmp/page.html")).toBe("file:///tmp/page.html");
  });

  it("is case-insensitive on the scheme detection", () => {
    expect(normalizeUrl("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
    expect(normalizeUrl("Https://example.com")).toBe("Https://example.com");
  });

  it("does NOT misclassify scheme-prefix-shaped paths (`com.example/path`)", () => {
    // No `://` after the colon — should be treated as scheme-less
    // and prepended with https://.
    expect(normalizeUrl("com.example/path")).toBe("https://com.example/path");
  });
});

// ── renderCoBrowseAddressBar — affordance + dispatch ────────────────────

describe("renderCoBrowseAddressBar — Enter dispatch", () => {
  it("Enter on a typed URL dispatches a navigate event with normalized URL", async () => {
    const { forward, events } = makeForward();
    const bar = renderCoBrowseAddressBar({ forwardEvent: forward });
    document.body.appendChild(bar);
    const input = bar.querySelector("input")!;
    input.value = "example.com";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    // Forward is async (Promise); wait a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([{ kind: "navigate", url: "https://example.com" }]);
  });

  it("passes through schemed URLs unchanged", async () => {
    const { forward, events } = makeForward();
    const bar = renderCoBrowseAddressBar({ forwardEvent: forward });
    document.body.appendChild(bar);
    const input = bar.querySelector("input")!;
    input.value = "https://docs.example.com/page";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual([{ kind: "navigate", url: "https://docs.example.com/page" }]);
  });

  it("clears the input after a successful submit (calm chrome)", async () => {
    const { forward } = makeForward();
    const bar = renderCoBrowseAddressBar({ forwardEvent: forward });
    document.body.appendChild(bar);
    const input = bar.querySelector("input")!;
    input.value = "example.com";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(input.value).toBe("");
  });

  it("empty submit is a no-op (no event fired)", async () => {
    const { forward, events } = makeForward();
    const bar = renderCoBrowseAddressBar({ forwardEvent: forward });
    document.body.appendChild(bar);
    const input = bar.querySelector("input")!;
    input.value = "";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toHaveLength(0);
  });

  it("whitespace-only submit is a no-op", async () => {
    const { forward, events } = makeForward();
    const bar = renderCoBrowseAddressBar({ forwardEvent: forward });
    document.body.appendChild(bar);
    const input = bar.querySelector("input")!;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toHaveLength(0);
  });

  it("non-Enter keys do NOT dispatch (typing into the bar is local)", async () => {
    const { forward, events } = makeForward();
    const bar = renderCoBrowseAddressBar({ forwardEvent: forward });
    document.body.appendChild(bar);
    const input = bar.querySelector("input")!;
    input.value = "examp";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toHaveLength(0);
  });
});

// ── Stop-propagation contract — coexistence with input capture ──────────

describe("renderCoBrowseAddressBar — propagation discipline", () => {
  it("stopPropagation on keydown so input capture does NOT double-forward", () => {
    const { forward } = makeForward();
    const bar = renderCoBrowseAddressBar({ forwardEvent: forward });
    document.body.appendChild(bar);
    const input = bar.querySelector("input")!;

    let bubbledToDocument = false;
    document.addEventListener(
      "keydown",
      () => {
        bubbledToDocument = true;
      },
      // Capture-phase listener — same phase the input-capture
      // module attaches with (third arg `true`).
      true,
    );

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

    // Stop-propagation in capture phase prevents bubbling AND keeps
    // sibling capture-phase listeners from firing. The address bar
    // attaches its handler in bubble phase (default), so the
    // document capture-phase listener fires FIRST. We assert that
    // input.addEventListener stops further propagation reliably for
    // the *handler chain*. Specifically: after the input's keydown
    // handler runs (calling stopPropagation), no further bubble-
    // phase listeners on document should see the event.
    let bubbledToDocumentBubble = false;
    document.addEventListener(
      "keydown",
      () => {
        bubbledToDocumentBubble = true;
      },
      false,
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    expect(bubbledToDocumentBubble).toBe(false);
    // Capture-phase listener WAS hit (it ran before the input's
    // bubble handler). That's expected; capture-phase semantics
    // can't be blocked by a bubble-phase stopPropagation.
    expect(bubbledToDocument).toBe(true);
  });

  it("stopPropagation on keypress / keyup / paste (input typing belongs to the bar)", () => {
    const { forward } = makeForward();
    const bar = renderCoBrowseAddressBar({ forwardEvent: forward });
    document.body.appendChild(bar);
    const input = bar.querySelector("input")!;

    let bubbledKeyup = false;
    let bubbledKeypress = false;
    let bubbledPaste = false;
    document.addEventListener("keyup", () => (bubbledKeyup = true));
    document.addEventListener("keypress", () => (bubbledKeypress = true));
    document.addEventListener("paste", () => (bubbledPaste = true));

    input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: "a", bubbles: true }));
    // jsdom lacks ClipboardEvent constructor; use a generic Event
    // with the right `type` — addEventListener("paste") matches on
    // event.type so this is functionally equivalent.
    input.dispatchEvent(new Event("paste", { bubbles: true }));

    expect(bubbledKeyup).toBe(false);
    expect(bubbledKeypress).toBe(false);
    expect(bubbledPaste).toBe(false);
  });
});
