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
  PROXY_MODELS,
  defaultModelForProvider,
  defaultModelForVendor,
  motebitCloudAdmitsModel,
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

  it("motebitCloudAdmitsModel: auto + the accepted set, nothing else", () => {
    expect(motebitCloudAdmitsModel("auto")).toBe(true);
    for (const m of MOTEBIT_CLOUD_ACCEPTED_MODELS) expect(motebitCloudAdmitsModel(m)).toBe(true);
    expect(motebitCloudAdmitsModel("claude-sonnet-5")).toBe(false);
    expect(motebitCloudAdmitsModel("")).toBe(false);
  });

  it("names the known Cloud-picker drift: PROXY_MODELS rows the proxy refuses", () => {
    // Report-only pin (Cloud catalog is out of #654 scope): if this list
    // changes, the Cloud picker and the proxy were reconciled — update it.
    expect(PROXY_MODELS.filter((m) => !motebitCloudAdmitsModel(m))).toEqual(["claude-opus-4-7"]);
  });
});
