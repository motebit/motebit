/**
 * @vitest-environment jsdom
 *
 * #654 cold review C3 (spatial) + C2 (spatial Cloud lane). Boots the REAL
 * `app.ts` entry against the REAL index.html (only the WebXR/three.js kernel
 * and its satellites are stubbed) and drives the settings form:
 *
 *   - BYOK Anthropic: the model field's datalist is exactly ANTHROPIC_PICKER
 *     (ids + order); the empty field means the default, named in the
 *     placeholder; a stored claude-sonnet-4-6 loads into the field untouched.
 *   - Motebit Cloud: an id picked under BYOK does not ride a mode flip onto
 *     Cloud — Save hands initAI a config whose resolved model Motebit Cloud
 *     admits.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  ANTHROPIC_PICKER,
  DEFAULT_ANTHROPIC_MODEL,
  motebitCloudAdmission,
  motebitCloudAdmitsModel,
  resolveProviderSpec,
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

const initAI = vi.fn(async (_cfg: { provider: UnifiedProviderConfig }) => false);

/** A callable, infinitely-deep no-op: any property or call yields another
 *  stub (never a thenable), so the kernel's wiring calls are inert. */
function stubObj(): unknown {
  const fn = (): unknown => stubObj();
  return new Proxy(fn, {
    get: (_t, key) =>
      key === "then" ? undefined : key === Symbol.toPrimitive ? () => "" : stubObj(),
    apply: () => stubObj(),
  });
}
class StubClass {
  constructor() {
    return new Proxy(this, {
      get: (_t, key) => {
        if (key === "then") return undefined;
        if (key === "initAI") return initAI;
        if (key === "bootstrap") return async () => ({ isFirstLaunch: false });
        return stubObj();
      },
    });
  }
  static isSupported(): boolean {
    return false;
  }
}

vi.mock("../spatial-app", () => ({
  SpatialApp: StubClass,
  COLOR_PRESETS: {},
  deriveInteriorColor: () => ({ r: 0, g: 0, b: 0 }),
}));
vi.mock("@motebit/render-engine", () => ({
  WebXRThreeJSAdapter: StubClass,
  TrustConstellationCoordinator: StubClass,
  MemoryEnvironmentCoordinator: StubClass,
  AccrualSatelliteCoordinator: StubClass,
}));
vi.mock("../voice-pipeline", () => ({ SpatialVoicePipeline: StubClass }));
vi.mock("../hud", () => ({ bindHud: () => stubObj() }));
vi.mock("../receipt-satellites", () => ({ ReceiptSatelliteCoordinator: StubClass }));

const STORAGE_KEY = "motebit:spatial_settings";

async function boot(stored: Record<string, unknown> | null): Promise<void> {
  vi.resetModules();
  initAI.mockClear();
  localStorage.clear();
  if (stored) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  const html = readRel("../../index.html");
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1]!;
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");
  await import("../app");
  // init() is async (bootstrap → tryInitAI); wait until the form is filled.
  await vi.waitFor(() => expect(initAI).toHaveBeenCalled());
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function choose(name: string, value: string): void {
  const r = document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;
  r.checked = true;
  r.dispatchEvent(new Event("change"));
}

function resolvedModel(cfg: UnifiedProviderConfig): string | undefined {
  const spec = resolveProviderSpec(cfg, {
    cloudBaseUrl: (_w, c) => c,
    defaultLocalServerUrl: "http://localhost:11434",
    supportedBackends: new Set(["local-server", "webllm"]),
  });
  return "model" in spec ? spec.model : undefined;
}

beforeAll(() => {
  if (typeof globalThis.matchMedia !== "function") {
    globalThis.matchMedia = (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as never;
  }
});

describe("spatial Settings — Anthropic picker (C3)", () => {
  it("BYOK Anthropic: datalist is ANTHROPIC_PICKER, placeholder names the default", async () => {
    await boot(null);
    choose("provider-mode", "byok");
    choose("byok-vendor", "anthropic");
    const list = $<HTMLDataListElement>("model-suggestions");
    expect(Array.from(list.options).map((o) => o.value)).toEqual(ANTHROPIC_PICKER.map((o) => o.id));
    expect(Array.from(list.options).map((o) => o.label)).toEqual(
      ANTHROPIC_PICKER.map((o) => o.label),
    );
    expect($<HTMLInputElement>("model-input").placeholder).toContain(DEFAULT_ANTHROPIC_MODEL);
  });

  it("a stored claude-sonnet-4-6 (BYOK Anthropic) loads into the field untouched", async () => {
    await boot({
      mode: "byok",
      byokVendor: "anthropic",
      apiKey: "sk-ant",
      model: "claude-sonnet-4-6",
    });
    expect($<HTMLInputElement>("model-input").value).toBe("claude-sonnet-4-6");
    expect(resolvedModel(initAI.mock.calls[0]![0].provider)).toBe("claude-sonnet-4-6");
  });
});

describe("spatial Settings — Motebit Cloud (C2)", () => {
  it("an id picked under BYOK does not ride a flip onto Cloud", async () => {
    await boot(null);
    choose("provider-mode", "byok");
    choose("byok-vendor", "anthropic");
    $<HTMLInputElement>("model-input").value = DEFAULT_ANTHROPIC_MODEL;
    choose("provider-mode", "motebit-cloud");
    initAI.mockClear();
    $<HTMLButtonElement>("settings-save").click();
    await vi.waitFor(() => expect(initAI).toHaveBeenCalled());
    const cfg = initAI.mock.calls.at(-1)![0].provider;
    expect(cfg.mode).toBe("motebit-cloud");
    expect(motebitCloudAdmitsModel(String(resolvedModel(cfg)))).toBe(true);
  });

  it("fresh Cloud boot resolves to a model Motebit Cloud admits", async () => {
    await boot(null);
    const cfg = initAI.mock.calls[0]![0].provider;
    expect(cfg.mode).toBe("motebit-cloud");
    expect(motebitCloudAdmitsModel(String(resolvedModel(cfg)))).toBe(true);
  });
});

// R2: the Cloud lane's sanitizer is the proxy's own admission. A stored id
// the proxy serves — alias or legacy included — survives boot AND the next
// Save; the old accepted-set-only check cleared these at boot and Save
// persisted the downgrade.
describe("spatial Settings — stored Cloud model is never rewritten (R2)", () => {
  for (const stored of [
    "claude-opus-4-20250115",
    "claude-opus",
    "gpt-4o",
    "gemini-flash",
    "llama-3.3-70b-versatile",
    "claude-sonnet-4-6",
  ]) {
    it(`${stored}: kept through boot and Save`, async () => {
      expect(motebitCloudAdmission(stored).admitted).toBe(true);
      await boot({ mode: "motebit-cloud", model: stored });
      expect($<HTMLInputElement>("model-input").value).toBe(stored);
      expect(resolvedModel(initAI.mock.calls[0]![0].provider)).toBe(stored);
      initAI.mockClear();
      $<HTMLButtonElement>("settings-save").click();
      await vi.waitFor(() => expect(initAI).toHaveBeenCalled());
      expect(resolvedModel(initAI.mock.calls.at(-1)![0].provider)).toBe(stored);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).model).toBe(stored);
    });
  }

  it("a stored id the proxy refuses is cleared to the Cloud default", async () => {
    await boot({ mode: "motebit-cloud", model: "claude-sonnet-5" });
    expect($<HTMLInputElement>("model-input").value).toBe("");
  });
});
