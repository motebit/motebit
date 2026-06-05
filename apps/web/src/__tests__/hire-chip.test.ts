/**
 * Hire-compose register contract — the slab hand-organ for a pinned hire.
 *
 * Locks the surface-determinism + payment-as-act wiring: the act fires
 * `onRun(capability, task, workerId)` with the PINNED worker — never a
 * constructed prompt, never a substituted worker — and only AFTER a task is
 * composed (Run is inert until then). `check-affordance-routing` defends the
 * static shape; this locks the runtime behavior. The pin contract here is the
 * UI half of the runtime's fail-closed `targetWorkerId` (relay-delegation).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installHireChip, type HireComposeRequest } from "../ui/hire-chip";

function mountChatInput(): {
  input: HTMLInputElement;
  row: HTMLDivElement;
  chip: () => HTMLDivElement | null;
  run: () => HTMLButtonElement | null;
} {
  document.body.innerHTML = "";
  const row = document.createElement("div");
  row.id = "chat-input-row";
  const input = document.createElement("input");
  input.id = "chat-input";
  input.placeholder = "Message…";
  row.appendChild(input);
  document.body.appendChild(row);
  return {
    input,
    row,
    chip: () => row.querySelector<HTMLDivElement>(".hire-compose-chip"),
    run: () => row.querySelector<HTMLButtonElement>(".hire-compose-run"),
  };
}

const REQ: HireComposeRequest = {
  workerId: "did:motebit:bob",
  capability: "web_search",
  label: "bob-7f2a",
  priceLabel: "$0.50",
};

describe("installHireChip — pinned hire / payment-as-act contract", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("emerges a chip pinned to {worker, capability, price}", () => {
    const { input, row, chip, run } = mountChatInput();
    const ctrl = installHireChip({ input, row, onRun: vi.fn() });

    ctrl.emerge(REQ);
    expect(chip()).not.toBeNull();
    expect(ctrl.isActive()).toBe(true);
    expect(chip()!.textContent).toContain("bob-7f2a");
    expect(chip()!.textContent).toContain("web_search");
    // The act-button carries the price (payment-as-act).
    expect(run()!.textContent).toBe("Run · $0.50");
  });

  it("keeps Run inert until a task is composed", () => {
    const { input, row, run } = mountChatInput();
    const onRun = vi.fn();
    const ctrl = installHireChip({ input, row, onRun });

    ctrl.emerge(REQ);
    expect(run()!.disabled).toBe(true);

    // fire() with no composed task is a no-op — no payment, no run.
    expect(ctrl.fire()).toBe(false);
    expect(onRun).not.toHaveBeenCalled();

    input.value = "summarize these 3 PRs";
    input.dispatchEvent(new Event("input"));
    expect(run()!.disabled).toBe(false);
  });

  it("fires onRun(capability, task, PINNED workerId) — no substitution, no prompt construction", () => {
    const { input, row, run, chip } = mountChatInput();
    const onRun = vi.fn();
    const ctrl = installHireChip({ input, row, onRun });

    ctrl.emerge(REQ);
    input.value = "summarize these 3 PRs";
    input.dispatchEvent(new Event("input"));
    run()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onRun).toHaveBeenCalledTimes(1);
    // The task is the user's composed text verbatim; the worker is the pin.
    expect(onRun).toHaveBeenCalledWith("web_search", "summarize these 3 PRs", "did:motebit:bob");
    // Cleared + dismissed after the act.
    expect(input.value).toBe("");
    expect(ctrl.isActive()).toBe(false);
    expect(chip()!.classList.contains("is-leaving")).toBe(true);
  });

  it("dismiss() tears down without firing and restores the placeholder", () => {
    const { input, row, chip } = mountChatInput();
    const onRun = vi.fn();
    const ctrl = installHireChip({ input, row, onRun });

    ctrl.emerge(REQ);
    expect(input.placeholder).toContain("bob-7f2a");
    ctrl.dismiss();

    expect(onRun).not.toHaveBeenCalled();
    expect(ctrl.isActive()).toBe(false);
    expect(chip()!.classList.contains("is-leaving")).toBe(true);
    expect(input.placeholder).toBe("Message…");
  });

  it("re-emerging swaps the pin (the latest tapped worker wins)", () => {
    const { input, row } = mountChatInput();
    const onRun = vi.fn();
    const ctrl = installHireChip({ input, row, onRun });

    ctrl.emerge(REQ);
    ctrl.emerge({
      ...REQ,
      workerId: "did:motebit:carol",
      label: "carol-1c4d",
      priceLabel: "$1.00",
    });
    input.value = "do the thing";
    input.dispatchEvent(new Event("input"));
    // The prior chip lingers (is-leaving, removed after the fade) — assert on
    // the live one, the latest pin.
    const liveRun = row.querySelector<HTMLButtonElement>(
      ".hire-compose-chip:not(.is-leaving) .hire-compose-run",
    );
    expect(liveRun!.textContent).toBe("Run · $1.00");

    ctrl.fire();
    expect(onRun).toHaveBeenCalledWith("web_search", "do the thing", "did:motebit:carol");
  });
});
