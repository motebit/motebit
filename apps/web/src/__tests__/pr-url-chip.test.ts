/**
 * PR-URL chip contract — asserts the surface-determinism wiring.
 *
 * The chip must call `onInvoke(capability, url)` directly on tap — never
 * route through a constructed prompt + handleSend. That contract is what
 * `check-affordance-routing` defends statically; this test locks the
 * runtime behavior.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installPrUrlChip } from "../ui/pr-url-chip";

function mountChatInput(): {
  input: HTMLInputElement;
  row: HTMLDivElement;
  chip: () => HTMLButtonElement | null;
} {
  document.body.innerHTML = "";
  const row = document.createElement("div");
  row.id = "chat-input-row";
  const input = document.createElement("input");
  input.id = "chat-input";
  row.appendChild(input);
  document.body.appendChild(row);
  return {
    input,
    row,
    chip: () => row.querySelector<HTMLButtonElement>(".pr-url-chip"),
  };
}

describe("installPrUrlChip — deterministic invocation contract", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("emerges a chip when a GitHub PR URL is entered", () => {
    const { input, row, chip } = mountChatInput();
    const onInvoke = vi.fn();
    installPrUrlChip({ input, row, onInvoke });

    input.value = "https://github.com/acme/repo/pull/42";
    input.dispatchEvent(new Event("input"));
    expect(chip()).not.toBeNull();
    expect(chip()?.textContent).toContain("Review this PR");
  });

  it("calls onInvoke('review_pr', <url>) on tap — no prompt construction", () => {
    const { input, row, chip } = mountChatInput();
    const onInvoke = vi.fn();
    installPrUrlChip({ input, row, onInvoke });

    input.value = "https://github.com/acme/repo/pull/42";
    input.dispatchEvent(new Event("input"));
    chip()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onInvoke).toHaveBeenCalledTimes(1);
    expect(onInvoke).toHaveBeenCalledWith("review_pr", "https://github.com/acme/repo/pull/42");
  });

  it("does not emerge a chip for non-PR GitHub URLs", () => {
    const { input, row, chip } = mountChatInput();
    installPrUrlChip({ input, row, onInvoke: vi.fn() });

    input.value = "https://github.com/acme/repo";
    input.dispatchEvent(new Event("input"));
    expect(chip()).toBeNull();
  });

  it("dismisses the chip when the URL is cleared", () => {
    const { input, row, chip } = mountChatInput();
    installPrUrlChip({ input, row, onInvoke: vi.fn() });

    input.value = "https://github.com/acme/repo/pull/42";
    input.dispatchEvent(new Event("input"));
    expect(chip()).not.toBeNull();

    input.value = "";
    input.dispatchEvent(new Event("input"));
    // The chip animates away — once it's been marked is-leaving it's going.
    expect(chip()?.classList.contains("is-leaving") ?? true).toBe(true);
  });

  it("clears the input and dismisses after tap (no ambient side effects)", () => {
    const { input, row, chip } = mountChatInput();
    installPrUrlChip({ input, row, onInvoke: vi.fn() });

    input.value = "https://github.com/acme/repo/pull/42";
    input.dispatchEvent(new Event("input"));
    const el = chip()!;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(input.value).toBe("");
    expect(el.classList.contains("is-leaving")).toBe(true);
  });
});
