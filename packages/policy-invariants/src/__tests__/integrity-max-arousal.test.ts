import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/sdk", () => ({
  SPECIES_CONSTRAINTS: Object.freeze({
    MAX_AROUSAL: 0.99,
    SMILE_DELTA_MAX: 0.08,
    GLOW_DELTA_MAX: 0.15,
    DRIFT_VARIATION_MAX: 0.1,
  }),
}));

import { assertSpeciesIntegrity } from "../index";

describe("assertSpeciesIntegrity (tampered MAX_AROUSAL)", () => {
  it("throws when MAX_AROUSAL is tampered", () => {
    expect(() => assertSpeciesIntegrity()).toThrow("MAX_AROUSAL has been tampered with");
  });
});
