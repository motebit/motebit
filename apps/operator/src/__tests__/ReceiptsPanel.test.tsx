import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ReceiptsPanel } from "../components/ReceiptsPanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("ReceiptsPanel", () => {
  it("renders the lookup form with motebit_id + task_id inputs and a button", () => {
    render(React.createElement(ReceiptsPanel));
    expect(screen.getByPlaceholderText("motebit_id")).toBeTruthy();
    expect(screen.getByPlaceholderText("task_id")).toBeTruthy();
    expect(screen.getByText("lookup")).toBeTruthy();
  });

  it("rejects empty inputs with an inline error", async () => {
    render(React.createElement(ReceiptsPanel));
    fireEvent.click(screen.getByText("lookup"));
    await waitFor(() => {
      expect(screen.getByText(/Both motebit ID and task ID are required\./)).toBeTruthy();
    });
  });

  it("fetches the canonical JSON on a valid lookup", async () => {
    const canonical = '{"motebit_id":"m1","task_id":"t1","signature":"abc"}';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(JSON.parse(canonical)),
      text: () => Promise.resolve(canonical),
    } as Response);

    render(React.createElement(ReceiptsPanel));
    fireEvent.change(screen.getByPlaceholderText("motebit_id"), {
      target: { value: "m1" },
    });
    fireEvent.change(screen.getByPlaceholderText("task_id"), {
      target: { value: "t1" },
    });
    fireEvent.click(screen.getByText("lookup"));

    await waitFor(() => {
      expect(screen.getByText("Canonical JSON")).toBeTruthy();
    });
    expect(screen.getByText(canonical)).toBeTruthy();
  });
});
