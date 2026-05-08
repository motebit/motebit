/**
 * @vitest-environment jsdom
 *
 * Sibling of receipt-artifact.test.ts. Same shape: mock the local
 * verify, render the artifact in jsdom, assert structural shape +
 * verify-state transitions. v1.5 of the virtual_browser arc.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerSessionReceipt } from "@motebit/sdk";

const verifyMock = vi.fn();
vi.mock("@motebit/encryption", () => ({
  verifyComputerSessionReceipt: (...args: unknown[]) => verifyMock(...args),
  hexToBytes: (_hex: string) => new Uint8Array(32),
}));

const { buildComputerSessionReceiptArtifact } =
  await import("../computer-session-receipt-artifact.js");

function makeReceipt(overrides: Partial<ComputerSessionReceipt> = {}): ComputerSessionReceipt {
  return {
    receipt_id: "csr_test_001",
    session_id: "cs_abcdef123",
    motebit_id: "mb_worker_abcdef123456",
    public_key: "f".repeat(64),
    embodiment_mode: "virtual_browser",
    display_width: 1280,
    display_height: 800,
    scaling_factor: 2,
    opened_at: 1_700_000_000_000,
    closed_at: 1_700_000_005_000,
    close_reason: "user_closed",
    action_count: 3,
    outcomes_summary: { success: 2, failure: 1 },
    failure_breakdown: { approval_required: 1 },
    was_halted: false,
    max_sensitivity: "personal",
    actions_hash: "a".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig_0x0123456789abcdef",
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  verifyMock.mockReset();
});

describe("buildComputerSessionReceiptArtifact — structural render", () => {
  it("produces a root with the shared spatial-artifact + artifact-receipt classes", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    expect(el.classList.contains("spatial-artifact")).toBe(true);
    expect(el.classList.contains("artifact-receipt")).toBe(true);
    // Plus the v1.5-specific marker so surface CSS can branch when needed.
    expect(el.classList.contains("artifact-computer-session")).toBe(true);
  });

  it("title carries the embodiment mode for at-a-glance distinction", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    const title = el.querySelector(".spatial-artifact-title");
    expect(title?.textContent).toContain("computer session");
    expect(title?.textContent).toContain("virtual_browser");
  });

  it("desktop_drive embodiment renders distinctly in the title", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(
      makeReceipt({ embodiment_mode: "desktop_drive" }),
      () => {},
    );
    const title = el.querySelector(".spatial-artifact-title");
    expect(title?.textContent).toContain("desktop_drive");
  });

  it("summary line shows action count + success/failure split", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    const name = el.querySelector(".receipt-name");
    expect(name?.textContent).toContain("3 actions");
    expect(name?.textContent).toContain("2 ok");
    expect(name?.textContent).toContain("1 fail");
  });

  it("singular action_count drops the plural", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(
      makeReceipt({ action_count: 1, outcomes_summary: { success: 1, failure: 0 } }),
      () => {},
    );
    const name = el.querySelector(".receipt-name");
    expect(name?.textContent).toContain("1 action");
    expect(name?.textContent).not.toContain("1 actions");
  });

  it("was_halted prefixes the summary with 'halted ·'", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(makeReceipt({ was_halted: true }), () => {});
    const name = el.querySelector(".receipt-name");
    expect(name?.textContent?.startsWith("halted ·")).toBe(true);
  });

  it("max_sensitivity 'none' suppresses the trailing tier label", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(
      makeReceipt({ max_sensitivity: "none" }),
      () => {},
    );
    const cost = el.querySelector(".receipt-cost");
    expect(cost?.textContent).toBe("");
  });

  it("max_sensitivity above none renders the tier inline", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(
      makeReceipt({ max_sensitivity: "financial" }),
      () => {},
    );
    const cost = el.querySelector(".receipt-cost");
    expect(cost?.textContent).toContain("financial");
  });

  it("details block surfaces every signed field a third party would audit", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    const details = el.querySelector(".receipt-details");
    const text = details?.textContent ?? "";
    expect(text).toContain("receipt_id");
    expect(text).toContain("session_id");
    expect(text).toContain("signed by");
    expect(text).toContain("signature");
    expect(text).toContain("suite");
    expect(text).toContain("public_key");
    expect(text).toContain("opened");
    expect(text).toContain("closed");
    expect(text).toContain("close_reason");
    expect(text).toContain("actions_hash");
  });

  it("failure_breakdown surfaces one row per reason when non-empty", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(
      makeReceipt({
        failure_breakdown: { approval_required: 2, target_not_found: 1 },
        outcomes_summary: { success: 0, failure: 3 },
      }),
      () => {},
    );
    const text = el.querySelector(".receipt-details")?.textContent ?? "";
    expect(text).toContain("failure: approval_required");
    expect(text).toContain("failure: target_not_found");
  });

  it("close_reason is omitted from details when absent", () => {
    verifyMock.mockResolvedValue(true);
    const r = makeReceipt();
    delete (r as { close_reason?: string }).close_reason;
    const el = buildComputerSessionReceiptArtifact(r, () => {});
    const text = el.querySelector(".receipt-details")?.textContent ?? "";
    expect(text).not.toContain("close_reason");
  });
});

describe("buildComputerSessionReceiptArtifact — verify-state transitions", () => {
  it("starts in is-pending with 'verifying locally…' label", () => {
    verifyMock.mockReturnValue(new Promise(() => {})); // never resolves
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    expect(el.classList.contains("is-pending")).toBe(true);
    const label = el.querySelector(".receipt-verify-label");
    expect(label?.textContent).toBe("verifying locally…");
  });

  it("flips to is-verified when verify resolves true", async () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    await flushMicrotasks();
    expect(el.classList.contains("is-pending")).toBe(false);
    expect(el.classList.contains("is-verified")).toBe(true);
    expect(el.querySelector(".receipt-verify-label")?.textContent).toContain("verified locally");
  });

  it("flips to is-unverified when verify resolves false", async () => {
    verifyMock.mockResolvedValue(false);
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    await flushMicrotasks();
    expect(el.classList.contains("is-pending")).toBe(false);
    expect(el.classList.contains("is-unverified")).toBe(true);
    expect(el.querySelector(".receipt-verify-label")?.textContent).toBe("verification failed");
  });

  it("flips to is-unverified when verify rejects", async () => {
    verifyMock.mockRejectedValue(new Error("verify error"));
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    await flushMicrotasks();
    expect(el.classList.contains("is-unverified")).toBe(true);
  });

  it("missing public_key short-circuits to is-unverified WITHOUT calling verify", () => {
    verifyMock.mockResolvedValue(true);
    const r = makeReceipt();
    delete (r as { public_key?: string }).public_key;
    const el = buildComputerSessionReceiptArtifact(r, () => {});
    expect(el.classList.contains("is-unverified")).toBe(true);
    expect(el.querySelector(".receipt-verify-label")?.textContent).toContain("no public key");
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe("buildComputerSessionReceiptArtifact — interaction", () => {
  it("body click toggles is-expanded for detail collapse", () => {
    verifyMock.mockResolvedValue(true);
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), () => {});
    const body = el.querySelector(".spatial-artifact-body") as HTMLElement;
    expect(el.classList.contains("is-expanded")).toBe(false);
    body.click();
    expect(el.classList.contains("is-expanded")).toBe(true);
    body.click();
    expect(el.classList.contains("is-expanded")).toBe(false);
  });

  it("close button fires onDismiss and stops propagation", () => {
    verifyMock.mockResolvedValue(true);
    const onDismiss = vi.fn();
    const el = buildComputerSessionReceiptArtifact(makeReceipt(), onDismiss);
    const close = el.querySelector(".spatial-artifact-close") as HTMLButtonElement;
    close.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Body click handler must not have fired (stopPropagation).
    expect(el.classList.contains("is-expanded")).toBe(false);
  });
});
