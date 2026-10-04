/**
 * @vitest-environment jsdom
 *
 * Web's Anthropic BYOK picker (#654): rows come from the sdk, the default is
 * pre-selected, and a stored pre-#654 model loads and stays selected.
 */
import { describe, it, expect } from "vitest";
import { ANTHROPIC_PICKER, DEFAULT_ANTHROPIC_MODEL } from "@motebit/sdk";
import { renderAnthropicPicker } from "../ui/anthropic-picker.js";

function select(): HTMLSelectElement {
  return document.createElement("select");
}

describe("renderAnthropicPicker", () => {
  it("renders the sdk picker rows with the default selected", () => {
    const el = select();
    renderAnthropicPicker(el);
    expect(Array.from(el.options).map((o) => o.value)).toEqual(ANTHROPIC_PICKER.map((o) => o.id));
    expect(Array.from(el.options).map((o) => o.textContent)).toEqual(
      ANTHROPIC_PICKER.map((o) => o.label),
    );
    expect(el.value).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("a stored claude-sonnet-4-6 loads and shows selected (never migrated)", () => {
    const el = select();
    renderAnthropicPicker(el, "claude-sonnet-4-6");
    expect(el.value).toBe("claude-sonnet-4-6");
    expect(el.options[0]?.value).toBe("claude-sonnet-4-6");
    expect(el.options).toHaveLength(ANTHROPIC_PICKER.length + 1);
  });

  it("re-rendering replaces rows instead of appending", () => {
    const el = select();
    renderAnthropicPicker(el, "claude-sonnet-4-6");
    renderAnthropicPicker(el);
    expect(el.options).toHaveLength(ANTHROPIC_PICKER.length);
  });
});
