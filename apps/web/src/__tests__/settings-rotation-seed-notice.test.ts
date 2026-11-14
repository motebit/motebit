/**
 * @vitest-environment jsdom
 *
 * A committed key rotation changes the recovery seed (the seed IS the key).
 * Mounts the REAL index.html and the REAL `initSettings`, clicks Rotate Key,
 * and reads what the owner is told: the seed notice, once, only when the
 * rotation committed — never on a failed or refused rotation.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { ROTATION_SEED_BACKUP_NOTICE } from "@motebit/surface-kit";

const NODE_FS = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (p: string, enc: "utf8") => string;
};
const readRel = (rel: string): string =>
  readFileSync(decodeURIComponent(new URL(rel, import.meta.url).pathname), "utf8");

const { addMessage } = vi.hoisted(() => ({ addMessage: vi.fn() }));
vi.mock("../main", () => ({ rebuildTTSProvider: vi.fn() }));
vi.mock("../ui/chat", () => ({ setTTSVoice: vi.fn(), addMessage }));
vi.mock("../providers", () => ({
  checkWebGPU: vi.fn(async () => false),
  WebLLMProvider: class {},
  DEFAULT_OLLAMA_URL: "http://localhost:11434",
}));
vi.mock("../bootstrap", () => ({
  detectLocalInference: vi.fn(async () => null),
  probeLocalModels: vi.fn(async () => []),
  DEFAULT_LOCAL_ENDPOINTS: [],
}));
vi.mock("../ui/machines-section", () => ({ mountMachines: vi.fn() }));

type Settings = typeof import("../ui/settings");
let mod: Settings;

const html = readRel("../../index.html");
const body = /<body[^>]*>([\s\S]*)<\/body>/i
  .exec(html)![1]!
  .replace(/<script[\s\S]*?<\/script>/gi, "");

beforeAll(async () => {
  document.body.innerHTML = body;
  mod = await import("../ui/settings");
});

beforeEach(() => {
  // Fresh elements per test: each mount wires its own listeners.
  document.body.innerHTML = body;
  addMessage.mockClear();
  window.confirm = vi.fn(() => true);
});

function stubApp(rotateKey: () => Promise<unknown>): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "rotateKey") return rotateKey;
        if (key === "isOperatorMode" || key === "isProviderConnected") return false;
        if (key === "currentModel" || key === "syncStatus") return null;
        if (key === "machineRoster") return () => null;
        if (key === "motebitId" || key === "deviceId" || key === "publicKeyHex") return "";
        return vi.fn(() => undefined);
      },
    },
  );
}

function mount(rotateKey: () => Promise<unknown>) {
  const showToast = vi.fn();
  const ctx = {
    app: stubApp(rotateKey),
    getConfig: () => null,
    setConfig: vi.fn(),
    showToast,
  };
  const colorPicker = new Proxy({}, { get: () => vi.fn(() => 0) });
  mod.initSettings(ctx as never, { colorPicker } as never);
  return { showToast };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("web Settings — Rotate Key tells the owner the seed changed", () => {
  it("a committed rotation says the seed notice, once", async () => {
    const { showToast } = mount(async () => ({ newPublicKey: "ab".repeat(32) }));
    (document.getElementById("settings-rotate-key") as HTMLButtonElement).click();
    await settle();
    expect(showToast.mock.calls).toEqual([]);
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage).toHaveBeenCalledWith("system", ROTATION_SEED_BACKUP_NOTICE);
  });

  it("a failed rotation (the old key stays) says nothing about the seed", async () => {
    const { showToast } = mount(async () => {
      throw new Error("the relay refused the rotation");
    });
    (document.getElementById("settings-rotate-key") as HTMLButtonElement).click();
    await settle();
    expect(addMessage).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Key rotation failed"));
  });
});
