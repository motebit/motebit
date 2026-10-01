/**
 * Relay-controlled text, made safe to print (#962 rounds 5-6).
 *
 * A relay's reply text (an HTTP status text, a socket's refusal message, a
 * response body) reaches a terminal or a log line through the errors built
 * from it. A hostile relay could set the window title (OSC), clear the
 * screen (CSI), reorder what is shown (bidi overrides), hide characters
 * (zero-width) or flood the screen. Every error the sync engine builds from
 * relay text carries it through here, so raw relay text never enters an
 * Error message, and `SyncEngine.getLastError()` only exposes sanitized text.
 */

/** The longest relay text printed, in grapheme clusters. */
export const RELAY_TEXT_MAX = 200;

const segmenter: { segment(s: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;

/**
 * `text` safe to print: ESC sequences (OSC / DCS / SOS / PM / APC strings,
 * CSI, the C1 CSI, any other ESC and the byte after it) removed whole; bidi
 * embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069),
 * zero-width characters (U+200B-U+200F) and the BOM (U+FEFF) removed; every
 * C0 / C1 control, DEL and the Unicode line / paragraph separators
 * (U+2028/U+2029) become a space; a lone surrogate becomes U+FFFD;
 * whitespace runs collapse. Capped at `max` grapheme clusters
 * (`Intl.Segmenter`) — a surrogate pair, a flag or an emoji sequence is kept
 * whole or dropped whole — with the rest counted, never printed.
 * Idempotent on its own output.
 */
export function sanitizeRelayText(text: string, max = RELAY_TEXT_MAX): string {
  const clean = String(text)
    // OSC / DCS / SOS / PM / APC strings, up to their BEL or ST terminator.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // CSI sequences (ESC [ … final byte), and the one-byte C1 CSI.
    // eslint-disable-next-line no-control-regex
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    // Any other ESC and the byte after it.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[ -~]?/g, "")
    // A lone surrogate (half of a pair) prints as a replacement character.
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
    // Bidi embeddings / overrides / isolates, zero-width characters, BOM.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    // C0, DEL, C1, and the Unicode line / paragraph separators.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const graphemes = segmenter
    ? Array.from(segmenter.segment(clean), (s) => s.segment)
    : Array.from(clean);
  return graphemes.length > max
    ? `${graphemes.slice(0, max).join("")}… (${graphemes.length - max} more characters)`
    : clean;
}
