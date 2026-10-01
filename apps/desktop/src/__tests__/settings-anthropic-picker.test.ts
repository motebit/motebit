/**
 * @vitest-environment jsdom
 *
 * #654 cold review C3 (desktop) + C2 (desktop Cloud lane). Mounts the REAL
 * index.html and the REAL `initSettings`, opens Settings, and reads what the
 * user would see:
 *
 *   - BYOK Anthropic: the model datalist is exactly ANTHROPIC_PICKER (ids +
 *     order), the empty field's placeholder is the default (empty ⇒ default
 *     runs), a stored claude-sonnet-4-6 shows in the field; the flat model
 *     select renders the same rows with the default / stored id selected.
 *   - Motebit Cloud: a fresh open pre-selects a model Motebit Cloud admits,
 *     and Save hands initAI that model.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_PICKER,
  DEFAULT_ANTHROPIC_MODEL,
  motebitCloudAdmission,
  motebitCloudAdmitsModel,
} from "@motebit/sdk";

vi.mock("../ui/chat", () => ({ addMessage: vi.fn() }));
vi.mock("../ui/mcp-connections", () => ({ getMcpServersConfig: vi.fn(() => []) }));
vi.mock("../ui/machines-section", () => ({ mountMachines: vi.fn() }));
vi.mock("../config-update", () => ({ updateConfig: vi.fn(async () => undefined) }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Settings = typeof import("../ui/settings");
let mod: Settings;

beforeAll(async () => {
  const html = fs.readFileSync(path.join(HERE, "../../index.html"), "utf8");
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1]!;
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");
  mod = await import("../ui/settings");
});

function stub(overrides: Record<string, unknown> = {}): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (typeof key === "string" && key in overrides) return overrides[key];
        if (key === "then") return undefined;
        if (key === "isOperatorMode") return false;
        if (key === "currentModel") return null;
        return vi.fn(() => undefined);
      },
    },
  );
}

interface Cfg {
  provider: string;
  model?: string;
  isTauri: boolean;
}

function mount(config: Cfg | null) {
  let current = config;
  const initAI = vi.fn(async () => true);
  const ctx = {
    app: stub({
      initAI,
      detectLocalInference: vi.fn(async () => ({ available: false, models: [] })),
    }),
    getConfig: () => current,
    setConfig: vi.fn((c: Cfg) => (current = c)),
  };
  const deps = { colorPicker: stub(), voice: stub(), pairing: stub() };
  const api = mod.initSettings(ctx as never, deps as never);
  api.open();
  return { api, initAI };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

describe("desktop Settings — Anthropic picker (C3)", () => {
  it("BYOK Anthropic: datalist rows are ANTHROPIC_PICKER, empty field = default", () => {
    mount({ provider: "anthropic", isTauri: false });
    const list = $<HTMLDataListElement>("settings-byok-models");
    expect(Array.from(list.options).map((o) => o.value)).toEqual(ANTHROPIC_PICKER.map((o) => o.id));
    expect(Array.from(list.options).map((o) => o.label)).toEqual(
      ANTHROPIC_PICKER.map((o) => o.label),
    );
    const field = $<HTMLInputElement>("settings-byok-model");
    expect(field.value).toBe("");
    expect(field.placeholder).toBe(DEFAULT_ANTHROPIC_MODEL);
    const flat = $<HTMLSelectElement>("settings-model-select");
    expect(Array.from(flat.options).map((o) => o.value)).toEqual(ANTHROPIC_PICKER.map((o) => o.id));
    expect(flat.value).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("a stored claude-sonnet-4-6 shows selected (never migrated)", () => {
    mount({ provider: "anthropic", model: "claude-sonnet-4-6", isTauri: false });
    expect($<HTMLInputElement>("settings-byok-model").value).toBe("claude-sonnet-4-6");
    const flat = $<HTMLSelectElement>("settings-model-select");
    expect(flat.value).toBe("claude-sonnet-4-6");
    expect(Array.from(flat.options).map((o) => o.value)).toEqual([
      "claude-sonnet-4-6",
      ...ANTHROPIC_PICKER.map((o) => o.id),
    ]);
  });
});

describe("desktop Settings — Motebit Cloud default (C2)", () => {
  it("fresh Cloud open pre-selects a model Motebit Cloud admits", () => {
    mount({ provider: "proxy", isTauri: false });
    expect(motebitCloudAdmitsModel($<HTMLSelectElement>("settings-cloud-model").value)).toBe(true);
  });

  it("no config at all (first run lands on Cloud) also pre-selects an admitted model", () => {
    mount(null);
    expect(motebitCloudAdmitsModel($<HTMLSelectElement>("settings-cloud-model").value)).toBe(true);
  });

  it("Save on Cloud hands initAI a model Motebit Cloud admits", async () => {
    const { initAI } = mount({ provider: "proxy", isTauri: false });
    $<HTMLButtonElement>("settings-save").click();
    await vi.waitFor(() => expect(initAI).toHaveBeenCalled());
    const cfg = (initAI.mock.calls.at(-1) as unknown as [Cfg])[0];
    expect(cfg.provider).toBe("proxy");
    expect(motebitCloudAdmitsModel(String(cfg.model))).toBe(true);
  });
});

// R2: a stored Cloud id the proxy serves — alias, legacy or outside the
// PROXY_MODELS picker — is shown selected and Saved verbatim, never migrated.
describe("desktop Settings — stored Cloud model is never rewritten (R2)", () => {
  it.each(["claude-opus-4-20250115", "claude-opus", "gpt-4o", "llama-3.3-70b-versatile", "auto"])(
    "%s: shown selected and saved verbatim",
    async (stored) => {
      expect(motebitCloudAdmission(stored).admitted).toBe(true);
      const { initAI } = mount({ provider: "proxy", model: stored, isTauri: false });
      expect($<HTMLSelectElement>("settings-cloud-model").value).toBe(stored);
      $<HTMLButtonElement>("settings-save").click();
      await vi.waitFor(() => expect(initAI).toHaveBeenCalled());
      const cfg = (initAI.mock.calls.at(-1) as unknown as [Cfg])[0];
      expect(cfg.model).toBe(stored);
    },
  );
});
