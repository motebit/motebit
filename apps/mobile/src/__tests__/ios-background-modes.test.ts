/**
 * Device log, 2026-10-11 Release build: "You've implemented
 * -[<UIApplicationDelegate> application:didReceiveRemoteNotification:
 * fetchCompletionHandler:], but you still need to add
 * \"remote-notification\" to the list of your supported UIBackgroundModes".
 * Without it iOS never delivers the silent push that wakes a serving phone.
 * The mode is declared in app.json so `expo prebuild --clean` regenerates it;
 * config plugins (expo-audio's "audio") append to the same array.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appJson = JSON.parse(
  readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "app.json"), "utf8"),
) as { expo: { ios: { infoPlist: { UIBackgroundModes?: string[] } } } };

describe("iOS Info.plist background modes", () => {
  it("declares remote-notification", () => {
    expect(appJson.expo.ios.infoPlist.UIBackgroundModes).toContain("remote-notification");
  });
});
