import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/sdk", () => ({
  SPECIES_CONSTRAINTS: Object.freeze({
    MAX_AROUSAL: 0.35,
    SMILE_DELTA_MAX: 0.08,
    GLOW_DELTA_MAX: 0.15,
    DRIFT_VARIATION_MAX: 0.99,
  }),
}));

import { assertSpeciesIntegrity } from "../index";

describe("assertSpeciesIntegrity (tampered DRIFT_VARIATION_MAX)", () => {
  it("throws when DRIFT_VARIATION_MAX is tampered", () => {
    expect(() => assertSpeciesIntegrity()).toThrow("DRIFT_VARIATION_MAX has been tampered with");
  });
});
