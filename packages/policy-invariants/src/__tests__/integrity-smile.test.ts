import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/sdk", () => ({
  SPECIES_CONSTRAINTS: Object.freeze({
    MAX_AROUSAL: 0.35,
    SMILE_DELTA_MAX: 0.99,
    GLOW_DELTA_MAX: 0.15,
    DRIFT_VARIATION_MAX: 0.1,
  }),
}));

import { assertSpeciesIntegrity } from "../index";

describe("assertSpeciesIntegrity (tampered SMILE_DELTA_MAX)", () => {
  it("throws when SMILE_DELTA_MAX is tampered", () => {
    expect(() => assertSpeciesIntegrity()).toThrow("SMILE_DELTA_MAX has been tampered with");
  });
});
