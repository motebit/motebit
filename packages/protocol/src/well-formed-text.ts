/**
 * Well-formed Unicode text for signed artifacts.
 *
 * UTF-8 is defined only for strings of Unicode scalar values, so a string that
 * holds an unpaired UTF-16 surrogate has no canonical bytes and no digest
 * (`spec/execution-ledger-v1.md` §11.4). Producers never emit one: they cut
 * text only on code-point boundaries (`truncateWellFormed`) and repair any
 * unpaired surrogate received from upstream (`toWellFormedText`) before
 * hashing and signing. Deterministic, no I/O.
 */

/** Every unpaired UTF-16 surrogate: a high not followed by a low, a low not preceded by a high. */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `s` with every unpaired UTF-16 surrogate replaced by U+FFFD; the identity on
 * well-formed text. Same result as ES2024 `String.prototype.toWellFormed`, and
 * UTF-8 encoders (`TextEncoder`, Node's `"utf8"`) produce the same bytes for
 * `s` and for `toWellFormedText(s)` — so a digest computed before the repair
 * still binds the repaired text.
 */
export function toWellFormedText(s: string): string {
  return s.replace(UNPAIRED_SURROGATE, "�");
}

/**
 * The longest prefix of `s` that is at most `maxUnits` UTF-16 code units long
 * and does not end between the two halves of a surrogate pair, repaired with
 * {@link toWellFormedText}. A cut that would split a pair drops its high half,
 * so the result may be one unit shorter than `maxUnits`. `maxUnits` is floored
 * and clamped at zero.
 */
export function truncateWellFormed(s: string, maxUnits: number): string {
  let end = Math.max(0, Math.min(s.length, Math.floor(maxUnits)));
  if (end > 0 && end < s.length) {
    const before = s.charCodeAt(end - 1);
    const after = s.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  }
  return toWellFormedText(s.slice(0, end));
}
