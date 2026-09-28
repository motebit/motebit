/**
 * Sovereign pay-forward (settlement spec §9.1) is OFF (#887).
 *
 * The pay-forward adapter pays a worker onchain BEFORE presenting the task.
 * A worker that admits work only through its relay (`taskAdmission: "relay"`,
 * the default for every priced `molecule-runner` listing — see
 * docs/doctrine/task-admission.md) refuses a pay-forward task after the
 * money has moved, and no client can tell such a worker apart beforehand:
 * the admission mode is private worker config, published in no listing, no
 * discovery record, and no MCP tool schema.
 *
 * Until a worker's admission mode is discoverable, both entry points —
 * `MotebitRuntime.createSovereignDelegationAdapter` and the CLI's
 * `delegate --plan --sovereign` — refuse before any discovery or payment.
 * The adapter itself (`@motebit/planner`'s `SovereignDelegationAdapter`,
 * with #887's exactly-once logic) stays functional and tested behind this
 * gate, so re-enabling is this one constant.
 *
 * Deliberately no config or env override: an owner cannot opt into paying
 * workers that will refuse the work.
 */
export const SOVEREIGN_PAY_FORWARD_ENABLED: boolean = false;

export const SOVEREIGN_PAY_FORWARD_DISABLED_MESSAGE =
  "Sovereign pay-forward is disabled: a worker's admission mode isn't discoverable yet, and " +
  "relay-admitted workers refuse pay-forward after payment. Use relay-mediated P2P delegation " +
  "(the default).";

/** Thrown by `createSovereignDelegationAdapter` while pay-forward is disabled. */
export class SovereignPayForwardDisabledError extends Error {
  constructor() {
    super(SOVEREIGN_PAY_FORWARD_DISABLED_MESSAGE);
    this.name = "SovereignPayForwardDisabledError";
  }
}
