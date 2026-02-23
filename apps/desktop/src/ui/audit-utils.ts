export function parseJsonSafe(str: unknown): unknown {
  if (typeof str !== "string") return str;
  try { return JSON.parse(str); } catch { return str; }
}

/** Safely convert an unknown IPC value to string. */
export function ipcString(val: unknown, fallback = ""): string {
  if (val == null) return fallback;
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return val.toString();
  return JSON.stringify(val);
}

export function classifyDecision(raw: unknown): "allowed" | "denied" | "approval" {
  const data = parseJsonSafe(raw) as Record<string, unknown> | null;
  if (data != null && typeof data === "object") {
    const decision = ipcString(data.decision);
    const action = ipcString(data.action);
    const val = (decision !== "" ? decision : action).toLowerCase();
    if (val === "denied" || val === "deny") return "denied";
    if (val === "allowed" || val === "allow") return "allowed";
    if (val === "requires_approval" || val === "approval" || val === "pending") return "approval";
  }
  const str = ipcString(raw).toLowerCase();
  if (str.includes("denied") || str.includes("deny")) return "denied";
  if (str.includes("approval") || str.includes("requires") || str.includes("pending")) return "approval";
  return "allowed";
}
