/**
 * #654 cold review R2 — `motebitCloudAdmission`, the ONE Cloud admission
 * rule the proxy route and every client run. Item 6: the accepted-set check
 * must be load-bearing — a catalog whose alias table and accepted set
 * DISAGREE (an alias pointing outside the set) must refuse that alias, so
 * deleting the membership check turns this red.
 */
import { describe, it, expect } from "vitest";
import {
  MOTEBIT_CLOUD_ACCEPTED_MODELS,
  MOTEBIT_CLOUD_CATALOG,
  MOTEBIT_CLOUD_DEPOSIT_MODELS,
  MOTEBIT_CLOUD_FREE_CREDIT_MODELS,
  MOTEBIT_CLOUD_TOKEN_MODELS,
  MOTEBIT_CLOUD_MODEL_ALIASES,
  motebitCloudAdmission,
  motebitCloudAdmitsModel,
  providerAcceptsModel,
} from "../index";

describe("motebitCloudAdmission", () => {
  it("resolves every alias to an accepted id and admits it", () => {
    for (const [alias, target] of Object.entries(MOTEBIT_CLOUD_MODEL_ALIASES)) {
      expect(motebitCloudAdmission(alias), alias).toEqual({ admitted: true, resolved: target });
      expect((MOTEBIT_CLOUD_ACCEPTED_MODELS as readonly string[]).includes(target), target).toBe(
        true,
      );
    }
  });

  it("admits every id the relay mints for a paying account as itself, and auto", () => {
    for (const m of MOTEBIT_CLOUD_DEPOSIT_MODELS) {
      expect(motebitCloudAdmission(m)).toEqual({ admitted: true, resolved: m });
    }
    expect(motebitCloudAdmission("auto")).toEqual({ admitted: true, resolved: "auto" });
  });

  it("#654 R3: an accepted id no minted token names is refused (the proxy's 400)", () => {
    for (const m of ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"]) {
      expect((MOTEBIT_CLOUD_ACCEPTED_MODELS as readonly string[]).includes(m), m).toBe(true);
      for (const tier of ["deposit", "free-credit"] as const) {
        expect(motebitCloudAdmission(m, { tier }), `${tier}: ${m}`).toEqual({
          admitted: false,
          resolved: m,
          refusal: "token_model",
        });
      }
      // With no per-token list the catalog alone decides — the route's
      // reading of an empty list.
      expect(motebitCloudAdmission(m, { tokenModels: [] }).admitted, m).toBe(true);
    }
  });

  it("the free-credit tier refuses the frontier rows the deposit tier admits", () => {
    for (const m of ["claude-opus-4-6", "claude-opus", "gpt-5.4", "gemini-2.5-pro"]) {
      expect(motebitCloudAdmission(m).admitted, m).toBe(true);
      expect(motebitCloudAdmission(m, { tier: "free-credit" }).refusal, m).toBe("token_model");
    }
    // tokenModels overrides tier.
    expect(
      motebitCloudAdmission("claude-opus", {
        tier: "free-credit",
        tokenModels: ["claude-opus-4-6"],
      }).admitted,
    ).toBe(true);
  });

  it("minted lists: free ⊆ deposit ⊆ accepted, and the tier table is exactly the two lists", () => {
    const accepted = MOTEBIT_CLOUD_ACCEPTED_MODELS as readonly string[];
    const deposit = MOTEBIT_CLOUD_DEPOSIT_MODELS as readonly string[];
    for (const m of deposit) expect(accepted.includes(m), m).toBe(true);
    for (const m of MOTEBIT_CLOUD_FREE_CREDIT_MODELS) expect(deposit.includes(m), m).toBe(true);
    expect(MOTEBIT_CLOUD_TOKEN_MODELS.deposit).toBe(MOTEBIT_CLOUD_DEPOSIT_MODELS);
    expect(MOTEBIT_CLOUD_TOKEN_MODELS["free-credit"]).toBe(MOTEBIT_CLOUD_FREE_CREDIT_MODELS);
  });

  it("refuses non-strings, empty, unknown and near-miss ids (exact match, like the proxy)", () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      "",
      "claude-sonnet-5",
      " claude-opus",
      "CLAUDE-OPUS",
    ]) {
      expect(motebitCloudAdmission(bad).admitted, JSON.stringify(bad) ?? "undefined").toBe(false);
    }
  });

  it("prototype keys are ordinary unknown ids, never resolved through Object.prototype", () => {
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(motebitCloudAdmission(k)).toMatchObject({ admitted: false, resolved: k });
    }
  });

  it("the accepted-set check is load-bearing: an alias outside the set is refused", () => {
    const catalog = {
      aliases: { ...MOTEBIT_CLOUD_CATALOG.aliases, "claude-next": "claude-sonnet-5" },
      accepted: MOTEBIT_CLOUD_CATALOG.accepted,
    };
    // No token list, so only the accepted set can refuse it.
    expect(motebitCloudAdmission("claude-next", { catalog, tokenModels: [] })).toEqual({
      admitted: false,
      resolved: "claude-sonnet-5",
      refusal: "not_in_catalog",
    });
    // And an accepted set that drops an alias target refuses the alias too.
    const narrowed = {
      aliases: MOTEBIT_CLOUD_CATALOG.aliases,
      accepted: MOTEBIT_CLOUD_CATALOG.accepted.filter((m) => m !== "claude-opus-4-6"),
    };
    expect(motebitCloudAdmission("claude-opus", { catalog: narrowed }).admitted).toBe(false);
    expect(motebitCloudAdmission("claude-opus").admitted).toBe(true);
  });

  it("motebitCloudAdmitsModel and providerAcceptsModel('proxy') are the same verdict", () => {
    for (const m of [
      ...Object.keys(MOTEBIT_CLOUD_MODEL_ALIASES),
      ...MOTEBIT_CLOUD_ACCEPTED_MODELS,
      "auto",
      "claude-sonnet-5",
      "llama3.2:latest",
      "totally-unknown-model",
    ]) {
      const v = motebitCloudAdmission(m).admitted;
      expect(motebitCloudAdmitsModel(m), m).toBe(v);
      expect(providerAcceptsModel("proxy", m), m).toBe(v);
      expect(providerAcceptsModel("motebit-cloud", m), m).toBe(v);
    }
  });
});
