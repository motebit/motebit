/**
 * @vitest-environment jsdom
 *
 * #654 cold review C3 (web) + C2 (web Cloud lane). Mounts the REAL
 * index.html and the REAL `initSettings`, opens Settings, and reads what the
 * user would see. index.html ships `<select id="anthropic-model">` EMPTY, so
 * reverting settings.ts's picker wiring leaves no options and this goes red.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  ANTHROPIC_PICKER,
  DEFAULT_ANTHROPIC_MODEL,
  motebitCloudAdmission,
  motebitCloudAdmitsModel,
  type UnifiedProviderConfig,
} from "@motebit/sdk";

// The app tsconfig carries no Node types (browser / React Native target), so
// the Node built-in is loaded through a non-literal specifier (the pattern
// expo-sqlite-sync-cursor.test.ts uses).
const NODE_FS = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (p: string, enc: "utf8") => string;
};
/** Read a file relative to this test file. */
const readRel = (rel: string): string =>
  readFileSync(decodeURIComponent(new URL(rel, import.meta.url).pathname), "utf8");

// settings.ts imports the app entry (main.ts boots the whole app) and a few
// browser-only modules; stub only those — the settings module itself is real.
vi.mock("../main", () => ({ rebuildTTSProvider: vi.fn() }));
vi.mock("../ui/chat", () => ({ setTTSVoice: vi.fn() }));
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

beforeAll(async () => {
  const html = readRel("../../index.html");
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1]!;
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");
  mod = await import("../ui/settings");
});

/** Any property is a no-op function; reads of known state return safe values. */
function stubApp(): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "isOperatorMode" || key === "isProviderConnected") return false;
        if (key === "currentModel" || key === "syncStatus") return null;
        if (key === "machineRoster") return undefined;
        if (key === "motebitId" || key === "deviceId" || key === "publicKeyHex") return "";
        return vi.fn(() => undefined);
      },
    },
  );
}

function mount(config: UnifiedProviderConfig | null) {
  let current = config;
  const setConfig = vi.fn((c: UnifiedProviderConfig) => (current = c));
  const ctx = {
    app: stubApp(),
    getConfig: () => current,
    setConfig,
    showToast: vi.fn(),
  };
  const colorPicker = new Proxy({}, { get: () => vi.fn(() => 0) });
  const api = mod.initSettings(ctx as never, { colorPicker } as never);
  api.open();
  return { api, setConfig };
}

function anthropicSelect(): HTMLSelectElement {
  return document.getElementById("anthropic-model") as HTMLSelectElement;
}

describe("web Settings — Anthropic picker (C3)", () => {
  it("index.html ships the select empty (the rows can only come from the sdk)", () => {
    const html = readRel("../../index.html");
    expect(html).toMatch(/<select id="anthropic-model"><\/select>/);
  });

  it("fresh install: ANTHROPIC_PICKER rows, in order, default selected", () => {
    mount(null);
    const sel = anthropicSelect();
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(ANTHROPIC_PICKER.map((o) => o.id));
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(
      ANTHROPIC_PICKER.map((o) => o.label),
    );
    expect(sel.value).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("a stored claude-sonnet-4-6 shows selected (never migrated)", () => {
    mount({ mode: "byok", vendor: "anthropic", apiKey: "sk-ant-x", model: "claude-sonnet-4-6" });
    const sel = anthropicSelect();
    expect(sel.value).toBe("claude-sonnet-4-6");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual([
      "claude-sonnet-4-6",
      ...ANTHROPIC_PICKER.map((o) => o.id),
    ]);
  });
});

describe("web Settings — Motebit Cloud save (C2)", () => {
  it("saving on the Cloud tab sends a model Motebit Cloud admits", () => {
    const { setConfig } = mount({ mode: "motebit-cloud" });
    (document.getElementById("settings-save") as HTMLButtonElement).click();
    const saved = setConfig.mock.calls.at(-1)?.[0];
    expect(saved?.mode).toBe("motebit-cloud");
    expect(motebitCloudAdmitsModel(String((saved as { model?: string }).model))).toBe(true);
  });
});

// R2: a stored Cloud id the proxy serves but the hard-coded <select> has no
// <option> for used to leave NOTHING selected — the next Save persisted "".
describe("web Settings — stored Cloud model is never rewritten (R2)", () => {
  it.each([
    "claude-sonnet-4-6",
    "claude-opus-4-20250115",
    "claude-opus",
    "gpt-4o",
    "gemini-flash",
    "auto",
  ])("%s: shown selected and saved verbatim", (stored) => {
    expect(motebitCloudAdmission(stored).admitted).toBe(true);
    const { setConfig } = mount({ mode: "motebit-cloud", model: stored });
    const sel = document.getElementById("cloud-model") as HTMLSelectElement;
    expect(sel.value).toBe(stored);
    (document.getElementById("settings-save") as HTMLButtonElement).click();
    expect((setConfig.mock.calls.at(-1)?.[0] as { model?: string }).model).toBe(stored);
  });
});

// The same boot-time clearing on the BYOK vendor selects: assigning
// `select.value` to a stored id with no <option> (a Gemma on Google, a model
// newer than the hard-coded list) left nothing selected, and the next Save
// silently swapped in another model. The stored id is shown and kept.
describe("web Settings — stored BYOK model is never rewritten", () => {
  it.each([
    ["google", "gemma-3-27b-it"],
    ["openai", "gpt-5-mini"],
    ["groq", "qwen/qwen3-32b"],
    ["deepseek", "deepseek-reasoner-x"],
  ] as const)("%s + %s: shown selected and saved verbatim", (vendor, stored) => {
    const { setConfig } = mount({ mode: "byok", vendor, apiKey: "k", model: stored });
    const sel = document.getElementById(`${vendor}-model`) as HTMLSelectElement;
    expect(sel.value).toBe(stored);
    (document.getElementById("settings-save") as HTMLButtonElement).click();
    const saved = setConfig.mock.calls.at(-1)?.[0] as { vendor?: string; model?: string };
    expect(saved.vendor).toBe(vendor);
    expect(saved.model).toBe(stored);
  });
});
