/**
 * @vitest-environment jsdom
 *
 * receipt-artifact.ts builds the DOM card for an ExecutionReceipt. The
 * happy path is render → pending state → async verify → state class flip.
 * jsdom gives us `document.createElement`; verifyReceiptChain is stubbed
 * so each test runs synchronously and exercises every verify branch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReceipt } from "@motebit/sdk";

// Stub out the expensive / environment-touching crypto verify so tests
// can drive each verify outcome deterministically. Must run before the
// module under test is imported.
const verifyReceiptChainMock = vi.fn();
vi.mock("@motebit/encryption", () => ({
  verifyReceiptChain: (...args: unknown[]) => verifyReceiptChainMock(...args),
}));

// Import AFTER the mock so the module picks up the stubbed function.
const { buildReceiptArtifact } = await import("../receipt-artifact.js");

function makeReceipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    spec: "motebit/execution-ledger@1.0",
    motebit_id: "mb_worker_abcdef123456",
    task_id: "task_xyz1234567890",
    relay_task_id: "relay_abc",
    status: "completed",
    started_at: 1_700_000_000_000,
    completed_at: 1_700_000_005_000,
    tools_used: ["research"],
    public_key: "",
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "sig_0x0123456789abcdef",
    ...overrides,
  } as ExecutionReceipt;
}

async function flushMicrotasks(): Promise<void> {
  // Awaiting twice lets the verify-then chain settle in tests.
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  verifyReceiptChainMock.mockReset();
});

describe("buildReceiptArtifact — structural render", () => {
  it("produces a root element with artifact + receipt classes", () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    expect(el.classList.contains("spatial-artifact")).toBe(true);
    expect(el.classList.contains("artifact-receipt")).toBe(true);
  });

  it("renders the receipt title 'receipt'", () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    expect(el.querySelector(".spatial-artifact-title")?.textContent).toBe("receipt");
  });

  it("renders one chain row for the root plus one per nested delegation_receipt", () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const el = buildReceiptArtifact(
      makeReceipt({
        delegation_receipts: [
          makeReceipt({ motebit_id: "mb_leaf_a", tools_used: ["read_url"] }),
          makeReceipt({ motebit_id: "mb_leaf_b", tools_used: ["web_search"] }),
        ],
      }),
      () => {},
    );
    const rows = el.querySelectorAll(".receipt-row");
    // 1 root + 2 children.
    expect(rows).toHaveLength(3);
    expect(el.querySelectorAll(".receipt-root")).toHaveLength(1);
    expect(el.querySelectorAll(".receipt-child")).toHaveLength(2);
  });

  it("emits details rows for signer, task_id, signature, suite", () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    const labels = Array.from(el.querySelectorAll(".receipt-detail-label")).map(
      (e) => e.textContent,
    );
    expect(labels).toEqual(["signed by", "task_id", "signature", "suite"]);
  });

  it("starts in the is-pending state before verification resolves", () => {
    // Never-resolving verify: the pending class stays set.
    verifyReceiptChainMock.mockReturnValue(new Promise(() => {}));
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    expect(el.classList.contains("is-pending")).toBe(true);
  });

  it("renders the verifying-locally label initially", () => {
    verifyReceiptChainMock.mockReturnValue(new Promise(() => {}));
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    expect(el.querySelector(".receipt-verify-label")?.textContent).toBe("verifying locally…");
  });
});

describe("buildReceiptArtifact — verify outcomes", () => {
  it("flips to is-verified + intact label when verify resolves verified + status=completed", async () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const el = buildReceiptArtifact(makeReceipt({ status: "completed" }), () => {});
    await flushMicrotasks();
    expect(el.classList.contains("is-pending")).toBe(false);
    expect(el.classList.contains("is-verified")).toBe(true);
    expect(el.querySelector(".receipt-verify-label")?.textContent).toBe(
      "verified locally · chain intact",
    );
  });

  it("flips to is-failed + failed label when verified true but status=failed", async () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const el = buildReceiptArtifact(makeReceipt({ status: "failed" }), () => {});
    await flushMicrotasks();
    expect(el.classList.contains("is-failed")).toBe(true);
    expect(el.querySelector(".receipt-verify-label")?.textContent).toBe(
      "verified · completed: failed",
    );
  });

  it("flips to is-unverified when verify resolves verified=false", async () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: false });
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    await flushMicrotasks();
    expect(el.classList.contains("is-unverified")).toBe(true);
    expect(el.querySelector(".receipt-verify-label")?.textContent).toBe("verification failed");
  });

  it("flips to is-unverified when verify rejects", async () => {
    verifyReceiptChainMock.mockRejectedValue(new Error("crypto fault"));
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    await flushMicrotasks();
    expect(el.classList.contains("is-unverified")).toBe(true);
    expect(el.querySelector(".receipt-verify-label")?.textContent).toBe("verification failed");
  });
});

describe("buildReceiptArtifact — interactions", () => {
  it("clicking the body toggles is-expanded on the root", () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    const body = el.querySelector<HTMLElement>(".spatial-artifact-body")!;
    body.click();
    expect(el.classList.contains("is-expanded")).toBe(true);
    body.click();
    expect(el.classList.contains("is-expanded")).toBe(false);
  });

  it("clicking close fires the onDismiss callback and does not toggle body expansion", () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const onDismiss = vi.fn();
    const el = buildReceiptArtifact(makeReceipt(), onDismiss);
    const close = el.querySelector<HTMLButtonElement>(".spatial-artifact-close")!;
    close.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Close click.stopPropagation means the body click handler didn't fire.
    expect(el.classList.contains("is-expanded")).toBe(false);
  });

  it("close button has accessible label", () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    const el = buildReceiptArtifact(makeReceipt(), () => {});
    expect(el.querySelector(".spatial-artifact-close")?.getAttribute("aria-label")).toBe(
      "Dismiss receipt",
    );
  });
});

describe("buildReceiptArtifact — suite fallback", () => {
  it("renders '—' when receipt.suite is missing", () => {
    verifyReceiptChainMock.mockResolvedValue({ verified: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = buildReceiptArtifact(makeReceipt({ suite: undefined as any }), () => {});
    const suiteRow = Array.from(el.querySelectorAll(".receipt-detail-row")).find(
      (r) => r.querySelector(".receipt-detail-label")?.textContent === "suite",
    );
    expect(suiteRow?.querySelector(".receipt-detail-value")?.textContent).toBe("—");
  });
});
