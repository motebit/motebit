import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { OperatorApp } from "../OperatorApp";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function setupFailingFetch() {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
}

describe("OperatorApp", () => {
  it("renders the operator title", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    expect(screen.getByText("Motebit Operator")).toBeTruthy();
  });

  it("shows all 9 fleet-shaped tabs (no agent-shape tabs)", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    expect(screen.getByText("withdrawals")).toBeTruthy();
    expect(screen.getByText("federation")).toBeTruthy();
    expect(screen.getByText("transparency")).toBeTruthy();
    expect(screen.getByText("disputes")).toBeTruthy();
    expect(screen.getByText("fees")).toBeTruthy();
    expect(screen.getByText("anchoring")).toBeTruthy();
    expect(screen.getByText("reconciliation")).toBeTruthy();
    expect(screen.getByText("receipts")).toBeTruthy();
    expect(screen.getByText("freeze")).toBeTruthy();
    // Inspector-shape tabs (state, memory, gradient, etc.) MUST NOT appear here.
    expect(screen.queryByText("state")).toBeNull();
    expect(screen.queryByText("memory")).toBeNull();
    expect(screen.queryByText("gradient")).toBeNull();
    expect(screen.queryByText("trust")).toBeNull();
  });

  it("defaults to withdrawals tab", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    expect(screen.getByRole("heading", { name: "Withdrawals" })).toBeTruthy();
  });

  it("switches to federation tab on click", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    fireEvent.click(screen.getByText("federation"));
    expect(screen.getByRole("heading", { name: "Federation Peers" })).toBeTruthy();
  });

  it("switches to transparency tab on click", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    fireEvent.click(screen.getByText("transparency"));
    expect(screen.getByRole("heading", { name: "Transparency posture" })).toBeTruthy();
  });

  it("switches to disputes tab on click", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    fireEvent.click(screen.getByText("disputes"));
    expect(screen.getByRole("heading", { name: "Disputes" })).toBeTruthy();
  });

  it("switches to fees tab on click", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    fireEvent.click(screen.getByText("fees"));
    expect(screen.getByRole("heading", { name: "Fees" })).toBeTruthy();
  });

  it("switches to anchoring tab on click", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    fireEvent.click(screen.getByText("anchoring"));
    expect(screen.getByRole("heading", { name: "Credential Anchoring" })).toBeTruthy();
  });

  it("switches to reconciliation tab on click", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    fireEvent.click(screen.getByText("reconciliation"));
    expect(screen.getByRole("heading", { name: "Reconciliation" })).toBeTruthy();
  });

  it("switches to receipts tab on click", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    fireEvent.click(screen.getByText("receipts"));
    expect(screen.getByRole("heading", { name: "Receipts" })).toBeTruthy();
  });

  it("switches to freeze tab on click", () => {
    setupFailingFetch();
    render(React.createElement(OperatorApp));
    fireEvent.click(screen.getByText("freeze"));
    expect(screen.getByRole("heading", { name: "Freeze" })).toBeTruthy();
  });
});
