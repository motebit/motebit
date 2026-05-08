/**
 * Co-browse Slice 2c — redaction helpers for user-driven input audit
 * payloads. The wire-format `UserInputEvent` carries raw text/keys/
 * pixel coordinates; the audit format (`UserInputForwardedPayload`)
 * is REDACTED. These helpers are the policy: they take the wire
 * shape and produce a `UserInputForwardedDetail` that is safe to
 * sign and persist.
 *
 * Where the policy lives: the runtime session manager calls
 * `buildUserInputAuditDetail` immediately before emitting the audit
 * event. Raw text is in memory only as long as the wire forward
 * needs it; never lands in any audit/event/log buffer in raw form.
 *
 * Why these are exported pure functions (not a class): they're
 * stateless mappings, deterministic, no I/O. Surface tests verify
 * the redaction at the unit level; the session manager composes
 * them.
 *
 * Doctrine binding: `motebit-computer.md` §"Mode contract"
 * (sensitivity-aware boundary at the audit layer) +
 * `architecture_cobrowse_belongs_in_virtual_browser` (memory). The
 * audit shape is the contract — get this wrong and a `password123`
 * lands in an audit log forever.
 */

import type {
  CharacterClass,
  KeyModifiers,
  KeyRole,
  UserInputEvent,
  UserInputForwardedDetail,
} from "@motebit/sdk";

/**
 * Classify a key event's `key` value into a coarse character class.
 * Single printable characters get classed by Unicode category;
 * named keys (`Enter`, `Shift`, etc.) get classed by role.
 *
 * Empty string → `unknown` (defensive: a malformed event shouldn't
 * leak through redaction). Multi-char names that are NOT recognized
 * named keys also fall through to `unknown` — never `letter` or
 * `digit` (those would be a privacy leak: an IME composition string
 * is multi-char and SHOULD redact to `unknown`).
 */
export function classifyCharacter(key: string): CharacterClass {
  if (typeof key !== "string" || key.length === 0) return "unknown";

  // Named keys — classify by their semantic role at the character
  // level. Modifier keys pressed alone get `modifier`; control keys
  // (Tab, Enter, Backspace, arrows) get `control`.
  if (NAMED_MODIFIER_KEYS.has(key)) return "modifier";
  if (NAMED_CONTROL_KEYS.has(key)) return "control";

  // Single character — Unicode-category-driven classification.
  // Use Array.from so codepoint-pair characters (emoji etc.) count
  // as one logical character rather than two UTF-16 units.
  if (Array.from(key).length === 1) {
    if (/^\s$/.test(key)) return "whitespace";
    if (/^\p{L}$/u.test(key)) return "letter";
    if (/^\p{N}$/u.test(key)) return "digit";
    if (/^\p{P}$/u.test(key)) return "punct";
    if (/^\p{S}$/u.test(key)) return "punct"; // symbols collapse to punct for audit purposes
    // ASCII control characters (\x00-\x1f) don't surface here in
    // practice — keyboards emit them as named keys ("Enter",
    // "Backspace"), which `NAMED_CONTROL_KEYS` already catches
    // above. A genuine single-codepoint control char falls through
    // to "unknown" rather than tripping the no-control-regex lint.
    return "unknown";
  }

  // Multi-char key name we don't recognize. Stay defensive: do NOT
  // classify by first character (which would leak IME composition
  // strings as `letter`).
  return "unknown";
}

/**
 * Classify a key event's semantic role. Coarser than character
 * class — answers "what kind of action did the user invoke" rather
 * than "what character did they enter."
 *
 * `hasModifiers` rolls up Ctrl/Meta/Alt; Shift alone does NOT count
 * (capital letters and symbols use Shift but are still printable
 * input). Any non-shift modifier turns the press into `shortcut`.
 */
export function classifyKeyRole(key: string, modifiers: KeyModifiers): KeyRole {
  if (typeof key !== "string" || key.length === 0) return "unknown";

  // Non-shift modifiers turn the keystroke into a shortcut. Shift
  // alone for "A" / "$" / etc. is still printable input.
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return "shortcut";

  if (key === "Enter") return "enter";
  if (key === "Tab") return "tab";
  if (key === "Escape") return "escape";
  if (key === "Backspace") return "backspace";
  if (key.startsWith("Arrow")) return "arrow";

  if (Array.from(key).length === 1) return "printable";
  return "unknown";
}

/**
 * Build the redacted detail for a paste event. The wire carries the
 * full clipboard text; the audit gets length + line_count + a
 * looks_like_url heuristic. Never the content.
 *
 * `looks_like_url` is a coarse heuristic — bare hostnames don't
 * match (no scheme), bare paths don't match. Conservative on
 * purpose: false positives would mis-categorize sensitive content;
 * false negatives just mean a URL paste isn't flagged in the
 * audit.
 */
export function pasteAuditDetail(text: string): {
  readonly length: number;
  readonly line_count: number;
  readonly looks_like_url: boolean;
} {
  const safeText = typeof text === "string" ? text : "";
  return {
    length: safeText.length,
    // `\n`-delimited lines. An empty paste counts as 1 line.
    line_count: safeText.split("\n").length,
    looks_like_url: /^https?:\/\/\S+$/.test(safeText.trim()),
  };
}

/**
 * Build the redacted detail for a URL navigation. The wire carries
 * the full URL; the audit gets scheme + host + presence flags only.
 * Path and query stripped because they commonly carry tokens /
 * session ids / sensitive identifiers (`?reset_token=...`,
 * `/patient/12345`).
 *
 * Malformed URLs (parser throws) collapse to all-`unknown`. The
 * server-side dispatch will fail anyway; the audit just records
 * "user attempted navigation that didn't parse" without leaking
 * anything.
 */
export function urlAuditDetail(url: string): {
  readonly scheme: string;
  readonly host: string;
  readonly has_path: boolean;
  readonly has_query: boolean;
} {
  if (typeof url !== "string" || url.length === 0) {
    return { scheme: "unknown", host: "unknown", has_path: false, has_query: false };
  }
  try {
    const parsed = new URL(url);
    // `pathname` is always at least "/" for absolute URLs; treat
    // the bare-root case as "no path" for the redaction signal.
    const path = parsed.pathname;
    const hasPath = path.length > 0 && path !== "/";
    return {
      // Drop the trailing colon ("https:" → "https"). Lowercased
      // for canonical-form audit comparisons across replays.
      scheme: parsed.protocol.replace(/:$/, "").toLowerCase(),
      host: parsed.host.toLowerCase(),
      has_path: hasPath,
      has_query: parsed.search.length > 0,
    };
  } catch {
    return { scheme: "unknown", host: "unknown", has_path: false, has_query: false };
  }
}

/**
 * Build the redacted audit detail from a wire-format
 * `UserInputEvent`. The session manager calls this immediately
 * before emitting the audit event. Click coordinates are
 * normalized against the cloud Chromium viewport
 * (`displayWidth`/`displayHeight`) so the audit log doesn't hold
 * raw pixels — it holds [0, 1] floats robust to viewport resize.
 */
export function buildUserInputAuditDetail(
  event: UserInputEvent,
  displayWidth: number,
  displayHeight: number,
): UserInputForwardedDetail {
  switch (event.kind) {
    case "click": {
      const safeWidth = displayWidth > 0 ? displayWidth : 1;
      const safeHeight = displayHeight > 0 ? displayHeight : 1;
      return {
        kind: "click",
        x_norm: event.x / safeWidth,
        y_norm: event.y / safeHeight,
        button: event.button,
      };
    }
    case "key":
      return {
        kind: "key",
        character_class: classifyCharacter(event.key),
        key_role: classifyKeyRole(event.key, event.modifiers),
        modifiers: event.modifiers,
      };
    case "paste":
      return {
        kind: "paste",
        ...pasteAuditDetail(event.text),
      };
    case "wheel": {
      const safeWidth = displayWidth > 0 ? displayWidth : 1;
      const safeHeight = displayHeight > 0 ? displayHeight : 1;
      // Wheel deltas pass through unchanged — they're CSS-pixel
      // scroll amounts, not sensitivity-bearing content. Anchor
      // coords normalize like click for the same robustness reason
      // (viewport resize across replays).
      return {
        kind: "wheel",
        x_norm: event.x / safeWidth,
        y_norm: event.y / safeHeight,
        dx: event.dx,
        dy: event.dy,
        event_count: event.event_count,
      };
    }
    case "navigate":
      return {
        kind: "navigate",
        ...urlAuditDetail(event.url),
      };
    // Slice 2e — parameter-less history navigations. Audit just
    // records the action kind; nothing to redact, nothing to
    // normalize.
    case "back":
      return { kind: "back" };
    case "forward":
      return { kind: "forward" };
    case "reload":
      return { kind: "reload" };
  }
}

// ── Internal lookup tables ─────────────────────────────────────────────

const NAMED_MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
]);

const NAMED_CONTROL_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ContextMenu",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);
