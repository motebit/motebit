/**
 * Whose words a call runs — carried on the CALL PATH, never read from
 * ambient runtime state (#943 round 9).
 *
 * A runtime-wide "a foreign turn is in flight" flag, read by shared
 * backends, gave the OWNER's own concurrent calls (a completion, a
 * reflection, a recall tap) the stranger's treatment whenever a
 * customer's task happened to be running. Foreign-ness is a property of
 * a call path, like authority (see "brand types are forgeable"): it is
 * decided once at a turn's entry (`sendMessage*` from its
 * `foreignPrincipal` option, the approval resume from the paused record)
 * and then threaded explicitly — into the turn's loop deps, its
 * turn-scoped tool registry, its conversation view, its stream
 * processing, and every tool call it makes (`ToolCall.principal`). Owner
 * doors pass {@link TurnPrincipal.OWNER} (the registry default).
 *
 * Nominal (private constructor + private member): an object literal
 * `{ foreign: false }` is not a `TurnPrincipal`, so a call path cannot
 * mint the owner's principal from a shape.
 */
import { OWNER_ACT } from "./turn-delegation-receipts.js";
import type { ReceiptDestination } from "./turn-delegation-receipts.js";

export class TurnPrincipal {
  static readonly OWNER = new TurnPrincipal(false);
  static readonly FOREIGN = new TurnPrincipal(true);
  private readonly nominal = true;
  private constructor(readonly foreign: boolean) {
    void this.nominal;
  }
  /** The principal a turn entry decides from its own option. */
  static of(foreign: boolean): TurnPrincipal {
    return foreign ? TurnPrincipal.FOREIGN : TurnPrincipal.OWNER;
  }
}

/**
 * The context one tool call carries through every registry layer to the
 * handler: where a hire's receipt goes (#943) and whose call it is.
 */
export interface ToolCall {
  readonly destination: ReceiptDestination;
  readonly principal: TurnPrincipal;
  /**
   * The single-use money capability a gate-decided runtime path minted for
   * THIS call (name + exact args). Required by the runtime's registry for an
   * R4_MONEY tool; absent on every other call. See `money-capability.ts`.
   */
  readonly moneyCapability?: import("./money-capability.js").MoneyCapability;
}

/** Every caller that names no turn is an owner door. */
export const OWNER_CALL: ToolCall = Object.freeze({
  destination: OWNER_ACT,
  principal: TurnPrincipal.OWNER,
});

/** The fixed refusal a foreign call gets for an owner-connected / owner-interior tool. */
export function foreignLocalOnlyRefusal(toolName: string): string {
  return `Tool "${toolName}" acts for this motebit's owner and is not available to another principal's task`;
}
