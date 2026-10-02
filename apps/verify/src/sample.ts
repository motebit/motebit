/**
 * The committed on-load sample (see `sample-build.ts` for provenance) and the
 * Tamper control: flip ONE byte of `result` and let the verifier say INVALID.
 */

import sampleReceipt from "./sample-receipt.json";

export const SAMPLE_JSON: string = JSON.stringify(sampleReceipt, null, 2);

/**
 * Flip one byte of `result`: toggle bit 0x20 of its first ASCII letter (a case
 * flip — still one valid UTF-8 byte, so the edit is visible and minimal).
 * Returns null when the text has no string `result` with an ASCII letter.
 */
export function tamperResult(jsonText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  const result = r["result"];
  if (typeof result !== "string") return null;
  const i = result.search(/[A-Za-z]/);
  if (i < 0) return null;
  const flipped = String.fromCharCode(result.charCodeAt(i) ^ 0x20);
  r["result"] = result.slice(0, i) + flipped + result.slice(i + 1);
  return JSON.stringify(r, null, 2);
}
