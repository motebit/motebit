/**
 * The runtime's ONE delegation relay binding (part 4a; design
 * runtime-relay-binding-design-2026-11-22 rev 6 §3.1).
 *
 * Before this, the relay a runtime delegates to was held in five places
 * that rebound differently — the delegation tools' closures and the
 * credential submitter, the task-query coordinates, the granted-spend
 * coordinates, the tap manager, and the hardware-attestation capabilities
 * fetcher a surface built over its bootstrap URL — so after a relay switch
 * or a Disconnect some calls still reached the old relay.
 *
 * Now the runtime holds one `RelayBinding`. Every call (one
 * `delegate_to_agent` / `discover_agents` / `retrieve_task_result` tool
 * execution, one tap, one granted spend, one result retrieval, one
 * credential submission) reads ONE snapshot of it when it starts, and
 * every request it sends with a token goes to that snapshot's relay. The
 * managers hold an accessor to the snapshot, never a relay URL, token
 * source or key of their own (`check-runtime-single-relay-binding`).
 *
 * The generation counts bindings that differ in what a pending approval
 * was decided under: the relay (by `sameRelay`), the pinned key, or which
 * paths are bound. An approved call carries the generation it was approved
 * under and is refused `relay_changed` if it no longer matches.
 */
import type { TokenAudience } from "@motebit/protocol";
import type { ApprovalRelayIdentity } from "@motebit/ai-core";
import { relayPinKey } from "./relay-key-pin.js";

export interface RelayBinding {
  /** The relay's base URL. */
  syncUrl: string;
  /** Mints an audience-scoped token for this relay. Called per request. */
  authToken: (audience?: TokenAudience) => Promise<string>;
  /**
   * The relay's Ed25519 public key (hex), PINNED for this relay. With a
   * sovereign wallet it enables paid P2P delegation (the fee-leg treasury
   * derives from it) and the granted-spend path. Absent ⇒ relay-mode only.
   */
  relayPublicKey?: string;
  /**
   * Cold-start opt-in to pay a no-history worker peer-to-peer. A function is
   * read fresh per call, so a live surface toggle takes effect without a
   * rebind.
   */
  acknowledgeNoHistoryRisk?: boolean | (() => boolean);
  routingStrategy?: "cost" | "quality" | "balanced";
  /** Per-call delegation timeout (ms). */
  timeoutMs?: number;
  /**
   * The AI-loop tools (`delegate_to_agent`, `discover_agents`,
   * `retrieve_task_result`) and credential submission.
   */
  tools: boolean;
  /** The deterministic tap path (`invokeCapability`). */
  invokeCapability: boolean;
}

/** One call's view of the binding: every field, plus the generation it carries. */
export type RelayBindingSnapshot = Readonly<RelayBinding> & { readonly generation: number };

/** What a manager holds instead of relay coordinates. */
export type RelayBindingSource = () => RelayBindingSnapshot | null;

/**
 * Relay equality: the same relay when both URLs have a pin key and the keys
 * are equal, or neither has one and the raw strings are equal.
 */
export function sameRelay(a: string, b: string): boolean {
  const ka = relayPinKey(a);
  const kb = relayPinKey(b);
  if (ka != null && kb != null) return ka === kb;
  if (ka == null && kb == null) return a === b;
  return false;
}

/**
 * Whether binding `next` must start a new generation after `prev`: the
 * relay, the pinned key, or a bound path changed. Token source,
 * acknowledgement, routing and timeout do not.
 */
export function startsNewGeneration(
  prev: RelayBindingSnapshot | null,
  next: RelayBinding,
): boolean {
  if (prev == null) return true;
  return (
    !sameRelay(prev.syncUrl, next.syncUrl) ||
    prev.relayPublicKey !== next.relayPublicKey ||
    prev.tools !== next.tools ||
    prev.invokeCapability !== next.invokeCapability
  );
}

/** The cold-start acknowledgement, resolved now. */
export function acknowledgementOf(binding: RelayBindingSnapshot): boolean | undefined {
  const ack = binding.acknowledgeNoHistoryRisk;
  return typeof ack === "function" ? ack() : ack;
}

/**
 * The tool result of an approved call whose binding changed between the
 * approval and its execution. Nothing was sent.
 */
export const RELAY_CHANGED_RESULT = {
  ok: false as const,
  error:
    "relay_changed — the relay this call was approved under is no longer the bound relay " +
    "(it was switched or disconnected after the approval). Nothing was sent. Ask the user to " +
    "approve it again if it is still wanted.",
};

/**
 * The refusals the runtime's own relay checks minted. Module-private: only
 * {@link relayChangedRefusal} adds to it, so a tool handler that returns the
 * same text (an MCP server's error passed through, say) is never mistaken
 * for one.
 */
const MINTED_REFUSALS = new WeakSet<object>();

/**
 * A fresh `relay_changed` refusal ({@link RELAY_CHANGED_RESULT}) marked as
 * the runtime's own. Returned by `invokeLocalTool`'s carried-approval check
 * and by the delegation handlers' generation check.
 */
export function relayChangedRefusal(): { ok: false; error: string } {
  const refusal = { ...RELAY_CHANGED_RESULT };
  MINTED_REFUSALS.add(refusal);
  return refusal;
}

/**
 * True only for a refusal {@link relayChangedRefusal} minted — by object
 * identity, never by its text. A handler cannot forge it.
 */
export function isRelayChangedResult(result: object): boolean {
  return MINTED_REFUSALS.has(result);
}

/**
 * True when a call approved under generation `approved` must not run under
 * `current` (a different generation, or no binding at all).
 */
export function approvalOutlivedBinding(
  approved: number | undefined,
  current: RelayBindingSnapshot | null,
): boolean {
  if (approved == null) return false;
  return current == null || current.generation !== approved;
}

/**
 * The relay identity an approval is decided under (`ApprovalRelayIdentity`):
 * the binding's pin key and its pinned public key, or null while unbound or
 * when the URL cannot be pinned (`relayPinKey` is null). Never a raw URL, so
 * two unpinnable URLs can never compare equal.
 */
export function relayIdentityOf(
  binding: RelayBindingSnapshot | null,
): ApprovalRelayIdentity | null {
  if (binding == null) return null;
  const pinKey = relayPinKey(binding.syncUrl);
  if (pinKey == null) return null;
  return { pinKey, publicKey: binding.relayPublicKey ?? null };
}

/**
 * True only when both identities are present and name the same relay: the
 * same pin key, and the same pinned public key or both null.
 */
export function sameRelayIdentity(
  a: ApprovalRelayIdentity | null | undefined,
  b: ApprovalRelayIdentity | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  return a.pinKey === b.pinKey && (a.publicKey ?? null) === (b.publicKey ?? null);
}
