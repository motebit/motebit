/**
 * WebSocket route handler for bidirectional event stream.
 * Extracted from index.ts — zero behavior changes.
 *
 * Handles /ws/sync/:motebitId with onOpen (auth + task recovery),
 * onMessage (push events, conversations, messages, task claims, capabilities),
 * and onClose (connection cleanup).
 */

import type { Hono } from "hono";
import type { TokenAudience } from "@motebit/protocol";
import type { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import type { EventStore } from "@motebit/event-log";
import type { IdentityManager } from "@motebit/core-identity";
import type { DatabaseDriver, MotebitDatabase } from "@motebit/persistence";
import type { EventLogEntry, SyncConversation, SyncConversationMessage } from "@motebit/sdk";
import { AgentTaskStatus, asMotebitId } from "@motebit/sdk";
import type { FixedWindowLimiter } from "./rate-limiter.js";
import { upsertSyncConversation, upsertSyncMessage } from "./data-sync.js";
import { floorSyncConversation, floorSyncMessage } from "./data-sync-redaction.js";
import { redactSensitiveEvents } from "./redaction.js";
import { propagateDeletionForEvent } from "./deletion-propagation.js";
import type { TaskQueueEntry } from "./tasks.js";
import type { createLogger } from "./logger.js";
import type { AuthEvent } from "./auth-events.js";

/** `WebSocket.OPEN` — the only state in which a socket is registered or counted. */
export const WS_OPEN = 1;

/**
 * Close code for a socket whose admitting key was retired by a key
 * succession (#767). Not a refusal of the client: its identity moved on to
 * a new key, and it should re-authenticate under that key. Distinct from
 * 4003 (a token that does not verify) so a client can tell "your credential
 * is stale" from "your credential is wrong".
 */
export const WS_CLOSE_KEY_RETIRED = 4010;
const WS_CLOSE_KEY_RETIRED_REASON = "Key rotated; re-authenticate";

/**
 * Close code for a socket whose identity was revoked (#776): its own
 * `/revoke`, a migration departure, or the operator's `revoke-listing` hold.
 * The verifier now refuses every signed token of the identity
 * (`agent_revoked`), so the client must not simply reconnect. Distinct from
 * 4010, where the identity lives on under another key.
 */
export const WS_CLOSE_IDENTITY_REVOKED = 4011;
const WS_CLOSE_IDENTITY_REVOKED_REASON = "Identity revoked";

/**
 * Close code for a socket whose own token was revoked by `jti`
 * (`/revoke-tokens`, #776). The identity and its key are unaffected: the
 * owner re-authenticates with a fresh token.
 */
export const WS_CLOSE_TOKEN_REVOKED = 4012;
const WS_CLOSE_TOKEN_REVOKED_REASON = "Token revoked; re-authenticate";

/** What every retirement helper is handed (bound once in `index.ts`). */
export interface RetirementHooks {
  onRemoved: (motebitId: string, peer: ConnectedDevice) => void;
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
}

/**
 * The ONE retirement body every close-on-credential-end helper shares (#767,
 * #776): retire the registered peers of `motebitId` that `select` picks.
 *
 * `ws.close()` only STARTS a close handshake: the socket is CLOSING until
 * the peer answers (or `ws`'s own close timer fires, ~30 s), and inbound
 * frames are still delivered meanwhile. So retirement does not wait for the
 * handshake. Synchronously, each retired peer is
 *  1. marked `retired` — the route's `onMessage` acts on no frame from it;
 *  2. removed from `connections` — no fan-out, task dispatch, command or
 *     roster read reaches it, and the route's `onClose` later finds nothing
 *     and does nothing;
 *  3. handed to `onRemoved` — the ONE close-time observation (the roster's
 *     `last_seen_at`), in place of the `onPeerClosed` its `onClose` will no
 *     longer make;
 * and only then asked to close with `code`. Returns the number retired.
 */
function retirePeers(
  connections: Map<string, ConnectedDevice[]>,
  motebitId: string,
  select: (peer: ConnectedDevice) => boolean,
  code: number,
  reason: string,
  hooks: RetirementHooks,
): number {
  const peers = connections.get(motebitId);
  if (peers == null) return 0;
  // A copy: the live array is spliced below, and by the route's onClose.
  const retiring = peers.filter(select);
  for (const peer of retiring) {
    peer.retired = true;
    const idx = peers.indexOf(peer);
    if (idx !== -1) peers.splice(idx, 1);
  }
  if (peers.length === 0) connections.delete(motebitId);
  for (const peer of retiring) {
    try {
      hooks.onRemoved(motebitId, peer);
    } catch (err: unknown) {
      hooks.logger?.warn("ws.retired_observe_failed", {
        motebitId,
        deviceId: peer.deviceId,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      peer.ws.close(code, reason);
    } catch (err: unknown) {
      hooks.logger?.warn("ws.retired_close_failed", {
        motebitId,
        deviceId: peer.deviceId,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return retiring.length;
}

/**
 * Close every registered socket of `motebitId` whose token verified under
 * `retiredKey` (compared case-insensitively, the way `applySuccession`
 * retires device rows — retiring WIDER is fail-safe). Sockets admitted
 * under any other key stay open: a device linked without key transfer holds
 * its own key, which a rotation of the identity key is not about. Sockets
 * admitted by no identity key (master token, device auth off) stay open:
 * the retired key never admitted them. Closed 4010 (see `retirePeers`).
 */
export function closeSocketsAuthenticatedUnder(
  connections: Map<string, ConnectedDevice[]>,
  motebitId: string,
  retiredKey: string,
  hooks: RetirementHooks,
): number {
  const retired = retiredKey.toLowerCase();
  return retirePeers(
    connections,
    motebitId,
    (p) => p.authenticatedUnder != null && p.authenticatedUnder.toLowerCase() === retired,
    WS_CLOSE_KEY_RETIRED,
    WS_CLOSE_KEY_RETIRED_REASON,
    hooks,
  );
}

/**
 * Close every registered socket of `motebitId` whose token would no longer
 * verify under the key that admitted it (#776): for each socket an identity
 * key admitted, `keyThatVerifiesNow(motebitId, did)` — the resolution the
 * verifier performs, the device row for the token's `did`, else the
 * agent-registry fallback — must still answer that key. It is the predicate
 * the route applies to a socket still being verified
 * (`credentialEndedDuringVerification`), applied to the registered ones.
 *
 * For a door that moves a key WITHOUT naming one key it ends: accept-migration
 * overwriting a returning identity's registry and holder key, the receipt
 * heal moving the registry fallback, pairing's `update-key` rewriting ONE
 * device row. Resolved per (did, key), never per key alone: a
 * registry-fallback socket closes when the fallback moves while a
 * device-row socket under the same key stays (its row still admits it), and
 * another device whose row holds the same key is untouched when one row
 * changes. Closed 4010.
 */
export function closeSocketsNoLongerAdmitted(
  connections: Map<string, ConnectedDevice[]>,
  motebitId: string,
  keyThatVerifiesNow: (motebitId: string, did: string) => string | null,
  hooks: RetirementHooks,
): number {
  return retirePeers(
    connections,
    motebitId,
    (p) => {
      if (p.authenticatedUnder == null) return false;
      // Admitted by an identity key with no recorded `did`: it cannot be
      // re-resolved, and retiring WIDER is fail-safe (the client reconnects).
      if (p.authenticatedDid == null) return true;
      const now = keyThatVerifiesNow(motebitId, p.authenticatedDid);
      return now == null || now.toLowerCase() !== p.authenticatedUnder.toLowerCase();
    },
    WS_CLOSE_KEY_RETIRED,
    WS_CLOSE_KEY_RETIRED_REASON,
    hooks,
  );
}

/**
 * Close every registered socket of `motebitId` that an identity credential
 * admitted — under ANY key: the identity's own, a device linked without key
 * transfer, the registry fallback — with `code` and `reason` (#776). For
 * the doors that end the IDENTITY, not one key; after them the verifier
 * refuses every signed token of the identity, so every socket such a token
 * admitted is ended with it.
 *
 * Sockets admitted by no identity credential stay open: the master token,
 * or device auth off. Revocation refuses neither (the master-token bypass
 * and the no-auth path never consult `isAgentRevoked`), so closing them
 * would end nothing — they would reconnect at once.
 */
export function closeSocketsOf(
  connections: Map<string, ConnectedDevice[]>,
  motebitId: string,
  code: number,
  reason: string,
  hooks: RetirementHooks,
): number {
  return retirePeers(
    connections,
    motebitId,
    (p) => p.authenticatedUnder != null,
    code,
    reason,
    hooks,
  );
}

/** `closeSocketsOf` for a revoked identity: 4011 "Identity revoked". */
export function closeSocketsOfRevokedIdentity(
  connections: Map<string, ConnectedDevice[]>,
  motebitId: string,
  hooks: RetirementHooks,
): number {
  return closeSocketsOf(
    connections,
    motebitId,
    WS_CLOSE_IDENTITY_REVOKED,
    WS_CLOSE_IDENTITY_REVOKED_REASON,
    hooks,
  );
}

/**
 * Close every registered socket of `motebitId` whose token's `jti` is in
 * `jtis` (#776): `/revoke-tokens` blacklists a token, which refuses it
 * anew, and a socket it had already admitted is ended with it. Other tokens
 * — of the same key or any other — are untouched. Closed 4012.
 */
export function closeSocketsAuthenticatedWith(
  connections: Map<string, ConnectedDevice[]>,
  motebitId: string,
  jtis: readonly string[],
  hooks: RetirementHooks,
): number {
  const revoked = new Set(jtis);
  return retirePeers(
    connections,
    motebitId,
    (p) => p.authenticatedJti != null && revoked.has(p.authenticatedJti),
    WS_CLOSE_TOKEN_REVOKED,
    WS_CLOSE_TOKEN_REVOKED_REASON,
    hooks,
  );
}

export interface ConnectedDevice {
  ws: WSContext;
  deviceId: string;
  /**
   * True when the peer DECLARED its device id, rather than the relay
   * inventing one for this connection.
   *
   * Routing that groups peers by machine must know the difference: a
   * generated id is unique per connection, so two processes on one
   * machine look like two machines and a reconnect race looks like a
   * third. A consumer that cannot tell declared from generated will
   * either refuse when it should deliver or group when it must not.
   */
  deviceIdDeclared?: boolean;
  /**
   * True when the declared device id is the `did` of the signed token
   * this connection authenticated with — so the id was PROVEN by a key
   * registered to that device, and not merely typed into a query string.
   *
   * `?device_id=` is unauthenticated on its own: any surface holding a
   * valid sync token for this motebit could declare another machine's
   * id. Anything that ATTRIBUTES by device id — a roster line's
   * liveness, a composed answer's per-machine line — reads this, never
   * `deviceIdDeclared`. False for the master token and with device auth
   * off: there is no `did` to bind to, and unproven is not verified.
   *
   * It proves "a holder of this motebit's key says it is this machine",
   * not "this IS that machine" — every machine holds the same key
   * (`docs/doctrine/machine-roster.md`, "A machine is not a principal").
   */
  deviceIdVerified?: boolean;
  /**
   * The public key (lowercase hex) of the device row that verified this
   * socket's token — captured AT VERIFICATION through `onVerified` and
   * never re-read. Set only when `deviceIdVerified` and the key came from
   * the device row (not the agent-registry fallback).
   *
   * Never re-read, because rotation rewrites device rows
   * (`succession-apply.ts`): a socket opened under the old key would
   * otherwise read as bound under the new one
   * (docs/proposals/machine-roster-relay-v1.md D4, review F1). Rotation
   * also retires such a socket (`authenticatedUnder`, #767), but only a
   * rotation through `applySuccession` does; a row rewritten any other way
   * leaves the socket as it was.
   */
  boundUnder?: string;
  /**
   * The public key (lowercase hex) the socket's signed token verified
   * under — from the device row for the token's `did`, or the
   * agent-registry fallback (service-mode motebits) — captured at
   * verification, never re-read. Unlike `boundUnder` it does not depend on
   * the declared device id: it answers "which credential admitted this
   * socket", which is what a rotation retires
   * (`closeSocketsAuthenticatedUnder`, #767). Absent for the master token
   * and with device auth off — those sockets were admitted by no identity
   * key, so no rotation retires them.
   */
  authenticatedUnder?: string;
  /**
   * The `did` claim of the signed token that admitted this socket — the
   * device row the verifier resolved the key from, or (with no such row) the
   * registry fallback. Captured at verification, set exactly when
   * `authenticatedUnder` is. Lets a door that moves ONE device row's key, or
   * the fallback, re-resolve this socket's credential
   * (`closeSocketsNoLongerAdmitted`, #776) instead of closing by key alone.
   */
  authenticatedDid?: string;
  /**
   * The `jti` of the signed token that admitted this socket, when it carried
   * one. `/revoke-tokens` blacklists by jti; the sockets that token already
   * admitted are closed with it (`closeSocketsAuthenticatedWith`, #776).
   */
  authenticatedJti?: string;
  /**
   * Set when the credential that admitted this socket ended — its key
   * retired or no longer resolving, its identity revoked, its token revoked
   * (`retirePeers`). The peer is out of `connections` and its close
   * handshake may still be pending; no frame from it is acted on.
   */
  retired?: boolean;
  capabilities?: string[];
}

export interface WebSocketDeps {
  app: Hono;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  connections: Map<string, ConnectedDevice[]>;
  taskQueue: Map<string, TaskQueueEntry>;
  eventStore: EventStore;
  identityManager: IdentityManager;
  db: DatabaseDriver;
  /** Full database handle — deletion propagation needs memoryStorage. */
  moteDb: MotebitDatabase;
  apiToken: string | undefined;
  enableDeviceAuth: boolean;
  wsLimiter: FixedWindowLimiter;
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
  /** Durable auth-event record (auth-events.ts); optional for hand-built test deps. */
  recordAuthEvent?: (event: AuthEvent) => void;
  verifySignedTokenForDevice: (
    token: string,
    motebitId: string,
    identityManager: IdentityManager,
    expectedAudience: TokenAudience,
    blacklistCheck?: (jti: string, motebitId: string) => boolean,
    agentRevokedCheck?: (motebitId: string) => boolean,
    agentKeyLookup?: (motebitId: string) => string | null,
    onReject?: (reason: string) => void,
    onVerified?: (publicKey: string, source: import("./auth.js").VerifiedKeySource) => void,
  ) => Promise<boolean>;
  parseTokenPayloadUnsafe: (token: string) => import("./auth.js").TokenPayload | null;
  /**
   * The key a signed token for (`motebitId`, `did`) would verify under RIGHT
   * NOW — the resolution `verifySignedTokenForDevice` performs (the device
   * row for the `did`, else the agent-registry fallback), read SYNCHRONOUSLY,
   * so no rotation can land between this read and the registration that
   * depends on it (`credentialEndedDuringVerification`, #767). Required: optional,
   * the mid-verification race would silently reopen the day it was dropped.
   */
  keyThatVerifiesNow: (motebitId: string, did: string) => string | null;
  logger: ReturnType<typeof createLogger>;
  onCommandResponse?: (commandId: string, result: unknown) => void;
  /**
   * A connection was finalized, or re-announced its capabilities. Called
   * with the peer as it now is. The machine roster's liveness record is
   * written from here (bind), from `onPeerClosed` (close), and from the
   * periodic flush — all through `observeHostConnection`.
   */
  onPeerBound?: (motebitId: string, peer: ConnectedDevice) => void;
  /**
   * A finalized connection went away. Called AFTER it has left
   * `connections`, with the peer as it was.
   */
  onPeerClosed?: (motebitId: string, peer: ConnectedDevice) => void;
  /** When true, new WebSocket upgrades are rejected with close code 1001. */
  isDraining?: () => boolean;
}

export function registerWebSocketRoutes(deps: WebSocketDeps): void {
  const {
    app,
    upgradeWebSocket,
    connections,
    taskQueue,
    eventStore,
    identityManager,
    db,
    apiToken,
    enableDeviceAuth,
    wsLimiter,
    isTokenBlacklisted,
    isAgentRevoked,
    verifySignedTokenForDevice,
    logger,
  } = deps;

  /** @internal */
  app.get(
    "/ws/sync/:motebitId",
    upgradeWebSocket((c) => {
      // Route param is guaranteed by /ws/sync/:motebitId pattern; guard in onOpen for defense-in-depth
      const motebitId = asMotebitId(c.req.param("motebitId") as string);
      const url = new URL(c.req.url, "http://localhost");
      // Empty is not declared. `?device_id=` yields "" rather than
      // null, which would mark the peer as having declared an id AND
      // give every such peer the same one — so the machine-grouping in
      // command-route would read unrelated machines as one and deliver
      // a halt or an approval decision to the wrong queue instead of
      // refusing. The client guards against sending empty; the relay
      // must not depend on that.
      const rawDeviceId = url.searchParams.get("device_id");
      const declaredDeviceId = rawDeviceId != null && rawDeviceId !== "" ? rawDeviceId : null;
      const deviceId = declaredDeviceId ?? crypto.randomUUID();
      // Backwards compat: accept token from query param during migration.
      // Preferred path: post-connect auth frame (token never in URL).
      const queryToken = url.searchParams.get("token");

      // Per-connection rate limit key — wsLimiter provides 100 msg/10s
      const wsRateKey = `ws:${motebitId}:${deviceId}`;

      // Track whether this connection has been authenticated (via query param or auth frame)
      let authenticated = false;
      // What the signed token that authenticated this socket proved: its
      // `did`, and the key of the device row that verified it. Null when
      // no signed token did (master token, device auth off). See
      // `ConnectedDevice.deviceIdVerified` / `boundUnder`.
      let verifiedDid: string | null = null;
      let verifiedDeviceKey: string | null = null;
      // The key the token verified under, whatever its source (device row or
      // agent-registry fallback). See `ConnectedDevice.authenticatedUnder`.
      let verifiedKey: string | null = null;
      // The verified token's `jti`, when it carried one. See
      // `ConnectedDevice.authenticatedJti`.
      let verifiedJti: string | null = null;
      // Track whether we're still waiting for an auth frame (connection not yet finalized)
      let awaitingAuthFrame = false;
      // The one gate for every non-auth frame: set only by finalizeConnection,
      // i.e. after the token verified (or when no auth is configured). While a
      // query-param token is still being verified, `authenticated` and
      // `awaitingAuthFrame` are both false and onMessage keeps running — so no
      // flag describing *how* auth is proceeding may stand in for "registered".
      let registered = false;
      // This socket's entry in `connections`, once registered. A retirement
      // (`closeSocketsAuthenticatedUnder`) marks it and removes it.
      let registeredPeer: ConnectedDevice | null = null;

      /**
       * Validate a bearer token (shared by query-param and post-connect auth frame paths).
       * Returns true if valid, false if invalid (and closes the WS unless suppressClose).
       * When `sendAuthResult` is true, sends auth_result frame on failure instead of closing directly.
       */
      async function validateToken(
        token: string,
        mid: string,
        ws: WSContext,
        sendAuthResult = false,
      ): Promise<boolean> {
        if (enableDeviceAuth) {
          // Master token bypass
          if (apiToken != null && apiToken !== "" && token === apiToken) {
            logger.info("auth.master_token_ws", { motebitId: mid });
            deps.recordAuthEvent?.({ kind: "master_token_ws", path: `/ws/sync/${mid}` });
            return true;
          }
          if (!token.includes(".")) {
            // Legacy device tokens (plain UUIDs) are no longer accepted
            if (sendAuthResult) {
              ws.send(
                JSON.stringify({
                  type: "auth_result",
                  ok: false,
                  error: "Legacy device tokens are no longer accepted",
                }),
              );
            }
            deps.recordAuthEvent?.({
              kind: "device_token_rejected",
              path: `/ws/sync/${mid}`,
              motebitId: mid,
              audience: "sync",
              reason: "legacy_token",
            });
            ws.close(4003, "Legacy device tokens are no longer accepted");
            return false;
          }
          // Signed token verification. The key that verified it is captured
          // HERE, from the row the verifier read — never looked up again.
          let keyFromDeviceRow: string | null = null;
          let keyVerified: string | null = null;
          const verified = await verifySignedTokenForDevice(
            token,
            mid,
            identityManager,
            "sync",
            isTokenBlacklisted,
            isAgentRevoked,
            undefined,
            // Relay rule 6: every refused signed token is recorded — this door
            // was the one that recorded nothing, so a forged sync socket left no
            // durable trace.
            (reason: string) => {
              logger.warn("auth.ws_token_rejected", { motebitId: mid, reason });
              deps.recordAuthEvent?.({
                kind: "device_token_rejected",
                path: `/ws/sync/${mid}`,
                motebitId: mid,
                audience: "sync",
                reason,
              });
            },
            (key, source) => {
              keyFromDeviceRow = source === "device" ? key : null;
              keyVerified = key;
            },
          );
          if (!verified) {
            if (sendAuthResult) {
              ws.send(JSON.stringify({ type: "auth_result", ok: false, error: "Unauthorized" }));
            }
            ws.close(4003, "Unauthorized");
            return false;
          }
          // Read only AFTER verification succeeded, so "unsafe" is safe
          // here: the signature over these claims has just been checked.
          const claims = deps.parseTokenPayloadUnsafe(token);
          verifiedDid = claims?.did ?? null;
          verifiedJti = typeof claims?.jti === "string" && claims.jti !== "" ? claims.jti : null;
          verifiedDeviceKey = keyFromDeviceRow;
          verifiedKey = keyVerified;
          return true;
        }
        // No device auth — check apiToken (shared secret)
        if (apiToken != null && apiToken !== "" && token !== apiToken) {
          if (sendAuthResult) {
            ws.send(JSON.stringify({ type: "auth_result", ok: false, error: "Unauthorized" }));
          }
          ws.close(4001, "Unauthorized");
          return false;
        }
        return true;
      }

      /**
       * Did the credential this socket's token verified under END while it
       * was being verified? Verification awaits (the device-row read, then the
       * signature), and a door applied inside that await closes only sockets
       * already registered — this one is not yet. Checked synchronously right
       * before registration, so nothing can land between the check and the
       * push into `connections`; from then on the door's close pass sees it.
       * Three ends, the same three the close passes answer (#767, #776):
       *  - the identity was revoked (`isAgentRevoked` — the verifier read it
       *    BEFORE its await) — closed 4011;
       *  - the token's jti was blacklisted (`/revoke-tokens`) — closed 4012;
       *  - the key no longer resolves for the token's `did`
       *    (`keyThatVerifiesNow` — a rotation, a moved fallback, a rewritten
       *    device row) — closed 4010.
       * Only a socket a signed token admitted is checked; the master token and
       * the no-auth path consult none of these.
       */
      function credentialEndedDuringVerification(): {
        reason: string;
        code: number;
        message: string;
      } | null {
        if (verifiedKey == null || verifiedDid == null) return null;
        if (isAgentRevoked(motebitId)) {
          return {
            reason: "agent_revoked_during_verification",
            code: WS_CLOSE_IDENTITY_REVOKED,
            message: WS_CLOSE_IDENTITY_REVOKED_REASON,
          };
        }
        if (verifiedJti != null && isTokenBlacklisted(verifiedJti, motebitId)) {
          return {
            reason: "jti_blacklisted_during_verification",
            code: WS_CLOSE_TOKEN_REVOKED,
            message: WS_CLOSE_TOKEN_REVOKED_REASON,
          };
        }
        const current = deps.keyThatVerifiesNow(motebitId, verifiedDid);
        if (current == null || current.toLowerCase() !== verifiedKey) {
          return {
            reason: "key_retired_during_verification",
            code: WS_CLOSE_KEY_RETIRED,
            message: WS_CLOSE_KEY_RETIRED_REASON,
          };
        }
        return null;
      }

      /**
       * Refuse a socket whose credential ended during its verification: log
       * it, RECORD it (relay rule 6 — every refused token is recorded), tell
       * an auth-frame client why, and close it with the end's code.
       */
      function refuseEndedDuringVerification(
        ws: WSContext,
        ended: { reason: string; code: number; message: string },
        sendAuthResult: boolean,
      ): void {
        logger.info(`ws.${ended.reason}`, { motebitId, deviceId });
        deps.recordAuthEvent?.({
          kind: "device_token_rejected",
          path: `/ws/sync/${motebitId}`,
          motebitId,
          audience: "sync",
          reason: ended.reason,
        });
        if (sendAuthResult) {
          ws.send(JSON.stringify({ type: "auth_result", ok: false, error: ended.message }));
        }
        ws.close(ended.code, ended.message);
      }

      /** Tell the observer a peer is bound (or re-announced); never let it take the socket down. */
      function notifyBound(peer: ConnectedDevice): void {
        try {
          deps.onPeerBound?.(motebitId, peer);
        } catch (err: unknown) {
          logger.warn("ws.on_peer_bound_failed", {
            motebitId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      /** Finalize a connection: register in connections map, recover pending tasks. */
      function finalizeConnection(ws: WSContext): void {
        // Idempotent: a query-param token and an auth frame can both finish
        // verifying for one socket; it is registered once.
        if (registered) return;
        // Only an OPEN socket is ever registered. Token verification is
        // awaited (the query-token path in onOpen, the auth-frame path in
        // onMessage), and a client can close during that await: onClose
        // then runs first, finds no peer, and does nothing — so a socket
        // registered after it would be a CLOSED peer nobody ever removes.
        // It would be served as open, re-observed by every liveness flush,
        // and shield its row from the sweep until restart. (Main had the
        // same zombie in `connections`; the roster made it visible.)
        if (ws.readyState !== WS_OPEN) {
          logger.info("ws.closed_before_finalize", { motebitId, deviceId });
          return;
        }
        registered = true;
        // Parse device capabilities from URL query param
        const capsParam = url.searchParams.get("capabilities");
        const capabilities =
          capsParam != null && capsParam !== ""
            ? capsParam.split(",").filter((cap) => cap !== "")
            : undefined;

        if (!connections.has(motebitId)) {
          connections.set(motebitId, []);
        }
        const deviceIdVerified = declaredDeviceId != null && verifiedDid === declaredDeviceId;
        const peer: ConnectedDevice = {
          ws,
          deviceId,
          deviceIdDeclared: declaredDeviceId != null,
          deviceIdVerified,
          ...(deviceIdVerified && verifiedDeviceKey != null
            ? { boundUnder: verifiedDeviceKey }
            : {}),
          ...(verifiedKey != null ? { authenticatedUnder: verifiedKey } : {}),
          ...(verifiedKey != null && verifiedDid != null ? { authenticatedDid: verifiedDid } : {}),
          ...(verifiedKey != null && verifiedJti != null ? { authenticatedJti: verifiedJti } : {}),
          capabilities,
        };
        connections.get(motebitId)!.push(peer);
        registeredPeer = peer;
        notifyBound(peer);

        // Task recovery: re-dispatch any pending tasks for this agent to the
        // newly connected device. Covers reconnection after disconnect (e.g.
        // cellular→WiFi handoff) and federation-forwarded tasks that arrived
        // while no device was connected.
        for (const [, entry] of taskQueue) {
          if (
            entry.task.motebit_id === motebitId &&
            entry.task.status === AgentTaskStatus.Pending &&
            !entry.receipt
          ) {
            ws.send(JSON.stringify({ type: "task_request", task: entry.task }));
            logger.info("task.recovery_on_reconnect", {
              correlationId: entry.task.task_id,
              motebitId,
              deviceId,
            });
          }
        }
      }

      return {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hono ws adapter supports async handlers
        async onOpen(_event, ws) {
          // Reject new connections during graceful drain
          if (deps.isDraining?.()) {
            ws.close(1001, "Server is draining");
            return;
          }

          if (motebitId == null) {
            ws.close(4000, "Missing motebitId");
            return;
          }

          // Backwards compat: if token was provided via query param, validate it now
          if (queryToken != null && queryToken !== "") {
            const authResult = await validateToken(queryToken, motebitId, ws);
            if (!authResult) return; // ws already closed by validateToken
            const ended = credentialEndedDuringVerification();
            if (ended != null) {
              refuseEndedDuringVerification(ws, ended, false);
              return;
            }
            authenticated = true;
          } else if (enableDeviceAuth) {
            // Device auth required but no query token — wait for post-connect auth frame
            awaitingAuthFrame = true;
          } else if (apiToken != null && apiToken !== "") {
            // API token required but no token at all — wait for post-connect auth frame
            awaitingAuthFrame = true;
          }

          // If already authenticated (query param) or no auth required, finalize connection
          if (!awaitingAuthFrame) {
            finalizeConnection(ws);
          }
        },

        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hono ws adapter supports async handlers
        async onMessage(event, ws) {
          // A socket that is not OPEN (a close handshake is pending, and `ws`
          // still delivers its inbound frames) or whose admitting key was
          // retired is acted on for nothing, auth frames included (#767).
          if (ws.readyState !== WS_OPEN || registeredPeer?.retired === true) return;
          // Per-connection rate limiting (shared FixedWindowLimiter, keyed by connection)
          const { allowed } = wsLimiter.check(wsRateKey);
          if (!allowed) {
            ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded" }));
            return;
          }

          try {
            const raw = event.data;
            const msg = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer),
            ) as {
              type: string;
              token?: string;
              events?: EventLogEntry[];
              conversations?: SyncConversation[];
              messages?: SyncConversationMessage[];
              task_id?: string;
              capabilities?: string[];
            };

            // Post-connect auth frame: client sends { type: "auth", token: "..." }
            // as the first message. Validate and respond with auth_result.
            if (msg.type === "auth") {
              if (authenticated) {
                // Already authenticated (e.g. via query param) — ignore duplicate auth
                ws.send(JSON.stringify({ type: "auth_result", ok: true }));
                return;
              }
              const token = typeof msg.token === "string" ? msg.token : "";
              if (token === "") {
                ws.send(JSON.stringify({ type: "auth_result", ok: false, error: "Missing token" }));
                ws.close(4001, "Missing token");
                return;
              }
              const valid = await validateToken(token, motebitId, ws, true);
              if (!valid) {
                // validateToken already sent auth_result with ok:false and closed
                return;
              }
              const ended = credentialEndedDuringVerification();
              if (ended != null) {
                refuseEndedDuringVerification(ws, ended, true);
                return;
              }
              authenticated = true;
              awaitingAuthFrame = false;
              ws.send(JSON.stringify({ type: "auth_result", ok: true }));
              finalizeConnection(ws);
              return;
            }

            // Reject every non-auth message until the connection is registered —
            // including while a query-param token is still being verified.
            if (!registered) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Authentication required. Send auth frame first.",
                }),
              );
              return;
            }

            // Agent protocol: capabilities_announce
            if (msg.type === "capabilities_announce" && Array.isArray(msg.capabilities)) {
              const peers = connections.get(motebitId);
              if (peers) {
                const self = peers.find((p) => p.ws === ws);
                if (self) {
                  self.capabilities = msg.capabilities;
                  // A socket that announces hosting unattended work after
                  // it connected is bound as a host from here.
                  notifyBound(self);
                }
              }
            }

            // Agent protocol: command_response (forwarded runtime command result)
            if (
              msg.type === "command_response" &&
              typeof (msg as Record<string, unknown>).id === "string"
            ) {
              const cmdMsg = msg as unknown as { id: string; result: unknown };
              deps.onCommandResponse?.(cmdMsg.id, cmdMsg.result);
            }

            // Agent protocol: task_claim
            if (msg.type === "task_claim" && msg.task_id) {
              const taskId = msg.task_id;
              const entry = taskQueue.get(taskId);

              if (!entry || entry.task.motebit_id !== motebitId) {
                ws.send(
                  JSON.stringify({
                    type: "task_claim_rejected",
                    task_id: taskId,
                    reason: "Task not found",
                  }),
                );
              } else if (entry.task.status !== AgentTaskStatus.Pending) {
                // Already claimed — atomic check: status is read BEFORE any async work
                ws.send(
                  JSON.stringify({
                    type: "task_claim_rejected",
                    task_id: taskId,
                    reason: "already_claimed",
                  }),
                );
              } else {
                // Atomic claim: set status BEFORE any further checks or responses.
                // Safe in single-threaded JS; prevents bugs if relay ever runs with
                // worker threads or multi-instance.
                entry.task.status = AgentTaskStatus.Claimed;
                entry.task.claimed_by = deviceId;
                taskQueue.set(taskId, entry); // Persist claim to durable queue

                // Verify claiming device has required capabilities
                const requiredCaps = entry.task.required_capabilities ?? [];
                if (requiredCaps.length > 0) {
                  const claimingPeers = connections.get(motebitId);
                  const claimingDevice = claimingPeers?.find((p) => p.ws === ws);
                  if (claimingDevice?.capabilities) {
                    const hasAll = requiredCaps.every((c) =>
                      claimingDevice.capabilities!.includes(c),
                    );
                    if (!hasAll) {
                      // Roll back claim — device lacks capabilities
                      entry.task.status = AgentTaskStatus.Pending;
                      entry.task.claimed_by = undefined;
                      taskQueue.set(taskId, entry); // Persist rollback
                      ws.send(
                        JSON.stringify({
                          type: "task_claim_rejected",
                          task_id: taskId,
                          reason: "Device lacks required capabilities",
                        }),
                      );
                    } else {
                      ws.send(JSON.stringify({ type: "task_claimed", task_id: taskId }));
                    }
                  } else {
                    ws.send(JSON.stringify({ type: "task_claimed", task_id: taskId }));
                  }
                } else {
                  ws.send(JSON.stringify({ type: "task_claimed", task_id: taskId }));
                }
              }
            }

            if (msg.type === "push" && Array.isArray(msg.events)) {
              // Ingress redaction: memory content above the sync-safe ceiling
              // must never reach the event store OR other connected devices
              // unredacted (the previous fan-out below sent raw entries).
              const safeEvents = redactSensitiveEvents(msg.events);
              let wsAccepted = 0;
              for (const entry of safeEvents) {
                // Receipt idempotency: skip events with duplicate receipt signatures
                const receipt = entry.payload?.receipt as Record<string, unknown> | undefined;
                if (receipt && typeof receipt.signature === "string" && receipt.signature !== "") {
                  const existing = await eventStore.query({ motebit_id: entry.motebit_id });
                  const isDuplicate = existing.some((e) => {
                    const r = e.payload?.receipt as Record<string, unknown> | undefined;
                    return r && r.signature === receipt.signature;
                  });
                  if (isDuplicate) continue;
                }
                await eventStore.append(entry);
                wsAccepted++;
                // Deletion propagation — per-event best-effort on the WS
                // path (a dropped propagation here is recovered by the
                // HTTP DELETE route or any later duplicate push).
                try {
                  await propagateDeletionForEvent(
                    { eventStore, moteDb: deps.moteDb },
                    entry,
                    motebitId,
                  );
                } catch (err: unknown) {
                  deps.logger.warn("ws deletion propagation failed", {
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              // Acknowledge
              ws.send(JSON.stringify({ type: "ack", accepted: wsAccepted }));

              // Fan out to other connected clients for the same motebitId
              const peers = connections.get(motebitId);
              if (peers) {
                for (const entry of safeEvents) {
                  const payload = JSON.stringify({ type: "event", event: entry });
                  for (const peer of peers) {
                    if (peer.ws !== ws && peer.ws.readyState === 1) {
                      peer.ws.send(payload);
                    }
                  }
                }
              }
            }

            if (msg.type === "push_conversations" && Array.isArray(msg.conversations)) {
              for (const conv of msg.conversations) {
                upsertSyncConversation(db, conv);
              }
              ws.send(
                JSON.stringify({ type: "ack_conversations", accepted: msg.conversations.length }),
              );

              // Fan out conversation updates to peers
              const peers = connections.get(motebitId);
              if (peers) {
                for (const conv of msg.conversations) {
                  const payload = JSON.stringify({
                    type: "conversation",
                    conversation: floorSyncConversation(conv),
                  });
                  for (const peer of peers) {
                    if (peer.ws !== ws && peer.ws.readyState === 1) {
                      peer.ws.send(payload);
                    }
                  }
                }
              }
            }

            if (msg.type === "push_messages" && Array.isArray(msg.messages)) {
              for (const m of msg.messages) {
                upsertSyncMessage(db, m);
              }
              ws.send(JSON.stringify({ type: "ack_messages", accepted: msg.messages.length }));

              // Fan out new messages to peers
              const peers = connections.get(motebitId);
              if (peers) {
                for (const m of msg.messages) {
                  const payload = JSON.stringify({
                    type: "conversation_message",
                    message: floorSyncMessage(m),
                  });
                  for (const peer of peers) {
                    if (peer.ws !== ws && peer.ws.readyState === 1) {
                      peer.ws.send(payload);
                    }
                  }
                }
              }
            }
          } catch {
            // Ignore malformed messages
          }
        },

        onClose(_event, ws) {
          const peers = connections.get(motebitId);
          if (peers) {
            const idx = peers.findIndex((p) => p.ws === ws);
            const [gone] = idx !== -1 ? peers.splice(idx, 1) : [];
            if (peers.length === 0) connections.delete(motebitId);
            if (gone != null) {
              // Never let an observer take the close path down with it.
              try {
                deps.onPeerClosed?.(motebitId, gone);
              } catch (err: unknown) {
                logger.warn("ws.on_peer_closed_failed", {
                  motebitId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        },
      };
    }),
  );
}
