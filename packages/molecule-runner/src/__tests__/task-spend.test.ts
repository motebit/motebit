/**
 * The per-admitted-task spend ledger's contract (task-spend.ts): atomic
 * reserve-before-pay against a budget, settle to what actually left the
 * wallet, durable across a restart, retained at least as long as the
 * admission row it guards, fail-closed on a corrupt file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileAdmissionStores,
  fileTaskSpendLedger,
  memoryTaskSpend,
  memoryTaskSpendLedger,
  taskSpendFor,
  TASK_SPEND_RETENTION_MS,
} from "../index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rb3-ledger-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("task spend ledger", () => {
  it("reserve holds everything left iff at least the minimum is left; a second reserve sees the hold", () => {
    const l = memoryTaskSpendLedger();
    const h = l.reserve("t", 100, 60);
    expect(h).toMatchObject({ heldMicro: 100 });
    expect(l.committedMicro("t")).toBe(100);
    expect(l.reserve("t", 100, 1)).toBeNull(); // a concurrent run cannot reserve past the budget
    l.settle("t", h!.holdId, 60);
    expect(l.committedMicro("t")).toBe(60);
    expect(l.reserve("t", 100, 41)).toBeNull();
    expect(l.reserve("t", 100, 40)).toMatchObject({ heldMicro: 40 });
  });

  it("settle to zero releases the hold; money above the hold is still charged", () => {
    const l = memoryTaskSpendLedger();
    const h = l.reserve("t", 100, 10)!;
    l.settle("t", h.holdId, 0);
    expect(l.committedMicro("t")).toBe(0);
    const h2 = l.reserve("t", 100, 10)!;
    l.settle("t", h2.holdId, 150);
    expect(l.committedMicro("t")).toBe(150);
  });

  it("a non-finite or negative settle charges the hold in full (unknown ⇒ moved)", () => {
    const l = memoryTaskSpendLedger();
    const h = l.reserve("t", 100, 10)!;
    l.settle("t", h.holdId, Number.NaN);
    expect(l.committedMicro("t")).toBe(100);
    const l2 = memoryTaskSpendLedger();
    const h2 = l2.reserve("t", 80, 10)!;
    l2.settle("t", h2.holdId, -5);
    expect(l2.committedMicro("t")).toBe(80);
  });

  it("an unbudgeted charge (no hold) accrues; a zero / NaN budget reserves nothing", () => {
    const l = memoryTaskSpendLedger();
    l.settle("t", null, 30);
    expect(l.committedMicro("t")).toBe(30);
    expect(l.reserve("u", 0, 1)).toBeNull();
    expect(l.reserve("u", Number.NaN, 1)).toBeNull();
    expect(l.reserve("u", 10, 0)).toMatchObject({ heldMicro: 10 }); // min floors at 1
  });

  it("task ids are independent", () => {
    const l = memoryTaskSpendLedger();
    l.settle("a", null, 100);
    expect(l.reserve("b", 100, 100)).toMatchObject({ heldMicro: 100 });
    expect(l.committedMicro("a")).toBe(100);
  });

  it("durable: a new instance on the same file sees settled spend AND outstanding holds", () => {
    const path = join(dir, "task-spend.json");
    const a = fileTaskSpendLedger(path);
    a.settle("t", null, 40);
    a.reserve("t", 100, 10); // the process dies with this hop in flight
    const b = fileTaskSpendLedger(path);
    expect(b.committedMicro("t")).toBe(100); // the dead run's hold stays charged
    expect(b.reserve("t", 100, 1)).toBeNull();
  });

  it("a corrupt file throws (fail closed) — never a fresh budget; a missing file is empty", () => {
    const path = join(dir, "task-spend.json");
    expect(fileTaskSpendLedger(path).committedMicro("t")).toBe(0);
    writeFileSync(path, "{not json");
    const l = fileTaskSpendLedger(path);
    expect(() => l.reserve("t", 100, 1)).toThrow();
    expect(() => l.committedMicro("t")).toThrow();
  });

  it("rows are retained TASK_SPEND_RETENTION_MS after the last charge, then pruned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const path = join(dir, "task-spend.json");
    const l = fileTaskSpendLedger(path);
    l.settle("old", null, 50);
    vi.setSystemTime(1_000_000 + TASK_SPEND_RETENTION_MS - 1);
    expect(l.committedMicro("old")).toBe(50);
    // Retained past the admission row's 1 h cap (a refreshed dispatch token
    // for the same task within the relay's 24 h idempotency window).
    expect(TASK_SPEND_RETENTION_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    vi.setSystemTime(1_000_000 + TASK_SPEND_RETENTION_MS);
    expect(l.committedMicro("old")).toBe(0);
    l.settle("new", null, 1); // a write prunes the expired row from disk
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")) as object)).toEqual(["new"]);
  });

  it("taskSpendFor binds one id; memoryTaskSpend is a fresh per-run ledger", () => {
    const l = memoryTaskSpendLedger();
    const s = taskSpendFor(l, "t");
    const h = s.reserve(100, 10)!;
    s.settle(h.holdId, 25);
    expect(s.committedMicro()).toBe(25);
    expect(l.committedMicro("t")).toBe(25);
    const r1 = memoryTaskSpend();
    r1.settle(null, 70);
    expect(memoryTaskSpend().committedMicro()).toBe(0);
  });

  it("fileAdmissionStores puts the ledger beside admitted-tasks.json", () => {
    const stores = fileAdmissionStores(dir);
    stores.spendLedger.settle("t", null, 9);
    expect(JSON.parse(readFileSync(join(dir, "task-spend.json"), "utf8"))).toMatchObject({
      t: { settled: 9 },
    });
  });
});
