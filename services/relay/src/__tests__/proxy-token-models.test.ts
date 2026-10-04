/**
 * #654 cold review R3 — the relay mints a proxy token's model list from the
 * `@motebit/sdk` table every client admits through. A list inlined here again
 * (or an id added on one side only) turns this red.
 */
import { describe, it, expect } from "vitest";
import {
  MOTEBIT_CLOUD_DEPOSIT_MODELS,
  MOTEBIT_CLOUD_FREE_CREDIT_MODELS,
  motebitCloudAdmission,
} from "@motebit/sdk";
import { DEPOSIT_MODELS, FREE_CREDIT_MODELS, modelsForFunding } from "../proxy-token-models.js";

describe("relay-minted proxy-token model lists", () => {
  it("are exactly the sdk tables", () => {
    expect(modelsForFunding(true)).toEqual([...MOTEBIT_CLOUD_DEPOSIT_MODELS]);
    expect(modelsForFunding(false)).toEqual([...MOTEBIT_CLOUD_FREE_CREDIT_MODELS]);
    expect(DEPOSIT_MODELS).toBe(MOTEBIT_CLOUD_DEPOSIT_MODELS);
    expect(FREE_CREDIT_MODELS).toBe(MOTEBIT_CLOUD_FREE_CREDIT_MODELS);
  });

  it("every minted id is one the client admission admits for that tier", () => {
    for (const m of modelsForFunding(true)) {
      expect(motebitCloudAdmission(m, { tier: "deposit" }).admitted, m).toBe(true);
    }
    for (const m of modelsForFunding(false)) {
      expect(motebitCloudAdmission(m, { tier: "free-credit" }).admitted, m).toBe(true);
    }
  });

  it("returns a fresh array (a token's list is never the shared table)", () => {
    const a = modelsForFunding(true);
    a.push("mutated");
    expect(modelsForFunding(true)).not.toContain("mutated");
  });
});
