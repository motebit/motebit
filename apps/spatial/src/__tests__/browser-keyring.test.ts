import { describe, it, expect, beforeEach } from "vitest";
import { LocalStorageKeyringAdapter } from "../browser-keyring";

class MemStorage {
  private data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe("LocalStorageKeyringAdapter", () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = new MemStorage();
  });

  it("set/get/delete roundtrip with prefix", async () => {
    const kr = new LocalStorageKeyringAdapter();
    await kr.set("alpha", "value1");
    expect(await kr.get("alpha")).toBe("value1");
    // Confirm prefix is applied
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).localStorage.getItem("motebit:alpha")).toBe("value1");
    await kr.delete("alpha");
    expect(await kr.get("alpha")).toBeNull();
  });

  it("get returns null for missing key", async () => {
    const kr = new LocalStorageKeyringAdapter();
    expect(await kr.get("missing")).toBeNull();
  });

  it("delete is idempotent on missing key", async () => {
    const kr = new LocalStorageKeyringAdapter();
    await kr.delete("missing"); // should not throw
    expect(await kr.get("missing")).toBeNull();
  });
});
