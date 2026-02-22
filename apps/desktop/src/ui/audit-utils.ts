/* eslint-disable @typescript-eslint/no-base-to-string -- works with untyped audit data */
export function parseJsonSafe(str: unknown): unknown {
  if (typeof str !== "string") return str;
  try { return JSON.parse(str); } catch { return str; }
}

export function classifyDecision(raw: unknown): "allowed" | "denied" | "approval" {
  const data = parseJsonSafe(raw) as Record<string, unknown> | null;
  if (data && typeof data === "object") {
    const val = String(data.decision || data.action || "").toLowerCase();
    if (val === "denied" || val === "deny") return "denied";
    if (val === "allowed" || val === "allow") return "allowed";
    if (val === "requires_approval" || val === "approval" || val === "pending") return "approval";
  }
  const str = String(raw || "").toLowerCase();
  if (str.includes("denied") || str.includes("deny")) return "denied";
  if (str.includes("approval") || str.includes("requires") || str.includes("pending")) return "approval";
  return "allowed";
}
