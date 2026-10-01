/**
 * #654 cold review C1/C2 — the proxy's own admission is the oracle.
 *
 * The surfaces derive the model they send to Motebit Cloud from
 * `@motebit/sdk` (`defaultModelForProvider("proxy")`, `motebitCloudAdmitsModel`,
 * `MOTEBIT_CLOUD_ACCEPTED_MODELS`). This file proves, against THIS service's
 * real validation functions, that (a) the sdk list is exactly what the proxy
 * admits — both directions — and (b) the sdk's Cloud default passes every
 * gate the metered route applies. The per-surface tests then only need to
 * show their path lands in that sdk set.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_PROXY_MODEL,
  MOTEBIT_CLOUD_ACCEPTED_MODELS,
  MOTEBIT_CLOUD_TOKEN_MODELS,
  defaultModelForProvider,
  motebitCloudAdmitsModel,
} from "@motebit/sdk";
import {
  calculateCostMicro,
  getModelHost,
  getSupportedModels,
  isModelAllowedInMotebitCloud,
  resolveModelAlias,
  validateModel,
} from "../validation.js";

/**
 * The route's proxy-token model gates, in order (route.ts): alias → the
 * token's model list (400) → 451 → host. The token carries the list the
 * relay mints for a paying account (#654 R3 — leaving the list out is how
 * clients came to admit the Groq rows the route refuses).
 */
function proxyAdmits(
  model: string,
  tokenModels: readonly string[] = MOTEBIT_CLOUD_TOKEN_MODELS.deposit,
): boolean {
  if (!validateModel(model, true).valid) return false;
  const resolved = resolveModelAlias(model);
  if (resolved === "auto") return true;
  if (tokenModels.length > 0 && !tokenModels.includes(resolved)) return false;
  return isModelAllowedInMotebitCloud(resolved) && getModelHost(resolved) != null;
}

describe("Motebit Cloud accepted set — sdk ⇔ proxy", () => {
  it("every sdk-accepted id is admitted by the proxy and priced", () => {
    for (const m of MOTEBIT_CLOUD_ACCEPTED_MODELS) {
      expect(proxyAdmits(m, []), m).toBe(true);
      expect(calculateCostMicro(m, 1000, 1000)).toBeGreaterThan(0);
    }
  });

  it("every model the proxy admits is in the sdk set (no silent widening)", () => {
    const admitted = getSupportedModels().filter((m) => isModelAllowedInMotebitCloud(m));
    expect([...admitted].sort()).toEqual([...MOTEBIT_CLOUD_ACCEPTED_MODELS].sort());
  });

  it("sdk motebitCloudAdmitsModel agrees with the proxy on the known catalog", () => {
    for (const m of [...getSupportedModels(), "auto", "claude-sonnet-5", "claude-opus-5-5"]) {
      expect(motebitCloudAdmitsModel(m), m).toBe(proxyAdmits(m));
    }
  });

  it("the sdk Cloud default passes the proxy; the BYOK Anthropic default does not", () => {
    expect(proxyAdmits(defaultModelForProvider("proxy"))).toBe(true);
    expect(proxyAdmits(DEFAULT_PROXY_MODEL)).toBe(true);
    // The C1/C2 regression: claude-sonnet-5 on the Cloud path → 451.
    expect(isModelAllowedInMotebitCloud(DEFAULT_ANTHROPIC_MODEL)).toBe(false);
  });
});
