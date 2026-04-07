/**
 * Mobile push token manager — owns the Expo push token lifecycle:
 * registration with the relay, token-rotation listener, foreground-
 * refresh on AppState change, and deregister cleanup.
 *
 * Extracted from `mobile-app.ts` as Target 5 of the mobile extraction
 * plan. This is the wake-on-demand primitive — the relay uses the
 * registered push token to send silent pushes that boot the mobile
 * background task handler (defined at the bottom of mobile-app.ts as
 * a module-level TaskManager.defineTask).
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
import { AppState, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";

const PUSH_TOKEN_KEY = "@motebit/push_token";

export interface PushTokenManagerDeps {
  getDeviceId: () => string;
  createSyncToken: (aud: string) => Promise<string>;
  getSyncUrl: () => Promise<string | null>;
}

export class MobilePushTokenManager {
  private _pushTokenListener: Notifications.Subscription | null = null;
  private _appStateListener: ReturnType<typeof AppState.addEventListener> | null = null;

  constructor(private deps: PushTokenManagerDeps) {}

  /**
   * Register push token with the relay for wake-on-demand task execution.
   * Called during startSync() after WebSocket connects.
   */
  async registerPushToken(syncUrl: string): Promise<void> {
    try {
      const { status } = await Notifications.getPermissionsAsync();
      let finalStatus: string = status;
      if (finalStatus !== "granted") {
        const { status: asked } = await Notifications.requestPermissionsAsync();
        finalStatus = asked;
      }
      if (finalStatus !== "granted") return;

      const tokenData = await Notifications.getExpoPushTokenAsync();
      const pushToken = tokenData.data;
      if (!pushToken) return;

      // Skip if token hasn't changed
      const stored = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
      if (stored === pushToken) return;

      const authToken = await this.deps.createSyncToken("push:register");
      if (!authToken) return;

      const res = await fetch(`${syncUrl}/api/v1/agents/push-token`, {
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

      if (res.ok) {
        await AsyncStorage.setItem(PUSH_TOKEN_KEY, pushToken);
      }
    } catch {
      // Push registration is best-effort — sync still works without it
    }
  }

  /** Remove push token from relay (app logout / identity deregister). */
  async removePushToken(syncUrl: string): Promise<void> {
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
      });
      await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
    } catch {
      // Best-effort cleanup
    }
  }

  /** Start listening for push token rotation and app state changes. */
  startPushLifecycle(): void {
    // Token rotation: FCM/APNs may rotate tokens at any time
    this._pushTokenListener = Notifications.addPushTokenListener((_token) => {
      void (async () => {
        const syncUrl = await this.deps.getSyncUrl();
        if (syncUrl != null && syncUrl !== "") {
          await AsyncStorage.removeItem(PUSH_TOKEN_KEY); // Force re-register
          await this.registerPushToken(syncUrl);
        }
      })();
    });

    // AppState: refresh push token on foreground return
    this._appStateListener = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") {
        void (async () => {
          const syncUrl = await this.deps.getSyncUrl();
          if (syncUrl != null && syncUrl !== "") await this.registerPushToken(syncUrl);
        })();
      }
    });
  }

  /** Clean up push lifecycle listeners. */
  stopPushLifecycle(): void {
    this._pushTokenListener?.remove();
    this._pushTokenListener = null;
    this._appStateListener?.remove();
    this._appStateListener = null;
  }
}
