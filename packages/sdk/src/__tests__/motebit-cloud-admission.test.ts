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

  it("admits accepted ids as themselves, and auto", () => {
    for (const m of MOTEBIT_CLOUD_ACCEPTED_MODELS) {
      expect(motebitCloudAdmission(m)).toEqual({ admitted: true, resolved: m });
    }
    expect(motebitCloudAdmission("auto")).toEqual({ admitted: true, resolved: "auto" });
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
      expect(motebitCloudAdmission(k)).toEqual({ admitted: false, resolved: k });
    }
  });

  it("the accepted-set check is load-bearing: an alias outside the set is refused", () => {
    const catalog = {
      aliases: { ...MOTEBIT_CLOUD_CATALOG.aliases, "claude-next": "claude-sonnet-5" },
      accepted: MOTEBIT_CLOUD_CATALOG.accepted,
    };
    expect(motebitCloudAdmission("claude-next", catalog)).toEqual({
      admitted: false,
      resolved: "claude-sonnet-5",
    });
    // And an accepted set that drops an alias target refuses the alias too.
    const narrowed = {
      aliases: MOTEBIT_CLOUD_CATALOG.aliases,
      accepted: MOTEBIT_CLOUD_CATALOG.accepted.filter((m) => m !== "claude-opus-4-6"),
    };
    expect(motebitCloudAdmission("claude-opus", narrowed).admitted).toBe(false);
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
