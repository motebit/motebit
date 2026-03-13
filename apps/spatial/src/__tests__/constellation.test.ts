import { describe, it, expect, vi } from "vitest";
import { SpatialApp } from "../spatial-app";

// ---------------------------------------------------------------------------
// SpatialApp — basic lifecycle
// ---------------------------------------------------------------------------

describe("SpatialApp lifecycle", () => {
  it("dispose cleans up correctly", () => {
    const app = new SpatialApp();
    const disposeSpy = vi.spyOn(app.adapter, "dispose");
    app.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });
});
