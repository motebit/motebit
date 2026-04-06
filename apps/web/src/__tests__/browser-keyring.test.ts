import { describe, it, expect, beforeEach } from "vitest";
import { LocalStorageKeyringAdapter } from "../browser-keyring.js";

describe("LocalStorageKeyringAdapter", () => {
  let adapter: LocalStorageKeyringAdapter;

  beforeEach(() => {
    localStorage.clear();
    adapter = new LocalStorageKeyringAdapter();
  });

  it("returns null for missing key", async () => {
    expect(await adapter.get("nonexistent")).toBeNull();
  });

  it("stores and retrieves a value", async () => {
    await adapter.set("token", "secret123");
    expect(await adapter.get("token")).toBe("secret123");
  });

  it("prefixes keys with motebit:", async () => {
    await adapter.set("foo", "bar");
    expect(localStorage.getItem("motebit:foo")).toBe("bar");
  });

  it("deletes a key", async () => {
    await adapter.set("key", "val");
    await adapter.delete("key");
    expect(await adapter.get("key")).toBeNull();
  });

  it("overwrites existing value", async () => {
    await adapter.set("k", "v1");
    await adapter.set("k", "v2");
    expect(await adapter.get("k")).toBe("v2");
  });
});
