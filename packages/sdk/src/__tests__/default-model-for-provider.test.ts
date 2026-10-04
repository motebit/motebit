/**
 * #654 cold review C1/C2: the provider-switch default is ONE sdk function,
 * and its Cloud arm is a model Motebit Cloud admits — never the BYOK
 * Anthropic default (`claude-sonnet-5`), which the proxy refuses.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_PROXY_MODEL,
  MOTEBIT_CLOUD_ACCEPTED_MODELS,
  MOTEBIT_CLOUD_DEPOSIT_MODELS,
  PROXY_MODELS,
  defaultModelForProvider,
  defaultModelForVendor,
  motebitCloudAdmission,
  motebitCloudAdmitsModel,
  motebitCloudPickerModels,
  providerAcceptsModel,
  type ModelDefaultProvider,
} from "../index.js";

const ALL: readonly ModelDefaultProvider[] = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "deepseek",
  "local-server",
  "ollama",
  "proxy",
  "motebit-cloud",
];

describe("defaultModelForProvider", () => {
  it("Cloud (proxy / motebit-cloud) gets DEFAULT_PROXY_MODEL, which Cloud admits", () => {
    for (const p of ["proxy", "motebit-cloud"] as const) {
      const m = defaultModelForProvider(p);
      expect(m).toBe(DEFAULT_PROXY_MODEL);
      expect(motebitCloudAdmitsModel(m)).toBe(true);
    }
  });

  it("the BYOK Anthropic default is NOT a Cloud model (the lanes differ)", () => {
    expect(motebitCloudAdmitsModel(DEFAULT_ANTHROPIC_MODEL)).toBe(false);
    expect(defaultModelForProvider("proxy")).not.toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("BYOK vendors agree with defaultModelForVendor", () => {
    for (const v of ["anthropic", "openai", "google", "groq", "deepseek"] as const) {
      expect(defaultModelForProvider(v)).toBe(defaultModelForVendor(v));
    }
  });

  it("every provider's default is admissible for that provider", () => {
    for (const p of ALL) {
      const admitProvider = p === "motebit-cloud" ? "proxy" : p;
      expect(providerAcceptsModel(admitProvider, defaultModelForProvider(p))).toBe(true);
    }
  });

  it("motebitCloudAdmitsModel: auto + the paying-account token list, nothing else", () => {
    expect(motebitCloudAdmitsModel("auto")).toBe(true);
    for (const m of MOTEBIT_CLOUD_ACCEPTED_MODELS) {
      const minted = (MOTEBIT_CLOUD_DEPOSIT_MODELS as readonly string[]).includes(m);
      expect(motebitCloudAdmitsModel(m), m).toBe(minted);
    }
    // #654 R3: accepted by the catalog, named by no token the relay mints.
    expect(motebitCloudAdmitsModel("llama-3.3-70b-versatile")).toBe(false);
    expect(motebitCloudAdmitsModel("claude-sonnet-5")).toBe(false);
    expect(motebitCloudAdmitsModel("")).toBe(false);
  });

  it("PROXY_MODELS lists no id Motebit Cloud refuses for a paying account", () => {
    // Invariant (#654 cold review): the Cloud picker's display list never
    // offers a row the proxy refuses for the deposit tier — stale rows are
    // removed from PROXY_MODELS, never filtered silently forever.
    const refused = PROXY_MODELS.filter(
      (m) => !motebitCloudAdmission(m, { tier: "deposit" }).admitted,
    );
    expect(refused).toEqual([]);
  });

  it("motebitCloudPickerModels is PROXY_MODELS filtered by the admission rule, per tier", () => {
    for (const tier of ["deposit", "free-credit"] as const) {
      expect(motebitCloudPickerModels(tier)).toEqual(
        PROXY_MODELS.filter((m) => motebitCloudAdmission(m, { tier }).admitted),
      );
    }
    expect(motebitCloudPickerModels()).toEqual(motebitCloudPickerModels("deposit"));
    expect(motebitCloudPickerModels()).toEqual([...PROXY_MODELS]);
  });
});
