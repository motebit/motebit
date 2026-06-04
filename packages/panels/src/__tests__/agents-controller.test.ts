import { describe, it, expect } from "vitest";
import { shortMotebitId, agentDisplayLabel } from "../agents/controller.js";

const UUID = "019d6828-969e-7e9b-baa2-481ece0f80c2";

describe("shortMotebitId", () => {
  it("shortens a motebit_id to head…tail", () => {
    expect(shortMotebitId(UUID)).toBe("019d6828…0f80c2");
  });

  it("honors custom head/tail widths", () => {
    expect(shortMotebitId(UUID, 4, 4)).toBe("019d…80c2");
  });

  it("returns short strings unchanged (no … when it wouldn't shorten)", () => {
    expect(shortMotebitId("abc")).toBe("abc");
    expect(shortMotebitId("0123456789")).toBe("0123456789"); // 10 ≤ 8+6+1
  });
});

describe("agentDisplayLabel", () => {
  it("prefers a petname when set (Known tab)", () => {
    expect(agentDisplayLabel({ remote_motebit_id: UUID, petname: "Scout" })).toBe("Scout");
  });

  it("falls back to the short id when no petname (Known)", () => {
    expect(agentDisplayLabel({ remote_motebit_id: UUID })).toBe(shortMotebitId(UUID));
  });

  it("uses motebit_id for discovered agents (no petname there)", () => {
    expect(agentDisplayLabel({ motebit_id: UUID })).toBe(shortMotebitId(UUID));
  });

  it("treats an empty petname as unset", () => {
    expect(agentDisplayLabel({ remote_motebit_id: UUID, petname: "" })).toBe(shortMotebitId(UUID));
  });

  it("returns an empty string when no id is present (defensive)", () => {
    expect(agentDisplayLabel({})).toBe("");
  });
});
