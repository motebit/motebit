/**
 * Shareable links: `#r=<base64url(JSON)>`. The fragment never leaves the browser
 * (browsers do not send it to the server), so a shared receipt is verified by the
 * recipient's own tab. Capped so links stay pasteable.
 */

/** Max encoded fragment payload, in characters. Keeps links pasteable everywhere. */
export const MAX_FRAGMENT_CHARS = 16_000;

export type FragmentEncode =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly reason: "too_large" | "malformed_json"; readonly size?: number };

export type FragmentDecode =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly reason: "too_large" | "malformed" };

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Encode receipt JSON text (minified first — verification is canonical, so whitespace is irrelevant). */
export function encodeFragment(jsonText: string): FragmentEncode {
  let minified: string;
  try {
    minified = JSON.stringify(JSON.parse(jsonText));
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
  const payload = toBase64Url(new TextEncoder().encode(minified));
  if (payload.length > MAX_FRAGMENT_CHARS) {
    return { ok: false, reason: "too_large", size: payload.length };
  }
  return { ok: true, hash: `#r=${payload}` };
}

/** Decode `location.hash`; `null` when it carries no `r=` receipt. */
export function decodeFragment(hash: string): FragmentDecode | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const param = new URLSearchParams(raw).get("r");
  if (param === null) return null;
  if (param.length > MAX_FRAGMENT_CHARS) return { ok: false, reason: "too_large" };
  if (!/^[A-Za-z0-9_-]*$/.test(param)) return { ok: false, reason: "malformed" };
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(param));
    JSON.parse(json);
    return { ok: true, json: JSON.stringify(JSON.parse(json), null, 2) };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
