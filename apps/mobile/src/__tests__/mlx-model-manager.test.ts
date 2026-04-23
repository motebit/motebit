import { describe, it, expect, vi, beforeEach } from "vitest";

const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(asyncStoreData.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      asyncStoreData.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      asyncStoreData.delete(key);
      return Promise.resolve();
    }),
  },
}));

const hoisted = vi.hoisted(() => {
  const state = { shouldFail: false };
  const createDownloadResumableSpy = vi.fn(
    (
      _url: string,
      dest: string,
      _opts: unknown,
      progressCb?: (p: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void,
    ) => ({
      downloadAsync: vi.fn(async () => {
        progressCb?.({ totalBytesWritten: 100, totalBytesExpectedToWrite: 100 });
        if (state.shouldFail) return null;
        return { uri: dest };
      }),
    }),
  );
  return { state, createDownloadResumableSpy };
});
const createDownloadResumableSpy = hoisted.createDownloadResumableSpy;

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///var/docs/",
  makeDirectoryAsync: vi.fn(() => Promise.resolve()),
  deleteAsync: vi.fn(() => Promise.resolve()),
  createDownloadResumable: hoisted.createDownloadResumableSpy,
}));

import {
  DEFAULT_MLX_MODEL,
  getDownloadedModels,
  getModelPath,
  downloadModel,
  deleteModel,
} from "../adapters/mlx-model-manager";

beforeEach(() => {
  asyncStoreData.clear();
  hoisted.state.shouldFail = false;
  createDownloadResumableSpy.mockClear();
});

describe("mlx-model-manager", () => {
  it("DEFAULT_MLX_MODEL is set", () => {
    expect(DEFAULT_MLX_MODEL).toBeTruthy();
  });

  it("getDownloadedModels returns [] when storage empty", async () => {
    expect(await getDownloadedModels()).toEqual([]);
  });

  it("getModelPath returns null when not present", async () => {
    expect(await getModelPath("some-model")).toBeNull();
  });

  it("downloadModel downloads all files and marks ready", async () => {
    const progressUpdates: number[] = [];
    const path = await downloadModel("my/model", (p) => progressUpdates.push(p));
    expect(path).toContain("my--model");
    expect(createDownloadResumableSpy).toHaveBeenCalledTimes(4);
    expect(progressUpdates.length).toBeGreaterThan(0);
    const ready = await getDownloadedModels();
    expect(ready).toHaveLength(1);
    expect(ready[0]?.status).toBe("ready");
  });

  it("getModelPath returns the path after download", async () => {
    await downloadModel("some/model");
    const p = await getModelPath("some/model");
    expect(p).toContain("some--model");
  });

  it("downloadModel throws on file download failure", async () => {
    hoisted.state.shouldFail = true;
    await expect(downloadModel("bad/model")).rejects.toThrow(/Failed to download/);
    // State should be marked as error
    const ready = await getDownloadedModels();
    expect(ready.filter((s) => s.modelId === "bad/model")).toHaveLength(0);
  });

  it("deleteModel removes the entry", async () => {
    await downloadModel("del/model");
    await deleteModel("del/model");
    expect(await getModelPath("del/model")).toBeNull();
  });

  it("deleteModel on non-existent model does not throw", async () => {
    await deleteModel("nonexistent");
  });
});
