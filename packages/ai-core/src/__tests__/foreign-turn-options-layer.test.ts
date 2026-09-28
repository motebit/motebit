/**
 * #943 — the OPTIONS floor on its own (`floorForeignTurnOptions`).
 *
 * The loop floors a foreign turn twice: its options (`floorForeignTurnOptions`)
 * and every pack it sends (`floorForeignContextPack`). A loop-level test with
 * both layers live cannot tell which one held. Here the PACK floor is
 * disabled (module mock → identity), so the owner options can only be kept
 * out of the provider's pack by the options floor.
 *
 * Tampers (each goes red): the loop reads `rawOptions` instead of the floored
 * `options`; `floorForeignTurnOptions` stops dropping a field; an owner field
 * is reclassified `turn_own` in `TURN_OPTION_FOREIGN_CLASS`.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../foreign-turn", async () => {
  const actual = await vi.importActual<typeof import("../foreign-turn")>("../foreign-turn");
  // Disable the PACK layer: only the options floor remains.
  return { ...actual, floorForeignContextPack: (pack: unknown) => pack };
});

import { runTurn } from "../loop";
import type { ContextPack } from "@motebit/sdk";
import {
  expectNoOwnerOptionFields,
  ownerOptions,
  recordingDeps,
} from "./foreign-turn-layers.fixture";

describe("#943 — the options floor alone keeps owner options out of a foreign pack", () => {
  it("with the pack floor disabled, no owner option reaches the provider", async () => {
    const contexts: ContextPack[] = [];
    await runTurn(recordingDeps(contexts), "hello", ownerOptions());
    expect(expectNoOwnerOptionFields(contexts[0])).toEqual([]);
  });
});
