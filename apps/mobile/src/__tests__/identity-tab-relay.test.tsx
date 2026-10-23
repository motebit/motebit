/**
 * The Settings → Identity "Connect to relay" row, by EXECUTION. Mounts the
 * REAL IdentityTab (react-test-renderer over host-string react-native
 * stubs) wired the way SettingsModal wires it — through `connectRelay` /
 * `disconnectRelay` against a port standing in for MobileApp — and drives
 * the switch:
 *
 *   - OFF by default, URL prefilled, and nothing reaches the network or
 *     the sync port while it stays off;
 *   - ON → setSyncUrl + startSync with the normalized URL, no message;
 *   - OFF again → sync stopped and the URL cleared;
 *   - an invalid URL shows an error and starts nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("react-native", () => {
  const host = (name: string) => name;
  return {
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    TouchableOpacity: host("TouchableOpacity"),
    Switch: host("Switch"),
    Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
    Alert: { alert: vi.fn() },
    Clipboard: { setString: vi.fn() },
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, flatten: (s: unknown) => s },
    Appearance: { getColorScheme: () => "light" },
  };
});

// settings-shared reads the approval presets; the real module boots Expo.
vi.mock("../mobile-app", () => ({
  APPROVAL_PRESET_CONFIGS: { balanced: { maxRiskAuto: 1, requireApprovalAbove: 1, denyAbove: 3 } },
}));

import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { IdentityTab } from "../components/settings/IdentityTab";
import { connectRelay, disconnectRelay, type RelayOptInPort } from "../relay-optin";

function fakePort(): RelayOptInPort & { saved: { url: string | null } } {
  const saved = { url: null as string | null };
  const port = {
    saved,
    syncStatus: "offline" as RelayOptInPort["syncStatus"],
    getSyncUrl: vi.fn(async () => saved.url),
    setSyncUrl: vi.fn(async (url: string) => {
      saved.url = url;
    }),
    startSync: vi.fn(async () => {
      port.syncStatus = "idle";
    }),
    disconnectSync: vi.fn(async () => {
      saved.url = null;
      port.syncStatus = "offline";
    }),
  };
  return port;
}

/** IdentityTab with SettingsModal's relay wiring; re-renders on URL change. */
function Harness({ port }: { port: RelayOptInPort }): React.ReactElement {
  const [relayUrl, setRelayUrl] = React.useState<string | null>(null);
  return React.createElement(IdentityTab, {
    motebitId: "mb",
    deviceId: "dev",
    publicKey: "",
    onExport: () => {},
    relayUrl,
    onConnectRelay: async (input: string) => {
      const result = await connectRelay(port, input);
      if (!result.ok) return result.error;
      setRelayUrl(result.url);
      return null;
    },
    onDisconnectRelay: async () => {
      await disconnectRelay(port);
      setRelayUrl(null);
    },
  });
}

function mount(port: RelayOptInPort): TestRenderer.ReactTestRenderer {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(React.createElement(Harness, { port }));
  });
  return r;
}

const byTestId = (r: TestRenderer.ReactTestRenderer, id: string): ReactTestInstance =>
  r.root.find((n) => n.props.testID === id && typeof n.type === "string");
const queryTestId = (r: TestRenderer.ReactTestRenderer, id: string): ReactTestInstance[] =>
  r.root.findAll((n) => n.props.testID === id && typeof n.type === "string");

async function toggle(r: TestRenderer.ReactTestRenderer, on: boolean): Promise<void> {
  await act(async () => {
    (byTestId(r, "relay-toggle").props.onValueChange as (v: boolean) => void)(on);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IdentityTab relay opt-in", () => {
  it("is OFF by default with the public relay prefilled, and contacts nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const port = fakePort();
    const r = mount(port);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(byTestId(r, "relay-toggle").props.value).toBe(false);
    expect(byTestId(r, "relay-url").props.value).toBe("https://relay.motebit.com");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(port.setSyncUrl).not.toHaveBeenCalled();
    expect(port.startSync).not.toHaveBeenCalled();
  });

  it("ON connects with the normalized URL; OFF stops sync and clears it", async () => {
    const port = fakePort();
    const r = mount(port);
    act(() => {
      (byTestId(r, "relay-url").props.onChangeText as (v: string) => void)(" relay.example.com/ ");
    });

    await toggle(r, true);
    expect(port.setSyncUrl).toHaveBeenCalledWith("https://relay.example.com");
    expect(port.startSync).toHaveBeenCalledWith("https://relay.example.com");
    expect(byTestId(r, "relay-toggle").props.value).toBe(true);
    expect(byTestId(r, "relay-url").props.editable).toBe(false);
    expect(queryTestId(r, "relay-error")).toHaveLength(0);

    await toggle(r, false);
    expect(port.disconnectSync).toHaveBeenCalledTimes(1);
    expect(port.saved.url).toBeNull();
    expect(byTestId(r, "relay-toggle").props.value).toBe(false);
    expect(queryTestId(r, "relay-error")).toHaveLength(0);
  });

  it("the copy states what ON and OFF actually do", () => {
    const r = mount(fakePort());
    const text = r.root
      .findAll((n) => (n.type as unknown) === "Text")
      .map((n) => {
        const c = n.props.children as unknown;
        return Array.isArray(c) ? c.join("") : typeof c === "string" ? c : "";
      })
      .join(" ")
      .replace(/\s+/g, " ");
    expect(text).toContain("nothing is sent to a relay while it is off");
    expect(text).toContain("once the relay accepts this device");
    expect(text).toContain("Off again: push is unregistered and the relay is disconnected.");
  });

  it("an invalid URL shows an error and starts nothing", async () => {
    const port = fakePort();
    const r = mount(port);
    act(() => {
      (byTestId(r, "relay-url").props.onChangeText as (v: string) => void)("https://");
    });
    await toggle(r, true);
    expect(port.startSync).not.toHaveBeenCalled();
    expect(byTestId(r, "relay-toggle").props.value).toBe(false);
    expect(byTestId(r, "relay-error").props.children).toBe("Relay URL is not valid");
  });
});
