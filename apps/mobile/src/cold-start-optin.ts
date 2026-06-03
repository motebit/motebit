// === Paid P2P Cold-Start Opt-In cache (mobile) ===
//
// `MobileSettings.coldStartOptIn` is the persisted source of truth (AsyncStorage,
// async). But `enableInteractiveDelegation`'s `acknowledgeNoHistoryRisk` is a
// SYNC getter (`() => boolean`) read per delegation so the Governance toggle
// takes effect without a re-enable — the same live-getter contract web/desktop
// satisfy with synchronous localStorage. AsyncStorage can't be read
// synchronously, so this module holds an in-memory mirror: mobile-app hydrates
// it from the loaded settings and updates it on every save, and the
// sync-controller reads it synchronously. Defaults false (sovereign
// fail-closed) until the first hydrate. See
// docs/doctrine/off-ramp-as-user-action.md § Arc 3.

let cached = false;

/** Mirror the persisted `MobileSettings.coldStartOptIn` into the sync cache. */
export function setColdStartOptIn(enabled: boolean): void {
  cached = enabled;
}

/** Synchronous read for `acknowledgeNoHistoryRisk`. */
export function loadColdStartOptIn(): boolean {
  return cached;
}
