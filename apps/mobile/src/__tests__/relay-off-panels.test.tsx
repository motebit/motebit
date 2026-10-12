/**
 * Relay OFF ⇒ nothing contacts the relay (founder-approved 2026-10-11),
 * by EXECUTION over the REAL panels. The Capabilities panel's Browse tab
 * (`/api/v1/skills/discover`) and the Activity panel's retention block
 * (`/.well-known/motebit-transparency.json`, `-retention.json`) used to fall
 * back to a hardcoded public relay when no relay URL was saved — so merely
 * opening either panel on a fresh, relay-off phone reached the relay. With
 * no saved URL they now make NO request and show a calm empty state.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("react-native", () => {
  const host = (name: string) => name;
  return {
    Modal: host("Modal"),
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    TouchableOpacity: host("TouchableOpacity"),
    Switch: host("Switch"),
    FlatList: host("FlatList"),
    ScrollView: host("ScrollView"),
    ActivityIndicator: host("ActivityIndicator"),
    Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
    Alert: { alert: vi.fn() },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, flatten: (s: unknown) => s },
    Appearance: { getColorScheme: () => "light" },
  };
});

// settings-shared (via ToolsTab) reads the approval presets; the real module boots Expo.
vi.mock("../mobile-app", () => ({
  APPROVAL_PRESET_CONFIGS: { balanced: { maxRiskAuto: 1, requireApprovalAbove: 1, denyAbove: 3 } },
}));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { CapabilitiesPanel } from "../components/CapabilitiesPanel";
import { ActivityPanel } from "../components/ActivityPanel";
import type { MobileApp } from "../mobile-app";

const EMPTY_STATE = "Connect to a relay in Settings → Identity to see this";

/** A fresh, relay-off app: no saved sync URL. */
function freshApp(syncUrl: string | null = null): MobileApp {
  return {
    getSyncUrl: vi.fn(async () => syncUrl),
    getRuntime: () => null,
    getSkillRegistry: () => null,
    getSkillAuditSink: () => null,
    runSelfTestNow: vi.fn(),
  } as unknown as MobileApp;
}

function allText(r: TestRenderer.ReactTestRenderer): string {
  return r.root
    .findAll((n) => (n.type as unknown) === "Text")
    .map((n) => {
      const c = n.props.children as unknown;
      return Array.isArray(c) ? c.join("") : typeof c === "string" ? c : "";
    })
    .join("\n");
}

async function open(el: React.ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return r;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Relay OFF: panels contact nothing", () => {
  it("Capabilities panel (Browse section): opening it on a fresh state makes zero requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await open(
      React.createElement(CapabilitiesPanel, { visible: true, app: freshApp(), onClose: () => {} }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(allText(r)).toContain(EMPTY_STATE);
  });

  it("Activity panel: opening it on a fresh state makes zero requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await open(
      React.createElement(ActivityPanel, { visible: true, app: freshApp(), onClose: () => {} }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(allText(r)).toContain(EMPTY_STATE);
  });

  it("with a saved relay URL the panels fetch from THAT relay only", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 404 }));
    await open(
      React.createElement(ActivityPanel, {
        visible: true,
        app: freshApp("https://relay.example.com"),
        onClose: () => {},
      }),
    );
    await open(
      React.createElement(CapabilitiesPanel, {
        visible: true,
        app: freshApp("https://relay.example.com"),
        onClose: () => {},
      }),
    );
    expect(fetchSpy).toHaveBeenCalled();
    for (const [u] of fetchSpy.mock.calls) {
      expect((u as string).startsWith("https://relay.example.com/")).toBe(true);
    }
  });
});
