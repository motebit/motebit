// === Paid P2P Cold-Start Opt-In (desktop) ===
//
// Sibling of apps/web/src/storage.ts's saveColdStartOptIn/loadColdStartOptIn —
// the same UI preference, the same localStorage key, so the meaning is identical
// across surfaces (storage_key_conventions: centralized per-surface keys, never
// renamed). Whether the user has consciously opted into paying a NEW worker (no
// trust history) directly, peer-to-peer — the Arc-3 cold-start acknowledgment.
//
// Default OFF (conservative): without it a first paid delegation to an unknown
// worker safely degrades to relay-mode rather than moving funds onchain. When
// ON, the sync-controller forwards `acknowledgeNoHistoryRisk` into
// enableInteractiveDelegation as a LIVE getter, so the "Pay new agents directly"
// Governance toggle governs chat-driven (delegate_to_agent) P2P delegation —
// not just a re-enable. The desktop renderer is a Chromium webview, so
// localStorage is available (same store the relay-key TOFU pin uses). See
// docs/doctrine/off-ramp-as-user-action.md § Arc 3.

const P2P_COLD_START_KEY = "motebit-p2p-cold-start-optin";

export function saveColdStartOptIn(enabled: boolean): void {
  try {
    localStorage.setItem(P2P_COLD_START_KEY, enabled ? "true" : "false");
  } catch {
    // localStorage unavailable (rare desktop contexts) — opt-in stays default-off.
  }
}

export function loadColdStartOptIn(): boolean {
  try {
    return localStorage.getItem(P2P_COLD_START_KEY) === "true";
  } catch {
    return false;
  }
}
