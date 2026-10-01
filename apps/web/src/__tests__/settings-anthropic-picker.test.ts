/**
 * @vitest-environment jsdom
 *
 * #654 cold review C3 (web) + C2 (web Cloud lane). Mounts the REAL
 * index.html and the REAL `initSettings`, opens Settings, and reads what the
 * user would see. index.html ships `<select id="anthropic-model">` EMPTY, so
 * reverting settings.ts's picker wiring leaves no options and this goes red.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_PICKER,
  DEFAULT_ANTHROPIC_MODEL,
  motebitCloudAdmitsModel,
  type UnifiedProviderConfig,
} from "@motebit/sdk";

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

const HERE = path.dirname(fileURLToPath(import.meta.url));

type Settings = typeof import("../ui/settings");
let mod: Settings;

beforeAll(async () => {
  const html = fs.readFileSync(path.join(HERE, "../../index.html"), "utf8");
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
    const html = fs.readFileSync(path.join(HERE, "../../index.html"), "utf8");
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
