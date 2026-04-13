/**
 * Spatial HUD tests — the read-only essentials floor.
 *
 * These tests exist to lock the doctrine: the HUD carries connection +
 * balance + task ONLY. If a PR adds a button, a form field, or a
 * navigation handler here, these tests should call that out.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { bindHud, formatBalance, type ConnectionState } from "../hud";

function setupDom(): HTMLElement {
  document.body.innerHTML = `
    <div class="hud" id="hud">
      <span class="hud-field" id="hud-connection">offline</span>
      <span class="hud-field" id="hud-balance">— USDC</span>
      <span class="hud-field" id="hud-task">idle</span>
    </div>
  `;
  return document.getElementById("hud")!;
}

describe("formatBalance", () => {
  it("renders em-dash for null balance", () => {
    expect(formatBalance(null)).toBe("— USDC");
  });

  it("renders 2-decimal micro-USDC", () => {
    expect(formatBalance(1_000_000n)).toBe("1.00 USDC");
    expect(formatBalance(1_500_000n)).toBe("1.50 USDC");
    expect(formatBalance(0n)).toBe("0.00 USDC");
  });
});

describe("bindHud", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = setupDom();
  });

  it("updates connection state with data attribute for styling", () => {
    const hud = bindHud(root);
    const el = root.querySelector("#hud-connection") as HTMLElement;

    const states: ConnectionState[] = ["offline", "connecting", "online"];
    for (const state of states) {
      hud.setConnection(state);
      expect(el.textContent).toBe(state);
      expect(el.dataset["state"]).toBe(state);
    }
  });

  it("renders balance via formatBalance", () => {
    const hud = bindHud(root);
    const el = root.querySelector("#hud-balance")!;
    hud.setBalance(2_340_000n);
    expect(el.textContent).toBe("2.34 USDC");
    hud.setBalance(null);
    expect(el.textContent).toBe("— USDC");
  });

  it("falls back to 'idle' when task label is null", () => {
    const hud = bindHud(root);
    const el = root.querySelector("#hud-task")!;
    hud.setTask("summarizing");
    expect(el.textContent).toBe("summarizing");
    hud.setTask(null);
    expect(el.textContent).toBe("idle");
  });

  it("is a no-op when root is missing expected children", () => {
    document.body.innerHTML = `<div id="empty-hud"></div>`;
    const hud = bindHud(document.getElementById("empty-hud")!);
    expect(() => {
      hud.setConnection("online");
      hud.setBalance(1_000_000n);
      hud.setTask("anything");
    }).not.toThrow();
  });
});
