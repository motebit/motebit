/**
 * Drop dispatcher — translates typed `DropPayload` (the protocol-layer
 * substrate for direct-gesture content delivery) into slab events. The
 * runtime exposes `feedPerception(payload)` as the canonical entry
 * point; surfaces that capture drag-drop / pinch-throw / share-sheet
 * gestures call it with the classified payload.
 *
 * Two-level pattern. The categorical drop kinds are closed at the
 * protocol layer (`DropPayloadKind` union — `url | text | image |
 * file | artifact`). Handlers within those kinds are open here:
 * `registerHandler(kind, handler)` replaces the v1 default, allowing
 * surfaces or future extension packages to specialize per-MIME or
 * per-source without modifying the protocol or runtime core.
 *
 * v1 ships handlers for `url`, `text`, and `image` — the high-frequency
 * intent shapes. `file` and `artifact` sit on the deferred allowlist;
 * registering a handler for either is opt-in until the broader UX
 * lands. The drift gate `check-drop-handlers` enforces this: every
 * `DropPayloadKind` either has a registered handler OR an explicit
 * allowlist entry naming the deferral reason.
 *
 * Doctrine: `motebit-computer.md` §"Supervised agency / minimum
 * gesture set" names the drop gestures; `liquescentia-as-substrate.md`
 * §"Cohesive permeability" frames the policy gate as the surface-
 * tension membrane drops cross.
 */

import { type DropPayload, type DropPayloadKind, SensitivityLevel } from "@motebit/sdk";
import { scanText, type SensitivityLevel as ScanLevel } from "@motebit/policy-invariants";
import type { SlabController } from "./slab-controller.js";

/**
 * Convert the string-union sensitivity level emitted by `scanText`
 * into the protocol's `SensitivityLevel` enum. The string values are
 * identical (`"none" | "personal" | ...`), but TS treats the enum as
 * nominal so the conversion is explicit.
 */
function toSensitivityEnum(level: ScanLevel): SensitivityLevel {
  switch (level) {
    case "none":
      return SensitivityLevel.None;
    case "personal":
      return SensitivityLevel.Personal;
    case "medical":
      return SensitivityLevel.Medical;
    case "financial":
      return SensitivityLevel.Financial;
    case "secret":
      return SensitivityLevel.Secret;
  }
}

/**
 * Bounded preview length when classifying tool results. Tools can
 * return arbitrarily large payloads (a multi-MB scrape, a binary
 * file, a paginated result set); running `scanText` over the entire
 * blob is unbounded runtime cost. Cap the classified window so the
 * classifier's hot path stays predictable.
 *
 * **The preview cap bounds runtime cost. It is not a proof the
 * remainder is clean.** Secrets can appear after 64 KB in scraped
 * pages, server logs, paginated responses, JSON payloads with deep
 * nesting. Large-result handling that scans the full payload (or
 * uses parser-aware / pagination-aware / OCR classification) is a
 * later pass. Today the contract is: this function inspected the
 * preview window; the rest is unscanned.
 */
const TOOL_RESULT_CLASSIFY_PREVIEW_BYTES = 64 * 1024; // 64 KB

/**
 * Extract a classifiable string from an arbitrary tool result. Tool
 * outputs come in many shapes — strings, JSON, arrays of records,
 * markdown, HTML, binary references — and the canonical sensitivity
 * classifier (`scanText`) only consumes plain text. This helper
 * normalizes:
 *
 *   - `string` → passed through (truncated to the preview cap)
 *   - `null` / `undefined` → empty string (classifier yields none)
 *   - `Uint8Array` / `ArrayBuffer` → empty string. Binary content
 *     needs OCR / parsing to inspect; pretending `scanText` saw it
 *     would be false confidence. The slab item leaves sensitivity
 *     undefined, signaling "unscanned" rather than "clean."
 *   - any other shape → `JSON.stringify` (truncated). Catches
 *     structured records (search results, parsed JSON responses,
 *     plan steps) where the embedded strings are what classification
 *     cares about.
 *
 * Bounded preview keeps the classifier's hot path predictable. The
 * preview window is `TOOL_RESULT_CLASSIFY_PREVIEW_BYTES` (64 KB).
 */
export function extractClassifiableText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") {
    return result.length <= TOOL_RESULT_CLASSIFY_PREVIEW_BYTES
      ? result
      : result.slice(0, TOOL_RESULT_CLASSIFY_PREVIEW_BYTES);
  }
  if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
    // Binary — leave classification undefined rather than mislead.
    // OCR / parser paths land in v1.1.
    return "";
  }
  // Structured data — walk via JSON to catch embedded strings. JSON
  // serialization can throw on circular references; on failure,
  // return empty (conservative — the item won't get tagged, the gate
  // won't compose this item, but the runtime stays honest about not
  // having seen the bytes).
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) return "";
    return serialized.length <= TOOL_RESULT_CLASSIFY_PREVIEW_BYTES
      ? serialized
      : serialized.slice(0, TOOL_RESULT_CLASSIFY_PREVIEW_BYTES);
  } catch {
    return "";
  }
}

/**
 * Classify a tool result and return the sensitivity tier the slab
 * item should carry, OR `undefined` when no tag is warranted.
 * Composes `extractClassifiableText` with `scanText`.
 *
 * Returns `undefined` in two cases — collapsed at the API boundary
 * because both produce the same call-site behavior (don't tag the
 * item):
 *
 *   - **Unscanned** — binary content (Uint8Array, ArrayBuffer),
 *     null/undefined, circular-reference structures the JSON
 *     serializer can't walk. We never inspected text; tagging
 *     `None` would mislead with false confidence ("I classified
 *     this and it's clean") when the truth is "I never looked."
 *
 *   - **Scanned-and-clean** — text was inspected by `scanText` and
 *     no sensitive patterns matched. The slab item also doesn't
 *     need a tag because the gate's effective-sensitivity
 *     composition skips items without a tier.
 *
 * The two states are different epistemically (one is "no" knowledge,
 * the other is "we looked and it was clean") but call-site
 * equivalent: tag if the function returns a level, skip otherwise.
 * Future callers that need to distinguish unscanned from clean can
 * branch through `extractClassifiableText` plus `scanText` directly
 * — or this function's return type can grow into a richer
 * `{ status: "scanned" | "unscanned", sensitivity? }` shape if a
 * concrete consumer drives it.
 *
 * Doctrine — `motebit-computer.md` §"Mode contract — six declarations
 * per mode": `tool_result` carries `tier-bounded-by-tool` posture.
 * The runtime's gate composes items in tier-bounded-by-tool modes
 * the same way it composes tier-bounded-by-source items; this
 * function is the classifier the runtime calls at the tool-result
 * boundary.
 */
export function classifyToolResult(result: unknown): SensitivityLevel | undefined {
  const text = extractClassifiableText(result);
  if (text === "") return undefined; // unscanned (binary/empty/unserializable)
  const level = toSensitivityEnum(scanText(text).level);
  return level === SensitivityLevel.None ? undefined : level; // clean → no tag
}

/** Handler signature parameterized by the categorical drop kind. */
export type DropHandler<K extends DropPayloadKind> = (
  payload: Extract<DropPayload, { kind: K }>,
) => Promise<void> | void;

/** Generic handler used internally by the dispatcher's map storage. */
type AnyDropHandler = (payload: DropPayload) => Promise<void> | void;

export interface DropDispatcherDeps {
  slab: SlabController;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
}

/**
 * Routes typed `DropPayload` events to per-kind handlers. v1 default
 * handlers create slab items the user sees on drop; replace via
 * `registerHandler` to specialize.
 */
export class DropDispatcher {
  private readonly handlers = new Map<DropPayloadKind, AnyDropHandler>();

  constructor(private readonly deps: DropDispatcherDeps) {
    // v1 defaults — the high-frequency drop intents. file and artifact
    // are intentionally absent (allowlisted-deferred); registering one
    // is opt-in until v1.1.
    this.registerHandler("url", defaultUrlHandler(deps));
    this.registerHandler("text", defaultTextHandler(deps));
    this.registerHandler("image", defaultImageHandler(deps));
  }

  /** Replace the handler for a drop kind. v1 callers usually let defaults stand. */
  registerHandler<K extends DropPayloadKind>(kind: K, handler: DropHandler<K>): void {
    this.handlers.set(kind, handler as AnyDropHandler);
  }

  /**
   * Dispatch a payload to its registered handler. No-op (warns) when
   * no handler is registered — happens for `file` / `artifact` until
   * v1.1 lifts them off the allowlist.
   */
  async dispatch(payload: DropPayload): Promise<void> {
    const handler = this.handlers.get(payload.kind);
    if (handler === undefined) {
      this.deps.logger.warn("drop_dispatcher.no_handler", {
        kind: payload.kind,
        reason:
          "no handler registered for this drop kind (allowlisted-deferred or surface forgot to register)",
      });
      return;
    }
    await handler(payload);
  }
}

/**
 * v1 default URL handler. Opens a `fetch`-kind slab item in
 * `shared_gaze` mode — the user is the driver (they pointed the
 * motebit at this), the motebit is the observer, the source is
 * `user-source`, and consent fires per-source (each drag IS a new
 * source-consent moment). `mind` would be the wrong mode here:
 * `mind` is interior cognition (memory, reasoning, plan state), not
 * user-fed external material crossing the membrane.
 *
 * Settles into rest so the page reference stays as workstation
 * material the motebit and user can both consult.
 */
function defaultUrlHandler(deps: DropDispatcherDeps): DropHandler<"url"> {
  return (payload) => {
    const id = `perception-url-${cryptoRandom()}`;
    // URL strings rarely contain sensitive patterns themselves; the
    // sensitive content lives at the URL's destination, which the
    // runtime classifies later if/when it fetches via read_url.
    // Classifying the URL string still catches the rare case (e.g. a
    // signed pre-auth URL containing an embedded secret token).
    const sensitivity = toSensitivityEnum(scanText(payload.url).level);
    const itemPayload = {
      url: payload.url,
      source: "user-drop" as const,
      sourceFrame: payload.sourceFrame,
    };
    deps.slab.openItem({
      id,
      kind: "fetch",
      mode: "shared_gaze",
      payload: itemPayload,
      sensitivity,
    });
    deps.slab.restItem(id, itemPayload);
  };
}

/**
 * v1 default text handler. Opens a `stream`-kind slab item in
 * `shared_gaze` mode (same reasoning as the URL handler — the user
 * is pointing the motebit at user-source content). MIME defaults to
 * `text/plain`; markdown drops carry `text/markdown` for downstream
 * rendering.
 */
function defaultTextHandler(deps: DropDispatcherDeps): DropHandler<"text"> {
  return (payload) => {
    const id = `perception-text-${cryptoRandom()}`;
    // Run the canonical text classifier on the dropped payload — the
    // same regex engine `classifyComputerAction` uses for `type` action
    // gating. Catches credit cards (Luhn-verified), SSNs, AWS keys,
    // GitHub tokens, OpenAI/Anthropic API keys, JWTs, PEM blocks.
    // Items in `shared_gaze` mode contribute their tier to the
    // runtime's effective-sensitivity gate; a user dropping a secret
    // snippet onto motebit while in BYOK mode triggers the gate.
    const sensitivity = toSensitivityEnum(scanText(payload.text).level);
    const itemPayload = {
      text: payload.text,
      mimeType: payload.mimeType ?? "text/plain",
      source: "user-drop" as const,
    };
    deps.slab.openItem({
      id,
      kind: "stream",
      mode: "shared_gaze",
      payload: itemPayload,
      sensitivity,
    });
    deps.slab.restItem(id, itemPayload);
  };
}

/**
 * v1 default image handler. Opens an `embedding`-kind slab item in
 * `shared_gaze` mode carrying the image metadata (byte length, MIME).
 * The raw bytes stay attached to the payload for the next AI turn to
 * forward to a vision-capable provider; the slab renders metadata
 * only at v1 (rich preview is v1.1).
 */
function defaultImageHandler(deps: DropDispatcherDeps): DropHandler<"image"> {
  return (payload) => {
    const id = `perception-image-${cryptoRandom()}`;
    // Image classification needs OCR to inspect rendered text inside
    // the raster — the same path `classifyScreenshotWithOcr` takes
    // for computer-use observations. v1 ships without OCR-on-drop, so
    // image drops carry no sensitivity tag (left undefined). v1.1
    // wires the existing OCR path; the slab item shape is already
    // ready to receive the field.
    const itemPayload = {
      byteLength: payload.bytes.byteLength,
      mimeType: payload.mimeType,
      source: "user-drop" as const,
    };
    deps.slab.openItem({ id, kind: "embedding", mode: "shared_gaze", payload: itemPayload });
    deps.slab.restItem(id, itemPayload);
  };
}

/**
 * `crypto.randomUUID()` is available in Node 18+ and every modern
 * browser, but the runtime targets older Node fallback paths via
 * `crypto.getRandomValues`. Inline a minimal v4-shape generator so
 * the perception module doesn't pull in a UUID dependency.
 */
function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback — not RFC-compliant; sufficient as a slab-item id.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
