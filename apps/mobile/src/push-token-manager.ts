/**
 * Mobile push token manager — owns the Expo push token lifecycle:
 * registration with the relay, token-rotation listener, foreground-
 * refresh on AppState change, and deregister cleanup.
 *
 * This is the wake-on-demand primitive — the relay uses the registered
 * push token to send silent pushes that boot the mobile background
 * task handler (defined at the bottom of mobile-app.ts as a
 * module-level TaskManager.defineTask).
 *
 * ### State ownership
 *
 *   - `_pushTokenListener`  — Notifications.Subscription for token rotation
 *   - `_appStateListener`   — AppState listener for foreground refresh
 *
 * ### Dep getters
 *
 *   - `getDeviceId` — written into every push-token payload
 *   - `createSyncToken` — short-lived auth token for the relay call
 *   - `getSyncUrl` — used by both listeners to know which relay to call
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TokenAudience } from "@motebit/sdk";
import { AppState, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";
import type { RelayChannel } from "./relay-session";

const PUSH_TOKEN_KEY = "@motebit/push_token";
/** The push-token DELETE is abandoned after this (a black-holed relay). */
const PUSH_TOKEN_REMOVE_TIMEOUT_MS = 5_000;

export interface PushTokenManagerDeps {
  getDeviceId: () => string;
  createSyncToken: (aud: TokenAudience) => Promise<string>;
  getSyncUrl: () => Promise<string | null>;
}

/** No session scoping (a direct call outside the sync controller). */
const UNSCOPED: RelayChannel = { live: true, fetch: (input, init) => fetch(input, init) };

export class MobilePushTokenManager {
  private _pushTokenListener: Notifications.Subscription | null = null;
  private _appStateListener: ReturnType<typeof AppState.addEventListener> | null = null;
  /** Bumped by stopPushLifecycle: a listener-started registration then posts nothing. */
  private _lifecycle = 0;

  constructor(private deps: PushTokenManagerDeps) {}

  /**
   * Register push token with the relay for wake-on-demand task execution.
   * Called once the relay accepted the device, under that relay session
   * (`RelaySession`): the token is posted ONLY through the session's fetch,
   * which refuses once the session is disposed (relay OFF or a restart) — a
   * registration resuming after OFF (the permission prompt, the Expo token
   * fetch) cannot reach the relay, and stores nothing.
   */
  async registerPushToken(syncUrl: string, session: RelayChannel = UNSCOPED): Promise<void> {
    const isCurrent = (): boolean => session.live;
    try {
      const { status } = await Notifications.getPermissionsAsync();
      if (!isCurrent()) return;
      let finalStatus: string = status;
      if (finalStatus !== "granted") {
        const { status: asked } = await Notifications.requestPermissionsAsync();
        finalStatus = asked;
      }
      if (finalStatus !== "granted" || !isCurrent()) return;

      const tokenData = await Notifications.getExpoPushTokenAsync();
      const pushToken = tokenData.data;
      if (!pushToken || !isCurrent()) return;

      // Skip if token hasn't changed
      const stored = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
      if (stored === pushToken || !isCurrent()) return;

      const authToken = await this.deps.createSyncToken("push:register");
      if (!authToken || !isCurrent()) return;

      const res = await session.fetch(`${syncUrl}/api/v1/agents/push-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          device_id: this.deps.getDeviceId(),
          push_token: pushToken,
          platform: "expo",
        }),
      });

      if (res.ok && isCurrent()) {
        await AsyncStorage.setItem(PUSH_TOKEN_KEY, pushToken);
      }
    } catch {
      // Push registration is best-effort — sync still works without it
    }
  }

  /**
   * Remove push token from relay (Relay OFF, app logout / identity
   * deregister). Bounded by an abort signal and fail-soft; the local token
   * is forgotten either way, so a later re-enable registers it again.
   */
  async removePushToken(syncUrl: string): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PUSH_TOKEN_REMOVE_TIMEOUT_MS);
    try {
      const authToken = await this.deps.createSyncToken("push:register");
      if (!authToken) return;
      await fetch(`${syncUrl}/api/v1/agents/push-token`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ device_id: this.deps.getDeviceId() }),
        signal: abort.signal,
      });
    } catch (err: unknown) {
      // Best-effort cleanup — logged, never blocking.
      // eslint-disable-next-line no-console -- fail-soft: the log says why
      console.warn("[push] unregister failed:", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      try {
        await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
      } catch {
        // Storage failure: the next registration simply re-posts the token.
      }
    }
  }

  /**
   * Start listening for push token rotation and app state changes. Every
   * registration a listener starts runs under `session` and this lifecycle:
   * it posts nothing once either has ended.
   */
  startPushLifecycle(session: RelayChannel = UNSCOPED): void {
    // A restart replaces the listeners; it never stacks a second pair.
    this.stopPushLifecycle();
    const lifecycle = this._lifecycle;
    const thisLifecycle = (): boolean => lifecycle === this._lifecycle;
    const scoped: RelayChannel = {
      get live() {
        return thisLifecycle() && session.live;
      },
      fetch: session.fetch,
    };
    const isCurrent = (): boolean => scoped.live;
    // Token rotation: FCM/APNs may rotate tokens at any time
    this._pushTokenListener = Notifications.addPushTokenListener((_token) => {
      void (async () => {
        const syncUrl = await this.deps.getSyncUrl();
        if (syncUrl != null && syncUrl !== "" && isCurrent()) {
          await AsyncStorage.removeItem(PUSH_TOKEN_KEY); // Force re-register
          await this.registerPushToken(syncUrl, scoped);
        }
      })();
    });

    // AppState: refresh push token on foreground return
    this._appStateListener = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") {
        void (async () => {
          const syncUrl = await this.deps.getSyncUrl();
          if (syncUrl != null && syncUrl !== "" && isCurrent()) {
            await this.registerPushToken(syncUrl, scoped);
          }
        })();
      }
    });
  }

  /** Clean up push lifecycle listeners. */
  stopPushLifecycle(): void {
    this._lifecycle++;
    this._pushTokenListener?.remove();
    this._pushTokenListener = null;
    this._appStateListener?.remove();
    this._appStateListener = null;
  }
}
