import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/sdk", () => ({
  SPECIES_CONSTRAINTS: Object.freeze({
    MAX_AROUSAL: 0.35,
    SMILE_DELTA_MAX: 0.08,
    GLOW_DELTA_MAX: 0.99,
    DRIFT_VARIATION_MAX: 0.1,
  }),
}));

import { assertSpeciesIntegrity } from "../index";

describe("assertSpeciesIntegrity (tampered GLOW_DELTA_MAX)", () => {
  it("throws when GLOW_DELTA_MAX is tampered", () => {
    expect(() => assertSpeciesIntegrity()).toThrow("GLOW_DELTA_MAX has been tampered with");
  });
});
