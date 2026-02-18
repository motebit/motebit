import { describe, it, expect, beforeEach } from "vitest";
import { LocalStorageStateSnapshot } from "../state-snapshot.js";

// Minimal localStorage mock for Node
const localStore = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (key: string) => localStore.get(key) ?? null,
  setItem: (key: string, value: string) => { localStore.set(key, value); },
  removeItem: (key: string) => { localStore.delete(key); },
  clear: () => localStore.clear(),
  get length() { return localStore.size; },
  key: (_index: number) => null,
};

// Install mock
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: true });

describe("LocalStorageStateSnapshot", () => {
  let snapshot: LocalStorageStateSnapshot;

  beforeEach(() => {
    localStore.clear();
    snapshot = new LocalStorageStateSnapshot();
  });

  it("saves and loads state", () => {
    const stateJson = JSON.stringify({ attention: 0.5, processing: 0.2 });
    snapshot.saveState("mote-1", stateJson);
    const loaded = snapshot.loadState("mote-1");
    expect(loaded).toBe(stateJson);
  });

  it("returns null for missing state", () => {
    const loaded = snapshot.loadState("mote-missing");
    expect(loaded).toBeNull();
  });

  it("persists version clock", () => {
    snapshot.saveState("mote-1", "{}", 42);
    const clock = snapshot.getSnapshotClock!("mote-1");
    expect(clock).toBe(42);
  });

  it("returns 0 for missing clock", () => {
    const clock = snapshot.getSnapshotClock!("mote-missing");
    expect(clock).toBe(0);
  });

  it("overwrites state on subsequent save", () => {
    snapshot.saveState("mote-1", "first");
    snapshot.saveState("mote-1", "second");
    expect(snapshot.loadState("mote-1")).toBe("second");
  });

  it("isolates state by motebit_id", () => {
    snapshot.saveState("mote-1", "state-1");
    snapshot.saveState("mote-2", "state-2");
    expect(snapshot.loadState("mote-1")).toBe("state-1");
    expect(snapshot.loadState("mote-2")).toBe("state-2");
  });
});
