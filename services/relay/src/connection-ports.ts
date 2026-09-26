/**
 * The ports through which a door that ENDS a credential closes the live sync
 * sockets that credential admitted (#767, #776).
 *
 * The class: a door ends a key or an identity in the database, so the
 * credential admits no NEW socket, but a socket it had already admitted
 * stays open — it keeps receiving sync traffic, keeps a machine-roster
 * liveness row, and keeps acting as the identity — until it drops on its
 * own. Every such door takes the matching port as a REQUIRED dep, so a door
 * cannot be wired without saying what it closes, and calls it after its
 * writes commit (a refused or rolled-back write closes nothing).
 *
 * Each port is bound ONCE, in `index.ts`, over the relay's `connections`,
 * to a helper in `websocket.ts` that shares one retirement body
 * (`retirePeers`: mark retired, remove, one close-time roster observation,
 * then close). The doors:
 *
 * | door                                   | port                           | close |
 * | -------------------------------------- | ------------------------------ | ----- |
 * | `/rotate-key`, `/agents/register` succession (`applySuccession`) | `RetireKeyConnections` (succession-apply.ts) | 4010 |
 * | accept-migration (registry + holder key overwritten) | `ReconcileKeyConnections` | 4010 |
 * | receipt heal (registry fallback moved, tasks.ts) | `ReconcileKeyConnections` | 4010 |
 * | pairing `update-key` (one device row's key rewritten) | `ReconcileKeyConnections` | 4010 |
 * | `/revoke`, migration departure, operator `revoke-listing` | `CloseIdentityConnections` | 4011 |
 * | `/revoke-tokens` (jti blacklist)         | `CloseTokenConnections`        | 4012  |
 */

/**
 * The keys this identity's sockets were admitted under may have moved
 * without one retired key being named: close every socket whose token would
 * no longer verify under the key that admitted it, resolved per (did, key)
 * the way the verifier resolves it (`closeSocketsNoLongerAdmitted`).
 */
export type ReconcileKeyConnections = (motebitId: string) => void;

/**
 * The identity was revoked — every signed token of it is now refused.
 * Close every socket an identity credential admitted, under any key
 * (`closeSocketsOfRevokedIdentity`, 4011).
 */
export type CloseIdentityConnections = (motebitId: string) => void;

/**
 * These token ids were revoked. Close the sockets they admitted
 * (`closeSocketsAuthenticatedWith`, 4012).
 */
export type CloseTokenConnections = (motebitId: string, jtis: readonly string[]) => void;
